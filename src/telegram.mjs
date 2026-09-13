import { chunks } from './util.mjs';
import { markdownMessages } from './format.mjs';

const NETWORK_CODES=new Set([
  'ECONNRESET','ECONNREFUSED','ECONNABORTED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN',
  'ENETUNREACH','EHOSTUNREACH','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','UND_ERR_RESPONSE_CONTENT_LENGTH_MISMATCH',
  'CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
]);
const DELIVERY_METHODS=new Set(['sendMessage','sendDocument','sendPhoto','editMessageText','deleteMessage','editMessageReplyMarkup','answerCallbackQuery']);
const increment=value=>Math.min(Number.MAX_SAFE_INTEGER,value+1);
const healthState=()=>({successes:0,failures:0,consecutiveFailures:0,lastSuccessAt:null,lastFailureAt:null,lastCode:null});

class TelegramError extends Error {}

function failure(category,code,httpStatus) {
  const messages={network:'网络请求失败',response:'返回格式错误',api:'请求失败',validation:'文件参数无效',cancelled:'请求已取消'};
  const error=new TelegramError(`Telegram ${messages[category]}${code===undefined?'':`（${code}）`}。`);
  error.category=category;
  if (category==='network' || category==='cancelled') error.networkCode=code;
  else if (code!==undefined) error.code=code;
  if (category==='cancelled') error.name='AbortError';
  if (Number.isInteger(httpStatus) && httpStatus>=100 && httpStatus<=599) {
    error.httpStatus=httpStatus; error.status=httpStatus;
    if (httpStatus>=400 && error.code===undefined) error.code=httpStatus;
  }
  return error;
}

function networkCode(error) {
  // Undici may nest AggregateErrors inside causes. Walk only a bounded graph;
  // retain no messages, stacks, URLs, unknown codes, or original error objects.
  const pending=[error],seen=new Set();
  for (let i=0;i<pending.length && i<32;i++) {
    const item=pending[i];
    if (!item || typeof item!=='object' || seen.has(item)) continue;
    seen.add(item);
    if (NETWORK_CODES.has(item.code)) return item.code;
    if (item.name==='TimeoutError') return 'TIMEOUT';
    if (item.name==='AbortError') return 'ABORTED';
    if (item.cause && pending.length<32) pending.push(item.cause);
    if (Array.isArray(item.errors)) {
      for (const nested of item.errors.slice(0,32-pending.length)) pending.push(nested);
    }
  }
  return 'NETWORK_ERROR';
}

export class Telegram {
  #inflight=new Set();
  #closed=false;
  #health={polling:healthState(),delivery:healthState()};

  constructor(token,{fetchFn=globalThis.fetch,now=Date.now}={}) {
    this.token=token; this.fetchFn=fetchFn; this.now=now;
  }

  #record(method,error) {
    const state=method==='getUpdates'?this.#health.polling:DELIVERY_METHODS.has(method)?this.#health.delivery:null;
    if (!state) return;
    if (error) {
      state.failures=increment(state.failures); state.consecutiveFailures=increment(state.consecutiveFailures);
      state.lastFailureAt=this.now();
      state.lastCode=error.networkCode || error.code || 'INVALID_RESPONSE';
    } else {
      state.successes=increment(state.successes); state.consecutiveFailures=0; state.lastSuccessAt=this.now();
    }
  }

  statusText() {
    const describe=(label,state)=>`${label}：${state.consecutiveFailures?'异常':state.successes?'正常':'尚未成功'}；成功 ${state.successes} 次，失败 ${state.failures} 次，连续失败 ${state.consecutiveFailures} 次；最近错误 ${state.lastCode ?? '无'}。`;
    return `Telegram 网络状态（仅本次运行）\n${describe('轮询',this.#health.polling)}\n${describe('发送/回执',this.#health.delivery)}\n连接：${this.#closed?'已关闭':'运行中'}。不保存消息或文件内容；发送失败不自动重试，请先核对是否已送达。`;
  }

  close() {
    this.#closed=true;
    for (const controller of this.#inflight) controller.abort();
  }

  async #request(method,timeoutMs,request,read) {
    if (this.#closed) throw failure('cancelled','ABORTED');
    const controller=new AbortController();
    let timedOut=false,response;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
    this.#inflight.add(controller);
    try {
      const {url,...options}=request();
      response=await this.fetchFn(url,{...options,redirect:'error',signal:controller.signal});
      controller.signal.throwIfAborted();
      const result=await read(response,controller.signal);
      controller.signal.throwIfAborted();
      this.#record(method);
      return result;
    } catch(raw) {
      let error;
      if (controller.signal.aborted) error=failure(timedOut?'network':'cancelled',timedOut?'TIMEOUT':'ABORTED',response?.status);
      else if (raw instanceof TelegramError) error=raw;
      else if (raw instanceof SyntaxError && response) error=failure('response',undefined,response.status);
      else {
        const code=networkCode(raw);
        error=failure(code==='ABORTED'?'cancelled':'network',code,response?.status);
      }
      controller.abort();
      this.#record(method,error);
      throw error;
    } finally {
      clearTimeout(timer); this.#inflight.delete(controller);
    }
  }

  #api(method,options,timeoutMs) {
    return this.#request(method,timeoutMs,()=>({url:`https://api.telegram.org/bot${this.token}/${method}`,...options()}),async response=>{
      const payload=await response.json();
      if (!payload || typeof payload!=='object' || Array.isArray(payload) || typeof payload.ok!=='boolean') throw failure('response',undefined,response.status);
      if (!response.ok || !payload.ok) {
        const code=Number.isInteger(payload.error_code) && payload.error_code>=400 && payload.error_code<=599?payload.error_code:response.status;
        const error=failure('api',Number.isInteger(code)?code:undefined,response.status);
        if (Number.isFinite(payload.parameters?.retry_after) && payload.parameters.retry_after>=0) error.retryAfter=payload.parameters.retry_after;
        throw error;
      }
      if (!Object.hasOwn(payload,'result') || method==='getUpdates' && (!Array.isArray(payload.result) || payload.result.some(update=>!update || typeof update!=='object' || !Number.isSafeInteger(update.update_id) || update.update_id<0 || update.update_id>=Number.MAX_SAFE_INTEGER))) throw failure('response',undefined,response.status);
      return payload.result;
    });
  }

  async call(method,params={},timeoutMs=15000) {
    if (typeof method!=='string' || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(method) || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>2_147_483_647) throw failure('validation','INVALID_REQUEST');
    return this.#api(method,()=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(params)}),timeoutMs);
  }

  async download(fileId,{maxBytes=20_000_000}={}) {
    if (typeof fileId!=='string' || !fileId.trim() || fileId.length>1024 || /[\x00-\x20\x7f]/.test(fileId) || !Number.isSafeInteger(maxBytes) || maxBytes<1) throw failure('validation','INVALID_FILE');
    const file=await this.call('getFile',{file_id:fileId});
    const filePath=file?.file_path;
    if (typeof filePath!=='string' || filePath.length>2048 || filePath.includes('..') || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(filePath)) throw failure('validation','INVALID_FILE_PATH');
    if (file.file_size!==undefined) {
      if (!Number.isSafeInteger(file.file_size) || file.file_size<0) throw failure('validation','INVALID_FILE_SIZE');
      if (file.file_size>maxBytes) throw failure('validation','FILE_TOO_LARGE');
    }
    return this.#request('download',60_000,()=>({url:`https://api.telegram.org/file/bot${this.token}/${filePath}`,method:'GET'}),async(response,signal)=>{
      let reader;
      try {
        if (!response.ok) throw failure('api',response.status,response.status);
        const declared=response.headers.get('content-length');
        if (declared!==null) {
          if (!/^\d+$/.test(declared)) throw failure('response','INVALID_FILE_SIZE',response.status);
          const size=Number(declared);
          if (!Number.isSafeInteger(size) || size>maxBytes) throw failure('validation','FILE_TOO_LARGE',response.status);
        }
        if (!response.body) throw failure('response',undefined,response.status);
        reader=response.body.getReader();
        const parts=[]; let size=0;
        while (true) {
          signal.throwIfAborted();
          const {done,value}=await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array)) throw failure('response',undefined,response.status);
          if (value.byteLength>maxBytes-size) throw failure('validation','FILE_TOO_LARGE',response.status);
          size+=value.byteLength; parts.push(Buffer.from(value));
        }
        return Buffer.concat(parts,size);
      } catch(error) {
        // Do not wait for a remote stream's cancellation acknowledgement.
        if (reader) void reader.cancel().catch(()=>{});
        else if (response.body) void response.body.cancel().catch(()=>{});
        throw error;
      } finally { reader?.releaseLock(); }
    });
  }

  async sendDocument(chatId,{bytes,name,mime='application/octet-stream'}) {
    if (!Buffer.isBuffer(bytes) || bytes.length===0 || bytes.length>50_000_000) throw failure('validation','INVALID_DOCUMENT_SIZE');
    if (typeof name!=='string' || !name.trim() || name.length>255 || name==='.' || name==='..' || /[\/\\\x00-\x1f\x7f]/.test(name)) throw failure('validation','INVALID_DOCUMENT_NAME');
    if (typeof mime!=='string' || mime.length>200 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mime)) throw failure('validation','INVALID_DOCUMENT_MIME');
    return this.#api('sendDocument',()=>{
      const body=new FormData();
      body.set('chat_id',String(chatId));
      body.set('document',new Blob([bytes],{type:mime}),name);
      return {method:'POST',body};
    },90_000);
  }

  async sendPhoto(chatId,{bytes,caption,mime='image/jpeg'}) {
    if (!Buffer.isBuffer(bytes) || bytes.length===0 || bytes.length>10_000_000) throw failure('validation','INVALID_PHOTO_SIZE');
    if (caption!==undefined && (typeof caption!=='string' || caption.length>1024)) throw failure('validation','INVALID_CAPTION');
    if (typeof mime!=='string' || !mime.startsWith('image/')) throw failure('validation','INVALID_PHOTO_MIME');
    return this.#api('sendPhoto',()=>{
      const body=new FormData();
      body.set('chat_id',String(chatId));
      body.set('photo',new Blob([bytes],{type:mime}),'photo.jpg');
      if (caption) body.set('caption',caption);
      return {method:'POST',body};
    },90_000);
  }

  async editMessageText(chatId,messageId,text) {
    if (typeof text!=='string' || text.length>4096) throw failure('validation','INVALID_TEXT');
    return this.call('editMessageText',{chat_id:chatId,message_id:messageId,text,link_preview_options:{is_disabled:true}});
  }

  async deleteMessage(chatId,messageId) {
    return this.call('deleteMessage',{chat_id:chatId,message_id:messageId});
  }

  async say(chatId,text,keyboard) {
    const parts=chunks(text); let message;
    for (let i=0;i<parts.length;i++) {
      message=await this.call('sendMessage',{chat_id:chatId,text:parts[i],link_preview_options:{is_disabled:true}, ...(i===parts.length-1 && keyboard ? {reply_markup:{inline_keyboard:keyboard}} : {})});
    }
    return message;
  }
  async rich(chatId,text) {
    let message;
    for(const part of markdownMessages(text)) {
      const params={chat_id:chatId,...part,link_preview_options:{is_disabled:true}};
      try {message=await this.call('sendMessage',params);}
      catch(e) {
        // An explicit 400 is a rejected send, not an ambiguous network failure.
        // Older Bot API servers may reject copy_text; retry once without it.
        if(e.code!==400 || !part.reply_markup) throw e;
        const {reply_markup,...withoutCopy}=params;
        message=await this.call('sendMessage',withoutCopy);
      }
    }
    return message;
  }
  ack(id,text) { return this.call('answerCallbackQuery',{callback_query_id:id,...(text ? {text} : {})},4000); }
  async clear(chatId,messageId) {
    try { await this.call('editMessageReplyMarkup',{chat_id:chatId,message_id:messageId,reply_markup:{inline_keyboard:[]}}); } catch { /* Delivery health records failures; one-use records still enforce safety. */ }
  }
  // Keep the idle long-poll below common 20–30 s intermediary timeouts.
  // This improves tolerance but cannot repair a proxy or upstream outage.
  updates(offset) { return this.call('getUpdates',{offset,timeout:10,limit:50,allowed_updates:['message','callback_query']},25000); }
}
