import { nonce, allowedThread } from './util.mjs';

// Text is kept in memory only. Every choice belongs to the paired user's
// message, original thread and active-turn object, never the latest selection.
export class PendingMessages {
  constructor(bridge) { this.bridge=bridge; this.records=new Map(); }
  get size() { this.prune(); return this.records.size; }
  prune() {
    for(const [key,r] of this.records) if(r.expires<=this.bridge.now() && r.state!=='sending') {
      this.records.delete(key); this.clear(r);
    }
  }
  clear(r) {
    if(r.messageId) void Promise.resolve().then(()=>this.bridge.tg.clear(this.bridge.config.chatId,r.messageId)).catch(()=>{});
  }
  async status(r,text) {
    this.clear(r);
    if(r.messageId && this.bridge.tg.editMessageText) {
      try { await this.bridge.editMessageText(r.messageId,text); return; } catch {}
    }
    await this.bridge.say(text);
  }
  async offer(text,active) {
    this.prune();
    if(!text || text.length>30000) throw new Error('追加文字不能为空，且不能超过 30000 字符。');
    if(this.records.size>=20 || [...this.records.values()].reduce((sum,r)=>sum+r.text.length,0)+text.length>60000) throw new Error('待办已满，请先用 /pending 发送或取消已有消息。');
    const r={key:nonce(),text,active,threadId:active.threadId,generation:this.bridge.rpc.generation,state:'pending',ready:false,expires:this.bridge.now()+30*60000,messageId:null};
    this.records.set(r.key,r);
    try { await this.render(r); }
    catch(error) {this.records.delete(r.key);throw error;}
  }
  async render(r) {
    const preview=r.text.length>700?r.text.slice(0,700)+'…（预览截断，发送时保留全文）':r.text;
    const rows=r.state==='uncertain'?[[{text:'移除待办',callback_data:`p:${r.key}:cancel`}]]:[
      [{text:'立即引导',callback_data:`p:${r.key}:steer`},{text:r.state==='queued'?'已排队 · 取消排队':'下一轮发送',callback_data:`p:${r.key}:${r.state==='queued'?'hold':'next'}`}],
      [{text:'取消',callback_data:`p:${r.key}:cancel`}]
    ];
    const label=r.state==='queued'?'已排队：当前任务正常完成后自动发送。':r.state==='uncertain'?'送达状态不确定，请先核对历史；不会自动重发。':'已存为待办，尚未发送。';
    this.clear(r);
    const message=await this.bridge.say(`${label}\n\n${preview}\n\n会话：${r.threadId}\n“立即引导”会纠正当前任务；“下一轮发送”会等待当前任务完成。待办保留 30 分钟，重启后清空。/pending 查看待办。`,rows);
    r.messageId=message.message_id;
  }
  async list() {
    this.prune();
    if(!this.records.size) return this.bridge.say('当前没有待办。任务运行中直接发送文字，会出现“立即引导 / 下一轮发送”按钮。');
    for(const r of this.records.values()) if(r.state!=='sending') await this.render(r);
  }
  async decide(q,data) {
    this.prune();
    const match=data.match(/^p:([A-Za-z0-9_-]{16}):(steer|next|hold|cancel)$/),r=this.records.get(match?.[1]);
    if(!r || r.messageId!==q.message.message_id) return this.bridge.say('这条待办按钮已失效，请用 /pending 查看。');
    const action=match[2],b=this.bridge;
    if(r.state==='sending') return b.say('这条消息正在提交，请稍候。');
    if(action==='cancel') {this.records.delete(r.key);return this.status(r,'已取消待办，未发送新的指令。');}
    if(r.state==='uncertain') return b.say('送达状态不确定，请先 /history 核对，避免重复执行。');
    if(action==='hold') {r.state='pending';r.ready=false;return this.render(r);}
    if(b.broken) return b.say('Codex 连接已断开，无法提交；请在 Mac 重启 Bridge。');
    if(b.selected?.id!==r.threadId || b.previewed && (b.previewed.readOnly || b.previewed.id!==r.threadId)) return b.say('待办属于另一个会话，请先重新选择原会话，再用 /pending 操作。');
    allowedThread(b.config,b.selected);
    if(action==='next') {
      if(b.active && (b.active!==r.active || b.active.stopping)) return b.say('原任务已变化或正在中止，未排队；请等待结束后再点“下一轮发送”。');
      r.state='queued';r.ready=!b.active;
      await this.render(r);
      if(r.ready) await this.drain();
      return;
    }
    if(b.active!==r.active || !b.active?.turnId || b.active.stopping || b.finished.has(b.active.turnId) || b.rpc.generation!==r.generation) {
      return b.say('原任务已结束、变化或尚未准备好，不能立即引导。消息仍在待办中，可点“下一轮发送”。');
    }
    const expectedTurnId=b.active.turnId;
    r.state='sending';r.ready=false;
    let result;
    try {result=await b.rpc.call('turn/steer',{threadId:r.threadId,expectedTurnId,input:[{type:'text',text:r.text}]});}
    catch(error) {
      if(Number.isInteger(error?.code)) {
        r.state='pending';
        await this.render(r);
        return b.say('Codex 未接受这次引导（可能任务刚结束或当前版本不支持）。文字已保留，请用“下一轮发送”；未自动重试。');
      }
      r.state='uncertain';
      return this.status(r,'引导送达状态不确定；请先 /history 核对。不会自动重发，避免重复执行。');
    }
    if(result?.turnId!==expectedTurnId) {
      r.state='uncertain';return this.status(r,'引导返回的任务 ID 不一致，无法确认送达；请在 Mac 核对，未重试。');
    }
    this.records.delete(r.key);
    return this.status(r,'已引导当前任务，Codex 已接收你的补充指令。已完成的操作不会自动撤销。');
  }
  completed(active,turn) {
    if(!active) return;
    let paused=0;
    for(const r of this.records.values()) if(r.active===active && r.state==='queued') {
      r.ready=turn.status==='completed' && !active.stopping;
      if(!r.ready) {r.state='pending';paused++;this.clear(r);}
    }
    return paused;
  }
  async drain() {
    const b=this.bridge;
    this.prune();
    if(b.broken || b.releasePromise) return;
    const ready=[...this.records.values()].filter(r=>r.state==='queued' && r.ready);
    if(!ready.length) return;
    if(b.active) {
      for(const r of ready) {r.state='pending';r.ready=false;this.clear(r);}
      return b.say('已有新任务启动，旧排队消息已暂停。/pending 查看并决定是否发送。');
    }
    const threadId=ready[0].threadId;
    const batch=ready.filter(r=>r.threadId===threadId);
    const pause=async text=>{
      for(const r of batch) {r.state='pending';r.ready=false;this.clear(r);}
      await b.say(`${text}\n待办已保留，请用 /pending 重新选择。`);
    };
    if(b.selected?.id!==threadId || b.previewed && (b.previewed.readOnly || b.previewed.id!==threadId)) return pause('会话选择已变化，排队消息没有发送。');
    try {
      const meta=await b.metadata(threadId);
      if(meta.status?.type==='active') return pause('桌面任务占用中，排队消息没有发送。');
      // Callback actions are serialized by Bridge; notifications may still
      // change the active state while the read-only metadata request runs.
      if(b.active || b.broken || b.selected?.id!==threadId) return pause('任务状态已变化，排队消息没有发送。');
      allowedThread(b.config,b.selected);
    } catch {return pause('无法核对原会话，排队消息没有发送。');}
    if(batch.some(r=>r.expires<=b.now() || !this.records.has(r.key))) {
      this.prune();return pause('排队消息在核对期间过期或已失效，没有发送。');
    }
    // Combine explicit queued messages in arrival order into one next turn.
    const chosen=[];let size=0;
    for(const r of batch) {if(size+r.text.length+2>30000)break;chosen.push(r);size+=r.text.length+2;}
    if(!chosen.length) chosen.push(batch[0]);
    const text=chosen.map(r=>r.text).join('\n\n');
    for(const r of chosen) {r.state='sending';r.ready=false;this.clear(r);}
    try { await b.startTurn(text); }
    catch(error) {
      for(const r of chosen) {r.state=Number.isInteger(error?.code) && error.code<0?'pending':'uncertain';r.ready=false;}
      for(const r of batch.filter(r=>!chosen.includes(r))) {r.state='pending';r.ready=false;}
      await b.say('下一轮提交未能确认；请先 /status 或 /history 核对，再用 /pending 查看。没有自动重试。');
      return;
    }
    // Delivery failure after acceptance must never make an accepted prompt
    // eligible for submission again.
    for(const r of chosen) this.records.delete(r.key);
    try {
      for(const r of chosen) await this.status(r,'待办已作为下一轮任务提交。');
    } finally {
      for(const r of batch.filter(r=>!chosen.includes(r))) {
        if(b.active) {r.active=b.active;r.generation=b.rpc.generation;r.ready=false;}
      }
    }
  }
  dispose() {for(const r of this.records.values())this.clear(r);this.records.clear();}
}
