import { setTimeout as delay } from 'node:timers/promises';

const MAX_TIMER_MS=2_147_483_647;
const STARTUP_READS=new Set(['getMe','getWebhookInfo']);
const TERMINAL_CODES=new Set([401,403,404,409]);

export function abortError() {
  const error=new Error('Telegram 网络等待已取消。');
  error.name='AbortError'; error.networkCode='ABORTED';
  return error;
}

function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

export function isTerminalTelegramError(error) {
  return [error?.code,error?.httpStatus,error?.status].some(code=>TERMINAL_CODES.has(code));
}

export function isRetryableTelegramError(error) {
  if (error?.name==='AbortError' || error?.networkCode==='ABORTED' || isTerminalTelegramError(error)) return false;
  const codes=[error?.code,error?.httpStatus,error?.status].filter(code=>Number.isInteger(code) && code>=400);
  if (codes.some(code=>code<500 && code!==408 && code!==429)) return false;
  return codes.some(code=>code===408 || code===429 || code>=500 && code<=599) ||
    Boolean(error?.networkCode) || error?.category==='response';
}

export function retryDelayMs(error,failures,{random=Math.random}={}) {
  const ceiling=Math.min(30_000,1000*2**Math.min(5,Math.max(0,failures-1)));
  const sample=random();
  const jitter=Number.isFinite(sample)?Math.max(0,Math.min(1,sample)):0.5;
  const backoff=Math.ceil(ceiling*(0.5+jitter*0.5));
  // A server minimum is never capped or reduced by jitter. Infinity from an
  // enormous finite retry_after is an abortable indefinite wait, not a 1 ms timer.
  const minimum=Number.isFinite(error?.retryAfter) && error.retryAfter>0?Math.ceil(error.retryAfter*1000):0;
  return Math.max(backoff,minimum);
}

export async function abortableWait(ms,{signal,delayFn=(ms,{signal})=>delay(ms,undefined,{signal})}={}) {
  if (typeof ms!=='number' || Number.isNaN(ms) || ms<0) throw new Error('Invalid retry delay.');
  checkAbort(signal);
  let remaining=ms;
  while (remaining>0) {
    const chunk=Math.min(MAX_TIMER_MS,remaining);
    let onAbort;
    const cancelled=new Promise((_,reject)=>{
      onAbort=()=>reject(abortError());
      signal?.addEventListener('abort',onAbort,{once:true});
    });
    try {
      checkAbort(signal);
      await Promise.race([delayFn(chunk,{signal}),cancelled]);
      checkAbort(signal);
    } catch(error) {
      if (signal?.aborted) throw abortError();
      throw error;
    } finally { signal?.removeEventListener('abort',onAbort); }
    remaining-=chunk;
  }
}

export async function waitForPollRetry(error,failures,options={}) {
  checkAbort(options.signal);
  if (!isRetryableTelegramError(error)) throw error;
  await abortableWait(retryDelayMs(error,failures,options),options);
}

export async function retryStartupRead(telegram,method,{attempts=5,signal,delayFn,random,onRetry}={}) {
  if (!STARTUP_READS.has(method)) throw new Error('Only getMe/getWebhookInfo may use startup retries.');
  if (!Number.isInteger(attempts) || attempts<1 || attempts>5) throw new Error('Startup attempts must be between 1 and 5.');
  for (let attempt=1;attempt<=attempts;attempt++) {
    checkAbort(signal);
    try {
      const result=await telegram.call(method);
      checkAbort(signal);
      return result;
    } catch(error) {
      checkAbort(signal);
      if (attempt===attempts || !isRetryableTelegramError(error)) throw error;
      onRetry?.(error,{attempt,attempts});
      await waitForPollRetry(error,attempt,{signal,delayFn,random});
    }
  }
}
