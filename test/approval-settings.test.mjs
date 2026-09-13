import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {Bridge} from '../src/bridge.mjs';
import {ApprovalSettings,approvalPolicy,approvalModeFromState,approvalState} from '../src/approval-settings.mjs';
import {writePrivateJson,readJson} from '../src/util.mjs';

const cwd=path.dirname(fileURLToPath(import.meta.url));
const owner={userId:123,chatId:123,botId:456};
class Rpc extends EventEmitter {
  calls=[];replies=[];
  async call(method,params){this.calls.push({method,params});return this.handler(method,params);}
  respond(id,result){this.replies.push({id,result});}reject(id){this.replies.push({id,error:true});}
}
function fixture(t,options={}) {
  const config={userId:123,chatId:123,projects:[{id:'p1',name:'Test',cwd}],approvalTimeoutSeconds:60};
  const thread={id:'t1',cwd,status:{type:'idle'},historyMode:'legacy',turns:[]};
  const rpc=new Rpc(),messages=[],saved=[],clock={now:1000000};
  const tg={async say(_id,text,keyboard){const m={message_id:messages.length+1,text,keyboard};messages.push(m);return m;},async ack(){},async clear(){}};
  rpc.handler=(method,p)=>method==='turn/start'?{turn:{id:'turn1'}}:method==='thread/list'?{data:[thread],nextCursor:null}:method==='turn/interrupt'?{}:{thread:{...thread,id:p.threadId||thread.id}};
  const b=new Bridge(config,rpc,tg,{now:()=>clock.now,saveApproval:mode=>{saved.push(mode);},...options});
  const message=(text,user=123,type='private')=>({message:{from:{id:user},chat:{id:123,type},text}});
  const cb=(m,data,user=123,type='private')=>({id:'click',from:{id:user},message:{message_id:m.message_id,chat:{id:123,type}},data});
  const click=(m,index=0)=>b.callback(cb(m,m.keyboard[0][index].callback_data));
  const enable=async(mode='auto')=>{await b.handle(message('/approval '+mode));await click(messages.at(-1));};
  const current=()=>{b.selected=thread;b.managed.set(thread.id,thread);b.active={threadId:'t1',turnId:'turn1',approvalMode:b.approvalSettings.mode};};
  const request=(id=1)=>({id,method:'item/commandExecution/requestApproval',params:{threadId:'t1',turnId:'turn1',itemId:'i',cwd,command:'pwd'}});
  t.after(()=>b.dispose());return {b,config,thread,rpc,tg,messages,saved,clock,message,cb,click,enable,current,request};
}

test('approval settings default to strict without implicit rights expansion',()=>{
  const s=new ApprovalSettings();assert.equal(s.mode,'strict');assert.equal(s.policy(),'untrusted');assert.equal(s.reviewer(),'user');assert.equal(approvalModeFromState(null,owner),'strict');
});
test('only strict and sandbox auto can be selected; full-access and reviewer values are not aliases',()=>{
  for(const mode of ['never','on-request','auto_review','guardian_subagent','dangerFullAccess','__proto__','constructor',null,0,{}]) assert.throws(()=>approvalPolicy(mode));
  assert.equal(approvalPolicy('auto'),'on-request');assert.equal(approvalPolicy('strict'),'untrusted');assert.equal(new ApprovalSettings({mode:'auto'}).reviewer(),'auto_review');
});
test('menu is informational; choosing auto generates second explicit confirmation',async t=>{
  const f=fixture(t);await f.b.handle(f.message('/approval'));const m=f.messages.at(-1);assert.equal(f.saved.length,0);
  assert.ok(m.text.includes('auto_review'));await f.click(m);assert.equal(f.saved.length,0);assert.equal(f.b.approvalSettings.mode,'strict');
  assert.ok(f.messages.at(-1).text.includes('确认切换'));assert.ok(f.messages.at(-1).keyboard[0][0].text.includes('确认启用'));assert.equal(f.rpc.calls.length,0);
});
test('confirmed auto changes future settings only, sends no RPC or old approval response',async t=>{
  const f=fixture(t);await f.enable();assert.deepEqual(f.saved,['auto']);assert.equal(f.b.policy().approvalPolicy,'on-request');assert.equal(f.rpc.calls.length,0);assert.equal(f.rpc.replies.length,0);assert.equal(f.b.selected,null);
});
test('normal text mentioning automatic approval cannot switch settings',async t=>{
  const f=fixture(t);await f.b.handle(f.message('enable auto approval'));assert.equal(f.saved.length,0);assert.equal(f.b.approvalSettings.mode,'strict');
});
test('unpaired users and group chats cannot offer or confirm changes',async t=>{
  const f=fixture(t);await f.b.handle(f.message('/approval auto',999));await f.b.handle(f.message('/approval auto',123,'group'));assert.equal(f.messages.length,0);
  await f.b.handle(f.message('/approval auto'));const m=f.messages.at(-1),data=m.keyboard[0][0].callback_data;
  await f.b.callback(f.cb(m,data,999));await f.b.callback(f.cb(m,data,123,'group'));assert.equal(f.saved.length,0);
});
test('confirmation binds original message and is single-use',async t=>{
  const f=fixture(t);await f.b.offerApprovalMode('auto');const m=f.messages.at(-1),data=m.keyboard[0][0].callback_data;
  assert.ok(Buffer.byteLength(data)<=64);await f.b.callback(f.cb({...m,message_id:99999},data));assert.equal(f.saved.length,0);
  await f.click(m);await f.click(m);assert.deepEqual(f.saved,['auto']);
});
test('cancel invalidates sibling confirmation',async t=>{
  const f=fixture(t);await f.b.offerApprovalMode('auto');const m=f.messages.at(-1);await f.click(m,1);await f.click(m);assert.equal(f.saved.length,0);assert.equal(f.b.approvalSettings.mode,'strict');
});
test('mode confirmation expires after five minutes',async t=>{
  const f=fixture(t);await f.b.offerApprovalMode('auto');const m=f.messages.at(-1);f.clock.now+=300001;await f.click(m);assert.equal(f.saved.length,0);
});
test('later successful switch invalidates older mode confirmation by revision',async t=>{
  const f=fixture(t);await f.b.offerApprovalMode('auto');const old=f.messages.at(-1);await f.b.offerApprovalMode('strict');await f.click(f.messages.at(-1));await f.click(old);assert.deepEqual(f.saved,['strict']);assert.ok(f.messages.at(-1).text.includes('旧确认失效'));
});
test('failed synchronous persistence leaves effective setting unchanged',async t=>{
  const f=fixture(t,{saveApproval:()=>{throw new Error('disk full');}});await f.enable();assert.equal(f.b.approvalSettings.mode,'strict');assert.equal(f.b.approvalSettings.revision,0);assert.ok(f.messages.at(-1).text.includes('disk full'));
});
test('menu allowed while running but switch not accepted and existing approval untouched',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.request());const count=f.b.approvals.size;
  await f.b.handle(f.message('/approval'));assert.ok(f.messages.at(-1).text.includes('不能中途切换'));
  await f.b.handle(f.message('/approval auto'));assert.equal(f.saved.length,0);assert.equal(f.b.approvals.size,count);assert.equal(f.rpc.replies.length,0);
});
test('a task starting between proposal and confirmation blocks the switch',async t=>{
  const f=fixture(t);await f.b.offerApprovalMode('auto');const m=f.messages.at(-1);f.current();await f.click(m);assert.equal(f.saved.length,0);assert.equal(f.b.active.approvalMode,'strict');
});
test('stopping task still blocks switching until completion',async t=>{
  const f=fixture(t);f.current();await f.b.stop();await f.b.handle(f.message('/approval auto'));assert.equal(f.saved.length,0);
  await f.b.notification({method:'turn/completed',params:{threadId:'t1',turn:{id:'turn1',status:'interrupted'}}});await f.enable();assert.deepEqual(f.saved,['auto']);assert.ok(!f.rpc.calls.some(c=>c.method==='turn/start'));
});
test('auto applies native auto review without enlarging sandbox roots',async t=>{
  const f=fixture(t);await f.enable();await f.b.handle(f.message('/new inspect code'));
  const a=f.rpc.calls.find(c=>c.method==='thread/start').params,b=f.rpc.calls.find(c=>c.method==='turn/start').params;
  assert.equal(a.approvalPolicy,'on-request');assert.equal(a.sandbox,'workspace-write');assert.equal(a.approvalsReviewer,'auto_review');
  assert.equal(b.approvalPolicy,'on-request');assert.equal(b.approvalsReviewer,'auto_review');assert.deepEqual(b.sandboxPolicy,{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true});
});
test('auto applies to resumed threads and subsequent messages',async t=>{
  const f=fixture(t);f.rpc.generation=1;f.rpc.start=async()=>{};await f.enable();await f.b.resume('t1');assert.ok(!f.rpc.calls.some(c=>c.method==='thread/resume'));await f.b.startTurn('continue');
  for(const method of ['thread/resume','turn/start']) {const p=f.rpc.calls.find(c=>c.method===method).params;assert.equal(p.approvalPolicy,'on-request');assert.equal(p.approvalsReviewer,'auto_review');}
});
test('existing connected idle thread switches at next task rather than re-resuming',async t=>{
  const f=fixture(t);f.b.selected=f.thread;await f.enable();await f.b.startTurn('continue');assert.ok(!f.rpc.calls.some(c=>c.method==='thread/resume'));assert.equal(f.rpc.calls.at(-1).params.approvalPolicy,'on-request');assert.equal(f.b.active.approvalMode,'auto');
});
test('reverting to strict restores original request policy for future tasks',async t=>{
  const f=fixture(t);await f.enable();await f.enable('strict');f.b.selected=f.thread;await f.b.startTurn('strict task');assert.equal(f.rpc.calls.at(-1).params.approvalPolicy,'untrusted');assert.deepEqual(f.saved,['auto','strict']);
});
test('auto still presents actual server approval and waits for user choice',async t=>{
  const f=fixture(t);await f.enable();f.current();await f.b.serverRequest(f.request());assert.equal(f.rpc.replies.length,0);
  const m=f.messages.at(-1);assert.ok(m.keyboard[0][0].callback_data.startsWith('a:'));await f.click(m,1);assert.equal(f.rpc.replies[0].result.decision,'decline');
});
test('auto still declines expired approvals, never adds acceptForSession',async t=>{
  const f=fixture(t);await f.enable();f.current();await f.b.serverRequest(f.request());const m=f.messages.at(-1);f.clock.now+=61000;await f.click(m);assert.deepEqual(f.rpc.replies,[{id:1,result:{decision:'decline'}}]);
});
test('unsupported requests and permissions remain fail-closed in auto mode',async t=>{
  const f=fixture(t);await f.enable();f.current();const params={threadId:'t1',turnId:'turn1'};
  await f.b.serverRequest({id:1,method:'item/permissions/requestApproval',params});await f.b.serverRequest({id:2,method:'item/tool/call',params});
  assert.deepEqual(f.rpc.replies,[{id:1,result:{permissions:{},scope:'turn'}},{id:2,error:true}]);
});
test('status distinguishes configured next policy and current task snapshot',async t=>{
  const f=fixture(t);await f.enable();f.current();await f.b.handle(f.message('/status'));const text=f.messages.at(-1).text;assert.ok(text.includes('后续任务审批模式：自动审查'));assert.ok(text.includes('当前任务审批模式：自动审查'));
});
test('approval mode persists scoped to bot, user and private chat, re-pairing defaults strict',()=>{
  const state=approvalState('auto',owner);assert.equal(approvalModeFromState(state,owner),'auto');
  assert.equal(approvalModeFromState(state,{...owner,botId:789}),'strict');assert.equal(approvalModeFromState(state,{...owner,userId:124,chatId:124}),'strict');assert.equal(approvalModeFromState(state,{...owner,chatId:124}),'strict');
  assert.equal(new ApprovalSettings({mode:approvalModeFromState(state,owner)}).policy(),'on-request');
});
test('corrupt or unsupported owned state fails instead of enabling fallback auto',()=>{
  const state=approvalState('auto',owner);
  for(const saved of [[],3,'auto',{...state,version:999},{...state,mode:'never'},{...state,mode:'constructor'},{...state,mode:undefined}]) assert.throws(()=>approvalModeFromState(saved,owner));
});
test('saved approval state contains no token or desktop configuration mutations',t=>{
  const dir=fs.mkdtempSync(path.join(cwd,'.fixture-policy-'));const configFile=path.join(dir,'config.json'),prefs=path.join(dir,'preferences.json'),approvalFile=path.join(dir,'approval.json');
  writePrivateJson(configFile,{token:'synthetic-only'});writePrivateJson(prefs,{model:'synthetic-model'});const before=fs.readFileSync(configFile),preferences=fs.readFileSync(prefs);
  const s=new ApprovalSettings({save:mode=>writePrivateJson(approvalFile,approvalState(mode,owner))});s.set('auto',0);
  assert.deepEqual(fs.readFileSync(configFile),before);assert.deepEqual(fs.readFileSync(prefs),preferences);assert.equal(fs.statSync(approvalFile).mode&0o777,0o600);assert.deepEqual(Object.keys(readJson(approvalFile)).sort(),['botId','chatId','mode','userId','version']);
});
test('Bot or user identity is required for persisted approval state',()=>{
  for(const identity of [{...owner,botId:null},{...owner,userId:0},{...owner,chatId:-123}]) assert.throws(()=>approvalState('auto',identity));
});
test('callback ack errors do not bypass or prevent explicit policy confirmation',async t=>{
  const f=fixture(t);await f.b.offerApprovalMode('auto');const m=f.messages.at(-1);f.tg.ack=async()=>{throw new Error('offline');};await f.click(m);assert.deepEqual(f.saved,['auto']);assert.equal(f.rpc.replies.length,0);
});
test('server policy error never retries task under full-access or never mode',async t=>{
  const f=fixture(t);await f.enable();f.b.selected=f.thread;f.rpc.handler=()=>{const e=new Error('policy restricted by admin');e.code=-32600;throw e;};
  await f.b.handle(f.message('run'));assert.equal(f.rpc.calls.filter(call=>call.method==='turn/start').length,1);assert.equal(f.rpc.calls[0].params.approvalPolicy,'on-request');assert.equal(f.rpc.calls.at(-1).method,'thread/unsubscribe');assert.ok(f.messages.at(-1).text.includes('policy restricted'));assert.equal(f.b.approvalSettings.mode,'auto');
});
