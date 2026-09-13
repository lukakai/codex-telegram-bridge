import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { VERSION } from './util.mjs';

const CONNECTION_CLOSED='Codex 连接已关闭。';

export class CodexRpc extends EventEmitter {
  constructor(config, {spawnFn=spawn, timeoutMs=90000, closeTimeoutMs=3000}={}) {
    super(); this.config=config; this.spawnFn=spawnFn; this.timeoutMs=timeoutMs; this.closeTimeoutMs=closeTimeoutMs;
    this.pending=new Map(); this.seq=0; this.child=null; this.closed=true; this.buffer=''; this.decoder=new StringDecoder('utf8');
    this.starting=null; this.closing=null; this.fault=null; this.permanentlyClosed=false; this.generation=0;
  }
  get isRunning() { return !this.closed && !this.fault && Boolean(this.child?.stdin?.writable); }
  async start() {
    if (this.permanentlyClosed) throw new Error('Codex RPC 已永久关闭。');
    if (this.fault) throw this.fault;
    if (this.closing) await this.closing;
    if (this.isRunning) return;
    if (this.starting) return this.starting;
    const task=this.launch(); this.starting=task;
    try { return await task; }
    finally { if (this.starting===task) this.starting=null; }
  }
  async launch() {
    this.closed=false; this.buffer=''; this.decoder=new StringDecoder('utf8');
    let child;
    try {
      child=this.spawnFn(this.config.codexPath,['app-server','--enable','network_proxy','--listen','stdio://'], {
        shell:false, cwd:this.config.codexHome, env:{...process.env, CODEX_HOME:this.config.codexHome}, stdio:['pipe','pipe','pipe']
      });
    } catch {
      const error=new Error('无法启动 Codex，请检查可执行文件路径。'); this.fail(error); throw error;
    }
    this.child=child;
    child.on('error', () => { if (this.child===child && !this.closed) this.fail(new Error('无法启动 Codex，请检查可执行文件路径。'),child); });
    child.on('exit', (code,signal) => {
      if (this.child!==child) return;
      if (this.closed) { this.child=null; return; }
      this.fail(new Error(`Codex 连接已结束（${code ?? signal}）；不会自动重试任务。`),child);
    });
    child.stdin.on('error', () => { if (this.child===child && !this.closed) this.fail(new Error('Codex 输入连接中断。'),child); });
    child.stdout.on('data', data => { if (this.child===child && !this.closed) this.consume(this.decoder.write(data),child); });
    // Drain stderr without forwarding it: it may contain local paths, credentials or prompts.
    child.stderr.on('data', () => {});
    try {
      const result=await this.rawCall('initialize', {clientInfo:{name:'codex_telegram_bridge', title:'Local Telegram Bridge', version:VERSION}, capabilities:{experimentalApi:true, requestAttestation:false, mcpServerOpenaiFormElicitation:true}});
      if (this.child!==child || this.closed) throw new Error(CONNECTION_CLOSED);
      this.send({method:'initialized'}); this.generation++;
      return result;
    } catch(error) {
      if (!this.fault && this.child===child && !this.closed) this.fail(error,child);
      throw error;
    }
  }
  consume(data,child=this.child) {
    if (this.child!==child || this.closed) return;
    this.buffer += data;
    let end;
    while ((end=this.buffer.indexOf('\n')) !== -1) {
      const line=this.buffer.slice(0,end); this.buffer=this.buffer.slice(end+1);
      if (!line.trim()) continue;
      if (line.length > 16*1024*1024) { this.fail(new Error('Codex 协议消息超过安全大小限制。'),child); return; }
      let msg; try { msg=JSON.parse(line); } catch { this.fail(new Error('Codex 返回了无效 JSON；请确认 app-server 版本。'),child); return; }
      if (!msg || typeof msg!=='object') { this.fail(new Error('Codex 协议结构无效。'),child); return; }
      if (typeof msg.method==='string') {
        this.emit(Object.hasOwn(msg,'id')?'request':'notification',msg);
      } else if (Object.hasOwn(msg,'id')) {
        const p=this.pending.get(msg.id); if (!p) continue;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) { const e=new Error(msg.error.message || 'Codex 请求失败。'); e.code=msg.error.code; p.reject(e); }
        else p.resolve(msg.result);
      }
    }
    if (this.buffer.length > 16*1024*1024) this.fail(new Error('Codex 协议消息超过安全大小限制。'),child);
  }
  send(msg) {
    if (!this.isRunning) throw new Error('Codex 连接不可用。');
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }
  rawCall(method,params={}) {
    if (!this.isRunning) return Promise.reject(new Error('Codex 连接不可用。'));
    const id=`tg-${++this.seq}`;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(() => this.fail(new Error(`Codex ${method} 超时；已断开连接，不自动重发，避免重复执行。`)),this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try { this.send({method,id,params}); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  call(method,params={}) {
    if (this.isRunning && !this.closing) return this.rawCall(method,params);
    return this.start().then(()=>this.rawCall(method,params));
  }
  respond(id,result) { this.send({id,result}); }
  reject(id,message='此类型暂不支持，已拒绝。') { this.send({id,error:{code:-32601,message}}); }
  fail(error,child=this.child) {
    if (this.fault || this.closed || child && this.child!==child) return;
    this.fault=error; this.closed=true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    if (this.child===child) this.child=null;
    child?.kill('SIGTERM'); this.emit('fatal',error);
  }
  close() {
    if (this.closing) return this.closing;
    const task=this.closeCurrent(); this.closing=task;
    task.finally(()=>{if(this.closing===task)this.closing=null;}).catch(()=>{});
    return task;
  }
  async closeCurrent() {
    if (this.starting) { try { await this.starting; } catch {} }
    const child=this.child; this.closed=true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(CONNECTION_CLOSED)); }
    this.pending.clear(); this.buffer=''; this.decoder=new StringDecoder('utf8');
    if (!child) return;
    await new Promise(resolve => {
      let done=false;
      const finish=()=>{if(done)return;done=true;clearTimeout(force);clearTimeout(giveUp);if(this.child===child)this.child=null;resolve();};
      child.once('exit',finish);
      const force=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},Math.max(100,this.closeTimeoutMs-250));
      const giveUp=setTimeout(finish,this.closeTimeoutMs);
      force.unref?.();
      try { if (!child.kill('SIGTERM')) finish(); } catch { finish(); }
    });
  }
  async shutdown() { this.permanentlyClosed=true; await this.close(); }
}
