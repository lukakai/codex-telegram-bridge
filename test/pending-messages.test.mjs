import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {Bridge} from '../src/bridge.mjs';

const cwd=fileURLToPath(new URL('.',import.meta.url));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t) {
  const rpc=new EventEmitter(),calls=[],messages=[],clears=[],edits=[];let time=1000,next=0;
  const thread={id:'t1',cwd,name:'Steering test',status:{type:'notLoaded'}};
  rpc.generation=1;rpc.isRunning=true;
  rpc.start=async()=>{if(!rpc.isRunning){rpc.generation++;rpc.isRunning=true;}};
  rpc.close=async()=>{rpc.isRunning=false;};rpc.respond=()=>{};rpc.reject=()=>{};
  rpc.call=async(method,params)=>{
    calls.push({method,params});
    if(rpc.handler){const result=await rpc.handler(method,params);if(result!==undefined)return result;}
    if(method==='turn/steer')return {turnId:params.expectedTurnId};
    if(method==='turn/start')return {turn:{id:`next-${++next}`}};
    if(method==='thread/read'||method==='thread/resume')return {thread};
    return {};
  };
  const tg={async say(_chat,text,keyboard){const m={message_id:messages.length+1,text,keyboard};messages.push(m);return m;},async ack(){},async clear(_chat,id){clears.push(id);},async editMessageText(_chat,id,text){edits.push({id,text});}};
  const b=new Bridge({userId:123,chatId:123,projects:[{id:'project',cwd,name:'Test'}],approvalTimeoutSeconds:600},rpc,tg,{now:()=>time});
  b.selected=thread;b.managed.set(thread.id,thread);b.active={threadId:thread.id,turnId:'first'};b.loadedThreadId=thread.id;b.loadedGeneration=1;
  const message=(text,user=123)=>({message:{message_id:50,from:{id:user},chat:{id:123,type:'private'},text}});
  const callback=(card,action,user=123)=>({id:'click',from:{id:user},message:{message_id:card.message_id,chat:{id:123,type:'private'}},data:card.keyboard.flat().find(button=>button.callback_data.endsWith(':'+action)).callback_data});
  const offer=async text=>{await b.handle(message(text));return messages.at(-1);};
  const complete=async(status='completed')=>{await b.notification({method:'turn/completed',params:{threadId:thread.id,turn:{id:b.active.turnId,status}}});await b.actionChain;};
  t.after(()=>b.dispose());return {b,rpc,calls,messages,clears,edits,thread,tg,message,callback,offer,complete,advance:ms=>{time+=ms;}};
}

test('running text becomes a pending message without steering or starting until clicked',async t=>{
  const f=fixture(t),m=await f.offer('Actually use blue');assert.equal(f.calls.length,0);assert.equal(f.b.pendingMessages.size,1);
  assert.ok(m.text.includes('尚未发送'));assert.deepEqual(m.keyboard.flat().map(b=>b.text),['立即引导','下一轮发送','取消']);
});
test('steering appends exact input to original turn with no policy overrides or new turn',async t=>{
  const f=fixture(t),m=await f.offer('先修测试\n再改页面');await f.b.callback(f.callback(m,'steer'));
  assert.deepEqual(f.calls,[{method:'turn/steer',params:{threadId:'t1',expectedTurnId:'first',input:[{type:'text',text:'先修测试\n再改页面'}]}}]);
  assert.equal(f.b.active.turnId,'first');assert.equal(f.b.pendingMessages.size,0);assert.ok(f.edits.at(-1).text.includes('已引导'));
});
test('steering binds paired user, message ID and consumes once even with concurrent clicks',async t=>{
  const f=fixture(t),m=await f.offer('Focus on tests'),click=f.callback(m,'steer');
  await f.b.callback(f.callback(m,'steer',999));await f.b.callback({...click,message:{...click.message,message_id:9999}});assert.equal(f.calls.length,0);
  await Promise.all([f.b.callback(click),f.b.callback(click)]);assert.equal(f.calls.filter(c=>c.method==='turn/steer').length,1);
});
test('unsupported steer keeps draft available and never falls back to interrupt/start',async t=>{
  const f=fixture(t),m=await f.offer('Change direction');f.rpc.handler=method=>{if(method==='turn/steer')throw Object.assign(new Error('unsupported'),{code:-32601});};
  await f.b.callback(f.callback(m,'steer'));assert.equal(f.b.pendingMessages.size,1);assert.equal(f.calls.length,1);assert.equal([...f.b.pendingMessages.records.values()][0].state,'pending');
});
test('ambiguous steering failure or wrong returned turn ID cannot be retried from the draft',async t=>{
  for(const failure of ['network','wrong-id']) {
    const f=fixture(t),m=await f.offer('Change direction');f.rpc.handler=method=>{if(method==='turn/steer'){if(failure==='network')throw new Error('lost');return {turnId:'other'};}};
    await f.b.callback(f.callback(m,'steer'));await f.b.callback(f.callback(m,'next'));
    assert.equal(f.calls.length,1);assert.equal([...f.b.pendingMessages.records.values()][0].state,'uncertain');
  }
});
test('completed original turn cannot steer a later turn even in the same thread',async t=>{
  const f=fixture(t),m=await f.offer('Correct this');await f.complete();f.b.active={threadId:'t1',turnId:'another'};
  await f.b.callback(f.callback(m,'steer'));assert.equal(f.calls.filter(c=>c.method==='turn/steer').length,0);assert.equal(f.b.pendingMessages.size,1);
});
test('steer acceptance remains accepted if completion arrives before the RPC response',async t=>{
  const f=fixture(t),m=await f.offer('Change detail'),gate=deferred();f.rpc.handler=method=>method==='turn/steer'?gate.promise:undefined;
  const click=f.b.callback(f.callback(m,'steer'));await tick();
  await f.b.notification({method:'turn/completed',params:{threadId:'t1',turn:{id:'first',status:'completed'}}});
  gate.resolve({turnId:'first'});await click;await f.b.actionChain;
  assert.equal(f.b.pendingMessages.size,0);assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);
});
test('steering during stopping or before turn ID confirmation retains the draft',async t=>{
  for(const state of [{turnId:'first',stopping:true},{turnId:null}]) {
    const f=fixture(t);Object.assign(f.b.active,state);const m=await f.offer('Correct this');await f.b.callback(f.callback(m,'steer'));
    assert.equal(f.calls.length,0);assert.equal(f.b.pendingMessages.size,1);
  }
});
test('unselected or foreign preview never redirects a pending message',async t=>{
  const f=fixture(t),m=await f.offer('Correct t1');f.b.previewed={id:'other'};
  await f.b.callback(f.callback(m,'steer'));await f.b.callback(f.callback(m,'next'));assert.equal(f.calls.length,0);
});
test('next-round selection waits for success and resumes only after releasing original worker',async t=>{
  const f=fixture(t),m=await f.offer('Now add tests');await f.b.callback(f.callback(m,'next'));assert.equal(f.calls.length,0);
  await f.complete();assert.equal(f.b.pendingMessages.size,0);assert.equal(f.b.active.turnId,'next-1');
  const methods=f.calls.map(c=>c.method);assert.ok(methods.indexOf('thread/unsubscribe')<methods.indexOf('turn/start'));
  assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);const start=f.calls.find(c=>c.method==='turn/start');assert.equal(start.params.sandboxPolicy.type,'workspaceWrite');assert.equal(start.params.input[0].text,'Now add tests');
});
test('multiple explicitly queued messages are sent once in arrival order',async t=>{
  const f=fixture(t);for(const text of ['First instruction','Second instruction']){const m=await f.offer(text);await f.b.callback(f.callback(m,'next'));}
  await f.complete();const starts=f.calls.filter(c=>c.method==='turn/start');assert.equal(starts.length,1);assert.equal(starts[0].params.input[0].text,'First instruction\n\nSecond instruction');
});
test('unconfirmed drafts never start automatically after completion',async t=>{
  const f=fixture(t);await f.offer('Unconfirmed');await f.complete();assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);assert.equal(f.b.pendingMessages.size,1);
});
test('cancel and cancel-queue prevent automatic dispatch',async t=>{
  for(const action of ['cancel','hold']) {
    const f=fixture(t),m=await f.offer('Later');await f.b.callback(f.callback(m,'next'));const queued=f.messages.at(-1);
    await f.b.callback(f.callback(queued,action));await f.complete();assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);
  }
});
test('queued message can instead be steered before completion',async t=>{
  const f=fixture(t),m=await f.offer('Actually now');await f.b.callback(f.callback(m,'next'));await f.b.callback(f.callback(f.messages.at(-1),'steer'));await f.complete();
  assert.equal(f.calls.filter(c=>c.method==='turn/steer').length,1);assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);
});
test('failed, interrupted or stopping turns pause queued text',async t=>{
  for(const status of ['failed','interrupted','completed']) {
    const f=fixture(t),m=await f.offer('Later');await f.b.callback(f.callback(m,'next'));if(status==='completed')f.b.active.stopping=true;
    await f.complete(status);assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);assert.equal([...f.b.pendingMessages.records.values()][0].state,'pending');
  }
});
test('desktop occupation pauses queued text without takeover or turn/start',async t=>{
  const f=fixture(t),m=await f.offer('Later');await f.b.callback(f.callback(m,'next'));
  f.rpc.handler=method=>method==='thread/read'?{thread:{...f.thread,status:{type:'active'}}}:undefined;
  await f.complete();assert.equal(f.calls.filter(c=>c.method==='turn/start'||c.method==='thread/resume').length,0);assert.ok(f.messages.at(-1).text.includes('桌面任务占用中'));
});
test('expired drafts and drafts lost on restart cannot dispatch',async t=>{
  const f=fixture(t),m=await f.offer('Later');f.advance(30*60000+1);await f.b.callback(f.callback(m,'steer'));assert.equal(f.calls.length,0);assert.equal(f.b.pendingMessages.size,0);
  const n=await f.offer('Another');f.b.dispose();await f.b.callback(f.callback(n,'steer'));assert.equal(f.calls.length,0);
});
test('queue delivery failure never revives already accepted next-round input',async t=>{
  const f=fixture(t),m=await f.offer('Later');await f.b.callback(f.callback(m,'next'));
  const say=f.tg.say;f.tg.editMessageText=async()=>{throw new Error('offline');};f.tg.say=async(chat,text,keyboard)=>{if(text==='待办已作为下一轮任务提交。')throw new Error('offline');return say(chat,text,keyboard);};
  await f.complete();assert.equal(f.b.pendingMessages.size,0);assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
});
test('unrelated completion cannot release current worker or trigger pending dispatch',async t=>{
  const f=fixture(t),m=await f.offer('Later');await f.b.callback(f.callback(m,'next'));
  await f.b.notification({method:'turn/completed',params:{threadId:'t1',turn:{id:'foreign',status:'completed'}}});assert.equal(f.b.active.turnId,'first');assert.equal(f.calls.length,0);
});
test('/pending reissues bound buttons and never forwards the command as task text',async t=>{
  const f=fixture(t),old=await f.offer('Later');await f.b.handle(f.message('/pending'));const current=f.messages.at(-1);
  await f.b.callback(f.callback(old,'steer'));assert.equal(f.calls.length,0);await f.b.callback(f.callback(current,'steer'));assert.equal(f.calls.length,1);
});

test('long queued input is split across sequential turns without loss or duplicate dispatch',async t=>{
  const f=fixture(t),parts=['a'.repeat(16000),'b'.repeat(16000),'c'.repeat(16000)];
  for(const text of parts){const m=await f.offer(text);await f.b.callback(f.callback(m,'next'));}
  await f.complete();assert.equal(f.b.pendingMessages.size,2);
  await f.complete();assert.equal(f.b.pendingMessages.size,1);
  await f.complete();assert.equal(f.b.pendingMessages.size,0);
  assert.deepEqual(f.calls.filter(c=>c.method==='turn/start').map(c=>c.params.input[0].text),parts);
});
test('queued turn rejection stays paused until a new explicit choice',async t=>{
  const f=fixture(t),m=await f.offer('Later');await f.b.callback(f.callback(m,'next'));
  f.rpc.handler=method=>{if(method==='turn/start')throw Object.assign(new Error('rejected'),{code:-32602});};
  await f.complete();await f.b.pendingMessages.drain();assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);assert.equal([...f.b.pendingMessages.records.values()][0].state,'pending');
});
test('pending input expiring during metadata check never reaches turn/start',async t=>{
  const f=fixture(t),m=await f.offer('Later');await f.b.callback(f.callback(m,'next'));
  const gate=deferred();f.rpc.handler=method=>method==='thread/read'?gate.promise:undefined;
  await f.b.notification({method:'turn/completed',params:{threadId:'t1',turn:{id:'first',status:'completed'}}});await tick();f.advance(30*60000+1);gate.resolve({thread:f.thread});await f.b.actionChain;
  assert.equal(f.calls.filter(c=>c.method==='turn/start').length,0);assert.equal(f.b.pendingMessages.size,0);
});
test('new manual task ahead of ready queue pauses the old queue',async t=>{
  const f=fixture(t),m=await f.offer('Later');await f.b.callback(f.callback(m,'next'));
  f.b.pendingMessages.completed(f.b.active,{status:'completed'});f.b.active={threadId:'t1',turnId:'manual'};
  await f.b.pendingMessages.drain();assert.equal(f.calls.length,0);assert.equal([...f.b.pendingMessages.records.values()][0].state,'pending');
});
test('pending storage is bounded and status includes its count',async t=>{
  const f=fixture(t);await f.offer('a'.repeat(30000));await f.offer('b'.repeat(30000));await f.offer('extra');assert.equal(f.b.pendingMessages.size,2);assert.ok(f.messages.at(-1).text.includes('待办已满'));
  await f.b.handle(f.message('/status'));assert.ok(f.messages.at(-1).text.includes('文字待办：2'));
});
