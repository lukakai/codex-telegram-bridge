import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/bridge.mjs';
import { allowedThread, canonicalTarget, chunks, within, writePrivateJson, readJson, safeError, acquireLock, validateConfig, validateProject } from '../src/util.mjs';
import { Inbox } from '../src/inbox.mjs';
import { ThreadCatalog } from '../src/threads.mjs';
import { ModelSettings } from '../src/models.mjs';

const testDir=path.dirname(fileURLToPath(import.meta.url));
class MockRpc extends EventEmitter {
  calls=[]; replies=[]; closed=false;
  async call(method,params) { this.calls.push({method,params}); return this.handler?.(method,params) ?? {}; }
  respond(id,result) { this.replies.push({id,result}); }
  reject(id) { this.replies.push({id,error:true}); }
  fail(e) {this.closed=true; this.emit('fatal',e);}
}
class MockTg {
  messages=[]; clears=[]; acks=[];
  async say(chatId,text,keyboard) {const m={message_id:this.messages.length+1,chatId,text,keyboard}; this.messages.push(m); return m;}
  async ack(id,text) {this.acks.push({id,text});}
  async clear(chatId,id) {this.clears.push({chatId,id});}
}
function fixture(t,{desktopTakeover}={}) {
  const root=fs.mkdtempSync(path.join(testDir,'.fixture-'));
  const project=path.join(root,'project'),outside=path.join(root,'outside'); fs.mkdirSync(project);fs.mkdirSync(outside);
  const config={token:'123456:THIS_IS_A_DUMMY_TOKEN_NOT_REAL',userId:123,chatId:123,projects:[{id:'p1',name:'Project',cwd:fs.realpathSync(project)}],approvalTimeoutSeconds:600};
  const rpc=new MockRpc(), tg=new MockTg(), clock={time:1000000};
  const b=new Bridge(config,rpc,tg,{now:()=>clock.time,...(desktopTakeover?{desktopTakeover}:{})});
  const thread={id:'thread-1',cwd:config.projects[0].cwd,name:'Example',historyMode:'legacy',status:{type:'notLoaded'}};
  const msg=text=>({message:{from:{id:123},chat:{id:123,type:'private'},text}});
  const current=()=>{b.selected=thread;b.managed.set(thread.id,thread);b.active={threadId:thread.id,turnId:'turn-1'};};
  const request=(id=1,changes={})=>({id,method:'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:'turn-1',itemId:'item-1',command:'git status',cwd:thread.cwd,...changes}});
  const callback=(message,data,user=123)=>({id:'click-1',from:{id:user},message:{message_id:message.message_id,chat:{id:123,type:'private'}},data});
  // Retain tiny synthetic fixtures for inspection; do not recursively remove
  // directories from a test hook. They are ignored by Git and release packaging.
  t.after(()=>{b.dispose();});
  return {b,rpc,tg,config,thread,msg,current,request,callback,clock,root,project,outside};
}

test('unauthorized private user and groups cannot list or start anything',async t=>{
  const {b,rpc,tg}=fixture(t);
  await b.handle({message:{from:{id:999},chat:{id:999,type:'private'},text:'/new do work'}});
  await b.handle({message:{from:{id:123},chat:{id:123,type:'group'},text:'/threads'}});
  assert.equal(rpc.calls.length,0);assert.equal(tg.messages.length,0);
});
test('new task creates persistent thread and starts sandboxed user-reviewed turn',async t=>{
  const f=fixture(t); f.rpc.handler=(m)=>m==='thread/start'?{thread:f.thread}:m==='turn/start'?{turn:{id:'turn-1'}}:{};
  await f.b.handle(f.msg('/new inspect this project'));
  assert.deepEqual(f.rpc.calls.map(c=>c.method),['thread/start','turn/start']);
  assert.equal(f.rpc.calls[0].params.ephemeral,false);
  const p=f.rpc.calls[1].params; assert.equal(p.approvalPolicy,'untrusted');assert.equal(p.approvalsReviewer,'user');
  assert.equal(p.sandboxPolicy.type,'workspaceWrite');assert.equal(p.sandboxPolicy.networkAccess,false);
  assert.deepEqual(p.input,[{type:'text',text:'inspect this project'}]); assert.equal(f.b.active.turnId,'turn-1');
});
test('cannot start a second task while active',async t=>{
  const f=fixture(t);f.current(); await assert.rejects(f.b.startTurn('another'),/仍在运行/);assert.equal(f.rpc.calls.length,0);
});
test('ordinary messages continue selected thread',async t=>{
  const f=fixture(t); f.b.selected=f.thread;f.b.managed.set(f.thread.id,f.thread);f.rpc.handler=()=>({turn:{id:'turn-2'}});
  await f.b.handle(f.msg('continue with tests'));assert.equal(f.rpc.calls[0].params.threadId,f.thread.id);
});
test('thread list includes app-server source and preserves pagination filters',async t=>{
  const f=fixture(t);f.rpc.handler=(_m,p)=>p.cursor?{data:[{...f.thread,id:'thread-next'}],nextCursor:null}:{data:Array.from({length:8},(_,i)=>({...f.thread,id:`thread-${i}`})),nextCursor:'cursor-2'};
  await f.b.list('feature');assert.ok(f.rpc.calls[0].params.sourceKinds.includes('appServer'));
  const page=f.tg.messages.at(-1);const data=page.keyboard.find(row=>row[0].text==='下一页')[0].callback_data;
  await f.b.callback(f.callback(page,data));const params=f.rpc.calls.at(-1).params;
  assert.equal(params.cursor,'cursor-2');assert.equal(params.searchTerm,'feature');assert.equal(params.cwd,undefined);assert.equal(params.useStateDbOnly,true);
});
test('selection requires confirmation but does not resume until a task arrives',async t=>{
  const f=fixture(t);f.rpc.handler=(method)=>method==='turn/start'?{turn:{id:'turn-2'}}:{thread:f.thread};
  await f.b.handle(f.msg('/use thread-1'));assert.ok(f.rpc.calls.every(c=>c.method!=='thread/resume'));
  const m=f.tg.messages.at(-1);await f.b.callback(f.callback(m,m.keyboard[0][0].callback_data));
  assert.ok(f.rpc.calls.every(c=>c.method!=='thread/resume'));assert.equal(f.b.selected.id,'thread-1');assert.equal(f.b.active,null);
  f.rpc.generation=1;f.rpc.start=async()=>{};await f.b.startTurn('continue');assert.deepEqual(f.rpc.calls.slice(-2).map(c=>c.method),['thread/resume','turn/start']);
});
test('server-reported active thread cannot be offered for resume',async t=>{
  const f=fixture(t);f.rpc.handler=()=>({thread:{...f.thread,status:{type:'active'}}});
  await assert.rejects(f.b.offerResume('thread-1'),/桌面任务占用中/);assert.ok(f.rpc.calls.every(c=>c.method!=='thread/resume'));
});
test('selecting a desktop-occupied thread asks before release and then connects it',async t=>{
  let blocked=true,releases=0;
  const f=fixture(t,{desktopTakeover:{release:async()=>{releases++;blocked=false;return {released:true};}}});
  f.rpc.generation=1;f.rpc.isRunning=true;f.rpc.child={pid:999};f.rpc.start=async()=>{};
  f.rpc.handler=method=>{
    if(method==='thread/read')return {thread:{...f.thread,status:{type:blocked?'active':'notLoaded'}}};
    if(method==='thread/resume') {if(blocked)throw new Error('thread already has an active writer');return {thread:f.thread};}
    return {};
  };
  await f.b.handle(f.msg('/use thread-1'));
  const offer=f.tg.messages.at(-1);assert.ok(offer.text.includes('是否强制释放并由 TG 接管'));assert.equal(releases,0);assert.equal(f.b.selected,null);
  await f.b.callback(f.callback(offer,offer.keyboard[0][0].callback_data));
  assert.equal(releases,1);assert.equal(f.b.selected.id,f.thread.id);assert.equal(f.b.loadedThreadId,f.thread.id);assert.ok(f.b.takeoverReservation);
});
test('writer conflict offers explicit desktop takeover and never replays the failed task',async t=>{
  let blocked=true,releases=0;
  const f=fixture(t,{desktopTakeover:{release:async()=>{releases++;blocked=false;return {released:true};}}});
  f.b.selected=f.thread;f.b.managed.set(f.thread.id,f.thread);f.rpc.generation=1;f.rpc.isRunning=true;f.rpc.child={pid:999};f.rpc.start=async()=>{};
  f.rpc.handler=method=>{
    if(method==='thread/read')return {thread:f.thread};
    if(method==='thread/resume') {if(blocked)throw new Error('thread already has an active writer');return {thread:f.thread};}
    if(method==='turn/start')return {turn:{id:'turn-after-takeover'}};
    return {};
  };
  await f.b.handle(f.msg('original task'));
  const offer=f.tg.messages.at(-1);assert.ok(offer.text.includes('强制释放并由 TG 接管'));assert.ok(offer.text.includes('不会自动重发'));assert.equal(f.rpc.calls.filter(call=>call.method==='turn/start').length,0);
  await f.b.callback(f.callback(offer,offer.keyboard[0][0].callback_data));
  assert.equal(releases,1);assert.equal(f.b.loadedThreadId,f.thread.id);assert.ok(f.b.takeoverReservation);assert.equal(f.rpc.calls.filter(call=>call.method==='turn/start').length,0);
  await f.b.handle(f.msg('original task'));
  assert.equal(f.rpc.calls.filter(call=>call.method==='turn/start').length,1);assert.equal(f.b.takeoverReservation,null);assert.equal(f.b.active.turnId,'turn-after-takeover');
});
test('desktop takeover cancellation changes no process or task state',async t=>{
  let releases=0;const f=fixture(t,{desktopTakeover:{release:async()=>{releases++;}}});
  await f.b.offerDesktopTakeover(f.thread.id);const offer=f.tg.messages.at(-1);
  await f.b.callback(f.callback(offer,offer.keyboard[0][1].callback_data));
  assert.equal(releases,0);assert.equal(f.rpc.calls.length,0);assert.equal(f.b.active,null);assert.ok(f.tg.messages.at(-1).text.includes('没有结束任何进程'));
});
test('/release drops only the bridge-owned writer and keeps the session selected',async t=>{
  const f=fixture(t);f.b.selected=f.thread;f.b.managed.set(f.thread.id,f.thread);f.b.loadedThreadId=f.thread.id;f.rpc.isRunning=true;let closed=0;
  f.rpc.close=async()=>{closed++;f.rpc.isRunning=false;};await f.b.handle(f.msg('/release'));
  assert.equal(f.rpc.calls.at(-1).method,'thread/unsubscribe');assert.equal(closed,1);assert.equal(f.b.loadedThreadId,null);assert.equal(f.b.selected.id,f.thread.id);assert.ok(f.tg.messages.at(-1).text.includes('不能释放桌面端'));
});
test('legacy history contains only user and assistant text',async t=>{
  const f=fixture(t);f.rpc.handler=()=>({thread:{...f.thread,turns:[{items:[{type:'userMessage',content:[{type:'text',text:'hello'}]},{type:'reasoning',summary:['private reasoning']},{type:'commandExecution',aggregatedOutput:'tool secret'},{type:'agentMessage',text:'answer'}]}]}});
  await f.b.history('thread-1');const text=f.tg.messages.map(m=>m.text).join('\n');
  assert.ok(text.includes('hello'));assert.ok(text.includes('answer'));assert.ok(!text.includes('private reasoning'));assert.ok(!text.includes('tool secret'));
});
test('paginated history uses item pages instead of unsupported full hydration',async t=>{
  const f=fixture(t);f.rpc.handler=m=>m==='thread/read'?{thread:{...f.thread,historyMode:'paginated'}}:{data:[{item:{type:'agentMessage',text:'recent answer'}}]};
  await f.b.history('thread-1');assert.equal(f.rpc.calls[1].method,'thread/items/list');assert.equal(f.rpc.calls[1].params.sortDirection,'desc');
});
test('history outside local allowlist is not sent to Telegram',async t=>{
  const f=fixture(t);f.rpc.handler=()=>({thread:{...f.thread,cwd:f.outside}});
  await assert.rejects(f.b.history('thread-1'),/不属于已授权/);assert.equal(f.tg.messages.length,0);
});
test('approval binds user, chat, message and is single use',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.request());const m=f.tg.messages.at(-1),data=m.keyboard[0][0].callback_data;
  assert.ok(Buffer.byteLength(data)<=64);
  await f.b.callback(f.callback(m,data,999));assert.equal(f.rpc.replies.length,0);
  await f.b.callback(f.callback({...m,message_id:9999},data));assert.equal(f.rpc.replies.length,0);
  await f.b.callback(f.callback(m,data));await f.b.callback(f.callback(m,data));
  assert.deepEqual(f.rpc.replies,[{id:1,result:{decision:'accept'}}]);
});
test('duplicate server request ID does not create a second approval',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.request());await f.b.serverRequest(f.request());assert.equal(f.b.approvals.size,1);
});
test('wrong-thread approval fails closed without disclosing command',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.request(1,{threadId:'foreign-thread'}));
  assert.equal(f.rpc.replies[0].result.decision,'decline');assert.equal(f.tg.messages.length,0);
});
test('approval expiry denies after wall-clock advance even before timer fires',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.request());const m=f.tg.messages.at(-1);f.clock.time+=601000;
  await f.b.callback(f.callback(m,m.keyboard[0][0].callback_data));assert.equal(f.rpc.replies[0].result.decision,'decline');
});
test('completion invalidates old approvals with no late execution',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.request());const m=f.tg.messages.at(-1);
  await f.b.notification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  await f.b.callback(f.callback(m,m.keyboard[0][0].callback_data));assert.equal(f.rpc.replies.length,0);assert.equal(f.b.active,null);
});
test('completion unsubscribes then closes the temporary worker after the final status',async t=>{
  const f=fixture(t),events=[];f.current();f.rpc.isRunning=true;
  f.rpc.handler=method=>{events.push(method);return {};};
  f.rpc.close=async()=>{events.push('close');f.rpc.isRunning=false;};
  const say=f.tg.say.bind(f.tg);f.tg.say=async(...args)=>{events.push('say');return say(...args);};
  await f.b.notification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  assert.deepEqual(events.slice(-3),['say','thread/unsubscribe','close']);assert.equal(f.rpc.isRunning,false);assert.equal(f.b.releasePromise,null);
});
test('unsubscribe failure cannot change a completed result and still closes the worker',async t=>{
  const f=fixture(t);f.current();f.rpc.isRunning=true;let closed=0;
  f.rpc.handler=method=>{if(method==='thread/unsubscribe')throw new Error('private release detail');return {};};
  f.rpc.close=async()=>{closed++;f.rpc.isRunning=false;};
  await f.b.notification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  assert.equal(closed,1);assert.ok(f.tg.messages.some(message=>message.text.includes('任务已完成')));assert.ok(!f.tg.messages.some(message=>message.text.includes('private release detail')));
});
test('final Telegram delivery failure still releases the worker',async t=>{
  const f=fixture(t);f.current();f.rpc.isRunning=true;let closed=0;
  f.rpc.close=async()=>{closed++;f.rpc.isRunning=false;};f.tg.say=async()=>{throw new Error('telegram unavailable');};
  await assert.rejects(f.b.notification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}}),/telegram unavailable/);
  assert.equal(closed,1);assert.equal(f.rpc.calls.at(-1).method,'thread/unsubscribe');assert.equal(f.b.active,null);
});
test('next task restarts and resumes the selected session after worker release',async t=>{
  const f=fixture(t);f.current();f.rpc.generation=1;f.rpc.isRunning=true;
  f.rpc.start=async()=>{if(!f.rpc.isRunning){f.rpc.isRunning=true;f.rpc.generation++;}};
  f.rpc.close=async()=>{f.rpc.isRunning=false;};
  f.rpc.handler=(method)=>method==='thread/resume'?{thread:f.thread}:method==='turn/start'?{turn:{id:'turn-2'}}:{};
  await f.b.notification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  await f.b.startTurn('continue');assert.equal(f.rpc.generation,2);assert.deepEqual(f.rpc.calls.slice(-2).map(call=>call.method),['thread/resume','turn/start']);
});
test('confirmed turn start rejection releases a resumed writer',async t=>{
  const f=fixture(t);f.b.selected=f.thread;f.b.managed.set(f.thread.id,f.thread);f.rpc.generation=1;f.rpc.isRunning=true;let closed=0;
  f.rpc.start=async()=>{};f.rpc.close=async()=>{closed++;f.rpc.isRunning=false;};
  f.rpc.handler=method=>{if(method==='thread/resume')return {thread:f.thread};if(method==='turn/start'){const error=new Error('rejected');error.code=-32602;throw error;}return {};};
  await assert.rejects(f.b.startTurn('continue'),/rejected/);
  assert.deepEqual(f.rpc.calls.map(call=>call.method),['thread/resume','turn/start','thread/unsubscribe']);assert.equal(closed,1);assert.equal(f.b.active,null);
});
test('exact HTTPS network allowlist applies a policy amendment without approving the command',async t=>{
  const f=fixture(t);f.b.networkAllowedDomains.add('api.flyapi.tech');f.current();
  await f.b.serverRequest({id:9,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'network',networkApprovalContext:{host:'api.flyapi.tech',protocol:'https'},proposedNetworkPolicyAmendments:[{host:'api.flyapi.tech',action:'allow'}]}});
  assert.deepEqual(f.rpc.replies,[{id:9,result:{decision:{applyNetworkPolicyAmendment:{network_policy_amendment:{host:'api.flyapi.tech',action:'allow'}}}}}]);assert.equal(f.tg.messages.length,0);
});
test('network allowlist rejects subdomains, HTTP and unproposed amendments',async t=>{
  const f=fixture(t);f.b.networkAllowedDomains.add('api.flyapi.tech');f.current();
  for(const [id,host,protocol,proposed] of [[10,'evil.api.flyapi.tech','https',true],[11,'api.flyapi.tech','http',true],[12,'api.flyapi.tech','https',false]]) {
    const msg={id,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:`network-${id}`,cwd:f.thread.cwd,command:'curl example',networkApprovalContext:{host,protocol},proposedNetworkPolicyAmendments:proposed?[{host,action:'allow'}]:[]}};
    await f.b.serverRequest(msg);const key=[...f.b.approvals.keys()].at(-1);await f.b.expire(key);
  }
  assert.equal(f.rpc.replies.length,3);assert.ok(f.rpc.replies.every(reply=>reply.result.decision==='decline'));
});
test('resolved request invalidates buttons without a second response',async t=>{
  const f=fixture(t);f.current();const req=f.request();await f.b.serverRequest(req);const m=f.tg.messages.at(-1);
  await f.b.notification({method:'serverRequest/resolved',params:{requestId:1}});
  await f.b.callback(f.callback(m,m.keyboard[0][0].callback_data));f.b.deny(req);assert.equal(f.rpc.replies.length,0);
});
test('delivery failure sends exactly one decline even through outer error handler',async t=>{
  const f=fixture(t);f.current();f.tg.say=async()=>{throw new Error('offline');};const request=f.request();
  try {await f.b.serverRequest(request);}catch(e){f.b.requestFailed(request,e);}
  assert.deepEqual(f.rpc.replies,[{id:1,result:{decision:'decline'}}]);assert.equal(f.b.approvals.size,0);
});
test('oversize and bidirectional command text is refused without approve buttons',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.request(1,{command:'x'.repeat(13000)}));await f.b.serverRequest(f.request(2,{command:'git\u202estatus'}));
  assert.ok(f.rpc.replies.every(r=>r.result.decision==='decline'));assert.ok(f.tg.messages.every(m=>!m.keyboard));
});
test('missing command metadata and terminal stdin requests are refused',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.request(1,{command:null}));await f.b.serverRequest(f.request(2,{kind:'writeStdin'}));
  assert.equal(f.rpc.replies.length,2);assert.ok(f.rpc.replies.every(r=>r.result.decision==='decline'));
});
test('file approval requires full diff and no long-lived grantRoot',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest({id:1,method:'item/fileChange/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-1'}});
  assert.equal(f.rpc.replies[0].result.decision,'decline');
});
test('file diff inside project can be approved once',async t=>{
  const f=fixture(t);f.current();await f.b.notification({method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'item-1',type:'fileChange',changes:[{path:'new.txt',kind:{type:'add'},diff:'+hello'}]}}});
  await f.b.serverRequest({id:1,method:'item/fileChange/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-1'}});
  const m=f.tg.messages.at(-1);assert.ok(m.text.includes('+hello'));await f.b.callback(f.callback(m,m.keyboard[0][0].callback_data));assert.equal(f.rpc.replies[0].result.decision,'accept');
});
test('symlink escape in file changes is refused',async t=>{
  const f=fixture(t);f.current();fs.symlinkSync(f.outside,path.join(f.project,'escape'));
  await f.b.notification({method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'item-1',type:'fileChange',changes:[{path:'escape/new.txt',kind:{type:'add'},diff:'+hello'}]}}});
  await f.b.serverRequest({id:1,method:'item/fileChange/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-1'}});
  assert.equal(f.rpc.replies[0].result.decision,'decline');
});
test('rename outside authorized project requires directory authorization before approval',async t=>{
  const f=fixture(t);f.current();await f.b.notification({method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'item-1',type:'fileChange',changes:[{path:'old.txt',kind:{type:'update',move_path:path.join(f.outside,'new.txt')},diff:'rename'}]}}});
  await f.b.serverRequest({id:1,method:'item/fileChange/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-1'}});
  assert.equal(f.rpc.replies.length,0);const m=f.tg.messages.at(-1);assert.ok(m.keyboard[0][0].callback_data.startsWith('d:'));
  await f.b.callback(f.callback(m,m.keyboard[0][1].callback_data));assert.equal(f.rpc.replies[0].result.decision,'decline');
});
test('approval click rechecks paths after a symlink is introduced',async t=>{
  const f=fixture(t);f.current();await f.b.notification({method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'item-1',type:'fileChange',changes:[{path:'later/file.txt',kind:{type:'add'},diff:'+hello'}]}}});
  await f.b.serverRequest({id:1,method:'item/fileChange/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-1'}});const m=f.tg.messages.at(-1);
  fs.symlinkSync(f.outside,path.join(f.project,'later'));await f.b.callback(f.callback(m,m.keyboard[0][0].callback_data));assert.equal(f.rpc.replies[0].result.decision,'decline');
});
test('unsupported permissions and tools never auto-grant',async t=>{
  const f=fixture(t);f.current();const params={threadId:'thread-1',turnId:'turn-1'};
  await f.b.serverRequest({id:1,method:'item/permissions/requestApproval',params});await f.b.serverRequest({id:2,method:'item/tool/call',params});
  assert.deepEqual(f.rpc.replies[0].result,{permissions:{},scope:'turn'});assert.equal(f.rpc.replies[1].error,true);
});
test('multi-question input waits for all answers and validates fixed options',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest({id:1,method:'item/tool/requestUserInput',params:{threadId:'thread-1',turnId:'turn-1',questions:[{id:'choice',question:'Choose?',isOther:false,options:[{label:'A'},{label:'B'}]},{id:'note',question:'Details?',isOther:true}]}});
  const keys=[...f.b.questions.keys()];await assert.rejects(f.b.answer(`${keys[0]} C`),/选项/);
  await f.b.answer(`${keys[0]} A`);assert.equal(f.rpc.replies.length,0);await f.b.answer(`${keys[1]} go ahead`);
  assert.deepEqual(JSON.parse(JSON.stringify(f.rpc.replies[0].result)),{answers:{choice:{answers:['A']},note:{answers:['go ahead']}}});
});
test('secret questions are never forwarded',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest({id:1,method:'item/tool/requestUserInput',params:{threadId:'thread-1',turnId:'turn-1',questions:[{id:'password',question:'PRIVATE VALUE',isSecret:true}]}});
  assert.deepEqual(f.rpc.replies[0].result,{answers:{}});assert.ok(!f.tg.messages[0].text.includes('PRIVATE VALUE'));
});
test('expired input is not accepted after sleep',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest({id:1,method:'item/tool/requestUserInput',params:{threadId:'thread-1',turnId:'turn-1',questions:[{id:'q',question:'Proceed?'}]}});
  const key=[...f.b.questions.keys()][0];f.clock.time+=601000;await assert.rejects(f.b.answer(`${key} yes`),/过期/);assert.deepEqual(f.rpc.replies[0].result,{answers:{}});
});
test('stop denies pending and newly arriving approvals until completion',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.request());await f.b.stop();await f.b.serverRequest(f.request(2));
  assert.equal(f.rpc.calls.at(-1).method,'turn/interrupt');assert.equal(f.b.active.stopping,true);assert.ok(f.rpc.replies.every(r=>r.result.decision==='decline'));
});
test('turn completion before start response does not restore stale active state',async t=>{
  const f=fixture(t);f.b.selected=f.thread;f.b.managed.set(f.thread.id,f.thread);
  f.rpc.handler=async()=>{await f.b.notification({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-fast',status:'completed'}}});return {turn:{id:'turn-fast'}};};
  await f.b.startTurn('quick');assert.equal(f.b.active,null);
});
test('unrelated turn-start event cannot replace active turn ID',async t=>{
  const f=fixture(t);f.current();await f.b.notification({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-foreign'}}});assert.equal(f.b.active.turnId,'turn-1');
});
test('disconnect invalidates every interactive token',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.request());f.rpc.fail(new Error('lost'));assert.equal(f.b.approvals.size,0);assert.equal(f.b.broken,true);
});
test('canonical targets handle new nested files and symlinks',t=>{
  const f=fixture(t);assert.equal(canonicalTarget(path.join(f.project,'new/nested/file.txt')),path.join(fs.realpathSync(f.project),'new/nested/file.txt'));
  fs.symlinkSync(f.outside,path.join(f.project,'link'));assert.equal(canonicalTarget(path.join(f.project,'link/new.txt')),path.join(fs.realpathSync(f.outside),'new.txt'));
  fs.symlinkSync(path.join(f.root,'missing'),path.join(f.project,'dangling'));assert.throws(()=>canonicalTarget(path.join(f.project,'dangling/file.txt')));
});
test('containment rejects prefix siblings and directory symlink escapes',t=>{
  const f=fixture(t);assert.equal(within(f.project,`${f.project}-other`),false);fs.symlinkSync(f.outside,path.join(f.project,'link'));
  assert.throws(()=>allowedThread(f.config,{id:'x',cwd:path.join(f.project,'link')}));assert.throws(()=>validateProject('/'));
});
test('new configurations trust no network domains by default',t=>{
  const f=fixture(t),config={token:'123456:THIS_IS_A_DUMMY_TOKEN_NOT_REAL',userId:123,chatId:123,codexPath:process.execPath,codexHome:f.outside,projects:[{id:'p1',name:'Project',cwd:f.project}]};
  validateConfig(config,path.join(f.outside,'config.json'));assert.deepEqual(config.networkAllowedDomains,[]);
});
test('private config writes are atomic and permission restricted',t=>{
  const f=fixture(t),file=path.join(f.root,'state/config.json');writePrivateJson(file,{test:1});writePrivateJson(file,{test:2});assert.deepEqual(readJson(file),{test:2});assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);
});
test('same config cannot run two local bridge instances',t=>{
  const f=fixture(t),file=path.join(f.root,'bridge.lock');const release=acquireLock(file);assert.throws(()=>acquireLock(file),/已在运行/);release();assert.equal(fs.existsSync(file),false);
});
test('token errors are sanitized and unicode messages chunk without broken pairs',()=>{
  const token='123456:THIS_IS_A_DUMMY_TOKEN_NOT_REAL';assert.ok(!safeError(new Error(`https://api.telegram.org/bot${token}/getMe`),token).includes(token));
  const text='a\u{20000}文'.repeat(3000),parts=chunks(text);assert.equal(parts.join(''),text);assert.ok(parts.every(x=>x.length<=3500));assert.ok(parts.every(x=>!/[\uD800-\uDBFF]$/.test(x)));
});
test('inbox checkpoints before execution and deduplicates updates',async()=>{
  const order=[];const inbox=new Inbox({since:100,save:state=>order.push(['save',state.offset])});const update={update_id:9,message:{date:101}};
  await inbox.dispatch(update,async()=>order.push(['execute']));await inbox.dispatch(update,async()=>order.push(['duplicate']));assert.deepEqual(order,[['save',10],['execute']]);
});
test('checkpoint failure prevents all execution and offset advancement',async()=>{
  let executed=false;const inbox=new Inbox({since:100,save:()=>{throw new Error('disk full');}});
  await assert.rejects(inbox.dispatch({update_id:1,message:{date:101}},async()=>{executed=true;}),/disk full/);assert.equal(executed,false);assert.equal(inbox.offset,0);
});
test('pre-start messages are consumed without execution',async()=>{
  let executed=false;const inbox=new Inbox({since:100,save:()=>{}});await inbox.dispatch({update_id:5,message:{date:99}},async()=>{executed=true;});assert.equal(executed,false);assert.equal(inbox.offset,6);
});
test('crashed delivery is not automatically replayed from saved offset',async()=>{
  let saved;const one=new Inbox({since:100,save:s=>{saved=s;}});const update={update_id:5,message:{date:101}};
  await assert.rejects(one.dispatch(update,async()=>{throw new Error('crash');}));const two=new Inbox({offset:saved.offset,since:100,save:()=>{}});let executed=false;
  await two.dispatch(update,async()=>{executed=true;});assert.equal(executed,false);
});
