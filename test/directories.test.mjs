import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {Bridge} from '../src/bridge.mjs';
import {DirectoryGrants,remoteCandidate,revalidateCandidate,requiredCommandDirectories,requiredFileDirectories} from '../src/directories.mjs';
import {allowedThread,assertUnprotected,writePrivateJson,readJson} from '../src/util.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
class Rpc extends EventEmitter {
  calls=[];replies=[];
  async call(method,params){this.calls.push({method,params});return this.handler(method,params);}
  respond(id,result){this.replies.push({id,result});}reject(id){this.replies.push({id,error:true});}
}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(here,'.fixture-grants-'));
  const project=path.join(root,'original'),extra=path.join(root,'extra'),other=path.join(root,'other'),state=path.join(root,'state');
  [project,extra,other,state].forEach(p=>fs.mkdirSync(p));
  const config={userId:123,chatId:123,projects:[{id:'p1',name:'Original',cwd:project}],protectedPaths:[state],approvalTimeoutSeconds:60};
  const saved=[],messages=[],clears=[],clock={now:1000000};const rpc=new Rpc();
  const tg={async say(_id,text,keyboard){const m={message_id:messages.length+1,text,keyboard};messages.push(m);return m;},async ack(){},async clear(_id,id){clears.push(id);}};
  const thread={id:'t1',cwd:project,status:{type:'idle'},historyMode:'legacy',turns:[]};
  rpc.handler=(method,p)=>method==='turn/start'?{turn:{id:'turn1'}}:method==='thread/list'?{data:[thread],nextCursor:null}:{thread:{...thread,id:p.threadId||thread.id}};
  const b=new Bridge(config,rpc,tg,{now:()=>clock.now,saveGrants:g=>{saved.push(structuredClone(g));}});
  const message=(text,user=123,type='private')=>({message:{from:{id:user},chat:{id:123,type},text}});
  const callback=(m,data,user=123)=>({id:'click',from:{id:user},message:{message_id:m.message_id,chat:{id:123,type:'private'}},data});
  const click=async(m,position=0,user=123)=>b.callback(callback(m,m.keyboard[0][position].callback_data,user));
  const current=()=>{b.selected=thread;b.managed.set(thread.id,thread);b.active={threadId:'t1',turnId:'turn1'};};
  const command=(id=1,cwd=extra)=>({id,method:'item/commandExecution/requestApproval',params:{threadId:'t1',turnId:'turn1',itemId:'i1',cwd,command:'pwd'}});
  const grant=async(p=extra)=>{await b.handle(message('/allow '+p));await click(messages.at(-1));return b.grants.grants.find(g=>g.cwd===p);};
  t.after(()=>b.dispose());return {root,project,extra,other,state,config,b,rpc,tg,thread,messages,clears,saved,clock,message,callback,click,current,command,grant};
}

test('allow requires separate explicit confirmation and saves only directory metadata',async t=>{
  const f=fixture(t);await f.b.handle(f.message('/allow '+f.extra));assert.equal(f.saved.length,0);assert.equal(f.config.projects.length,1);
  const card=f.messages.at(-1);assert.ok(card.text.includes(f.extra));await f.click(card);assert.equal(f.saved.length,1);assert.equal(f.config.projects.length,2);
  assert.equal(f.saved[0][0].cwd,f.extra);assert.equal(f.saved[0][0].token,undefined);assert.equal(f.rpc.calls.length,0);assert.equal(f.b.selected,null);
});
test('confirmation belongs to paired user, private chat, correct message and is one-use',async t=>{
  const f=fixture(t);await f.b.handle(f.message('/allow '+f.extra,999));await f.b.handle(f.message('/allow '+f.extra,123,'group'));assert.equal(f.messages.length,0);
  await f.b.handle(f.message('/allow '+f.extra));const card=f.messages.at(-1),data=card.keyboard[0][0].callback_data;
  await f.click(card,0,999);await f.b.callback(f.callback({...card,message_id:9999},data));assert.equal(f.saved.length,0);
  await f.click(card);await f.click(card);assert.equal(f.saved.length,1);assert.ok(Buffer.byteLength(data)<=64);
});
test('directory confirmation expires after five minutes',async t=>{
  const f=fixture(t);await f.b.handle(f.message('/allow '+f.extra));const card=f.messages.at(-1);f.clock.now+=300001;await f.click(card);assert.equal(f.saved.length,0);
});
test('cancel consumes sibling allow button and preserves original rights',async t=>{
  const f=fixture(t);await f.b.handle(f.message('/allow '+f.extra));const card=f.messages.at(-1);await f.click(card,1);await f.click(card,0);assert.equal(f.saved.length,0);
});
test('broad roots and credentials are protected even without directory existence queries',()=>{
  const home=os.homedir();for(const p of ['/System/Library','/Library/Keychains','/usr/local','/private/etc','/var/log',home+'/.ssh',home+'/.codex',home+'/.workbuddy-ai','/some/project/.aws']) assert.throws(()=>assertUnprotected({},p));
  for(const p of ['/','/Users',home]) assert.throws(()=>remoteCandidate(p,{}));
});
test('bridge state and its parent cannot be remotely authorized',t=>{
  const f=fixture(t);assert.throws(()=>remoteCandidate(f.state,f.config),/受保护/);assert.throws(()=>remoteCandidate(f.root,f.config),/受保护/);
  assert.throws(()=>requiredFileDirectories(f.config,f.project,[{path:path.join(f.state,'new.json'),kind:{type:'add'},diff:'+x'}]),/受保护/);
});
test('specific work folder is allowed but its protected child remains inaccessible',t=>{
  const f=fixture(t),credential=path.join(f.extra,'.ssh');fs.mkdirSync(credential);f.b.grants.grant([remoteCandidate(f.extra,f.config)]);
  assert.equal(allowedThread(f.config,{id:'ok',cwd:f.extra}),f.extra);assert.throws(()=>allowedThread(f.config,{id:'secret',cwd:credential}),/受保护/);
});
test('relative paths, newlines, bidirectional text and non-directories are refused',t=>{
  const f=fixture(t),file=path.join(f.extra,'file');fs.writeFileSync(file,'test');
  for(const p of ['relative','~/project',f.extra+'\n',f.extra+'\u202e',file,path.join(f.extra,'missing')]) assert.throws(()=>remoteCandidate(p,f.config));
});
test('symlink alias is disclosed and target swap invalidates old confirmation',async t=>{
  const f=fixture(t),alias=path.join(f.root,'alias');fs.symlinkSync(f.extra,alias);await f.b.handle(f.message('/allow '+alias));const card=f.messages.at(-1);
  assert.ok(card.text.includes('输入路径：'+alias));fs.unlinkSync(alias);fs.symlinkSync(f.other,alias);await f.click(card);assert.equal(f.saved.length,0);
});
test('replacement directory inode invalidates confirmation and loaded grant',async t=>{
  const f=fixture(t);const proposal=remoteCandidate(f.extra,f.config);const g=await f.grant();
  fs.renameSync(f.extra,path.join(f.root,'old-extra'));fs.mkdirSync(f.extra);
  assert.throws(()=>revalidateCandidate(proposal,f.config),/变化/);assert.throws(()=>allowedThread(f.config,{id:'changed',cwd:f.extra}));
  const fresh={...f.config,projects:[{id:'p1',name:'Original',cwd:f.project}]};const restored=new DirectoryGrants(fresh,{grants:[g]});assert.equal(fresh.projects.length,1);assert.equal(restored.grants.length,1);
});
test('valid remote grants persist and authorize subdirectories after reconstruction',async t=>{
  const f=fixture(t);await f.grant();const child=path.join(f.extra,'sub');fs.mkdirSync(child);
  const restoredConfig={...f.config,projects:[{id:'p1',name:'Original',cwd:f.project}]};new DirectoryGrants(restoredConfig,{grants:f.saved.at(-1)});
  assert.equal(allowedThread(restoredConfig,{id:'nested',cwd:child}),child);
});
test('malformed stored grants fail closed',t=>{
  const f=fixture(t);assert.throws(()=>new DirectoryGrants(f.config,{grants:{cwd:f.extra}}));assert.throws(()=>new DirectoryGrants(f.config,{grants:[{id:'x',cwd:f.extra}]}));
});
test('save failure never publishes authorization in memory',async t=>{
  const f=fixture(t);f.b.grants.saveGrants=()=>{throw new Error('disk full');};await f.grant();assert.equal(f.b.grants.grants.length,0);assert.equal(f.config.projects.length,1);
});
test('existing local authorization is not duplicated or overwritten',async t=>{
  const f=fixture(t);await f.grant(f.project);assert.equal(f.saved.length,0);assert.equal(f.config.projects.length,1);assert.equal(f.config.projects[0].id,'p1');
});
test('revoke only applies to remote grants, not initial project config',async t=>{
  const f=fixture(t);await f.b.handle(f.message('/revoke p1'));assert.equal(f.saved.length,0);assert.equal(f.config.projects.length,1);
});
test('confirmed revoke drops selection and old navigation tokens without touching files',async t=>{
  const f=fixture(t),g=await f.grant();f.b.selected={...f.thread,cwd:f.extra};f.b.project=f.config.projects.find(p=>p.remote);
  await f.b.handle(f.message('/revoke '+g.id));const card=f.messages.at(-1);await f.click(card);
  assert.equal(f.b.selected,null);assert.equal(f.b.project.id,'p1');assert.equal(f.b.buttons.size,0);assert.ok(fs.existsSync(f.extra));assert.throws(()=>allowedThread(f.config,{id:'x',cwd:f.extra}));
});
test('other parent grant keeps access after revoking separately added child grant',async t=>{
  const f=fixture(t),child=path.join(f.extra,'child');fs.mkdirSync(child);const g=await f.grant(child);await f.grant(f.extra);
  await f.b.handle(f.message('/revoke '+g.id));await f.click(f.messages.at(-1));assert.ok(f.messages.at(-1).text.includes('仍覆盖'));assert.equal(allowedThread(f.config,{id:'x',cwd:child}),child);
});
test('revoke invalidates older grant confirmations so they cannot re-enable old rights',async t=>{
  const f=fixture(t),g=await f.grant();await f.b.handle(f.message('/allow '+f.other));const old=f.messages.at(-1);
  await f.b.handle(f.message('/revoke '+g.id));await f.click(f.messages.at(-1));await f.click(old);assert.equal(f.b.grants.grants.length,0);
});
test('standalone grant and revoke are blocked during active task',async t=>{
  const f=fixture(t),g=await f.grant();f.current();const length=f.saved.length;await f.b.handle(f.message('/allow '+f.other));await f.b.handle(f.message('/revoke '+g.id));assert.equal(f.saved.length,length);
});
test('out-of-scope thread provides directory proposal without fetching history body',async t=>{
  const f=fixture(t);f.rpc.handler=()=>({thread:{...f.thread,cwd:f.extra}});await f.b.handle(f.message('/history t1'));
  assert.equal(f.rpc.calls.length,1);assert.equal(f.rpc.calls[0].params.includeTurns,false);assert.ok(f.messages.at(-1).keyboard);assert.equal(f.saved.length,0);
});
test('same directory error is coalesced for thirty seconds',async t=>{
  const f=fixture(t);let error;try{allowedThread(f.config,{id:'x',cwd:f.extra});}catch(e){error=e;}
  await f.b.report(error);await f.b.report(error);assert.equal(f.messages.length,1);f.clock.now+=31000;await f.b.report(error);assert.equal(f.messages.length,2);
});
test('permissions lists invalid grants without granting them',async t=>{
  const f=fixture(t);await f.grant();fs.renameSync(f.extra,path.join(f.root,'moved-extra'));await f.b.permissions();assert.ok(f.messages.at(-1).text.includes('失效'));assert.equal(f.config.projects.length,1);
});
test('pending command directory authorization requires a separate execution click',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command());const first=f.messages.at(-1);assert.equal(f.rpc.replies.length,0);assert.ok(first.keyboard[0][0].callback_data.startsWith('d:'));
  await f.click(first);const confirmation=f.messages.at(-1);assert.equal(f.saved.length,0);await f.click(confirmation);assert.equal(f.saved.length,1);assert.equal(f.rpc.replies.length,0);
  const approval=f.messages.findLast(m=>m.keyboard?.[0]?.[0]?.callback_data?.endsWith(':yes'));assert.ok(approval);await f.click(approval);assert.deepEqual(f.rpc.replies,[{id:1,result:{decision:'accept'}}]);assert.ok(!f.rpc.calls.some(c=>c.method==='turn/start'));
});
test('pending directory proposal is bound to its original message',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command());const m=f.messages.at(-1);await f.b.callback(f.callback({...m,message_id:99999},m.keyboard[0][0].callback_data));assert.equal(f.saved.length,0);assert.equal(f.b.buttons.size,0);
});
test('expired approval confirmation never grants persistent directory access',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command());await f.click(f.messages.at(-1));const confirm=f.messages.at(-1);f.clock.now+=61000;await f.click(confirm);assert.equal(f.saved.length,0);assert.equal(f.config.projects.length,1);
});
test('completed turn invalidates related pending directory confirmation',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command());await f.click(f.messages.at(-1));const confirm=f.messages.at(-1);
  await f.b.notification({method:'turn/completed',params:{threadId:'t1',turn:{id:'turn1',status:'completed'}}});await f.click(confirm);assert.equal(f.saved.length,0);
});
test('stopping task rejects pending operation and prevents later directory grant',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command());await f.click(f.messages.at(-1));const confirm=f.messages.at(-1);await f.b.stop();await f.click(confirm);assert.equal(f.saved.length,0);assert.equal(f.rpc.replies[0].result.decision,'decline');
});
test('denied request cannot be revived by its prior directory confirmation',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command());const original=f.messages.at(-1);await f.click(original);const confirm=f.messages.at(-1);await f.click(original,1);await f.click(confirm);assert.equal(f.saved.length,0);assert.equal(f.rpc.replies.length,1);
});
test('grant keeps approval original expiry; no timeout extension',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command());const key=[...f.b.approvals.keys()][0],expires=f.b.approvals.get(key).expires;await f.click(f.messages.at(-1));f.clock.now+=40000;await f.click(f.messages.at(-1));assert.equal(f.b.approvals.get(key).expires,expires);
});
test('pending grant save failure neither authorizes nor approves execution',async t=>{
  const f=fixture(t);f.b.grants.saveGrants=()=>{throw new Error('disk full');};f.current();await f.b.serverRequest(f.command());await f.click(f.messages.at(-1));await f.click(f.messages.at(-1));assert.equal(f.b.grants.grants.length,0);assert.equal(f.rpc.replies.length,0);
});
test('forged accept before directory grant is fail-closed',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command());const m=f.messages.at(-1),key=m.keyboard[0][0].callback_data.slice(2);await f.b.callback(f.callback(m,`a:${key}:yes`));assert.equal(f.saved.length,0);assert.equal(f.rpc.replies[0].result.decision,'decline');
});
test('old directory request message cannot approve after new confirmation card replaces it',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command());const old=f.messages.at(-1),key=old.keyboard[0][0].callback_data.slice(2);await f.click(old);await f.click(f.messages.at(-1));await f.b.callback(f.callback(old,`a:${key}:yes`));assert.equal(f.rpc.replies.length,0);
});
test('cancel pending directory proposal works during task but does not approve',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command());await f.click(f.messages.at(-1));const c=f.messages.at(-1);await f.click(c,1);await f.click(c,0);assert.equal(f.saved.length,0);assert.equal(f.rpc.replies.length,0);
});
test('file change discovers smallest existing parent and rename destination',t=>{
  const f=fixture(t);const needed=requiredFileDirectories(f.config,f.project,[{path:path.join(f.extra,'new/nested/file'),kind:{type:'add'},diff:'+x'},{path:'old',kind:{type:'update',move_path:path.join(f.other,'moved')},diff:'rename'}]);assert.deepEqual(needed.map(p=>p.cwd),[f.extra,f.other]);
});
test('file approval outside allowed directory stays pending for directory confirmation',async t=>{
  const f=fixture(t);f.current();await f.b.notification({method:'item/started',params:{threadId:'t1',turnId:'turn1',item:{id:'i1',type:'fileChange',changes:[{path:path.join(f.extra,'new.txt'),kind:{type:'add'},diff:'+hello'}]}}});
  await f.b.serverRequest({id:2,method:'item/fileChange/requestApproval',params:{threadId:'t1',turnId:'turn1',itemId:'i1'}});await f.click(f.messages.at(-1));await f.click(f.messages.at(-1));const m=f.messages.findLast(m=>m.keyboard?.[0]?.[0]?.callback_data?.endsWith(':yes'));await f.click(m);assert.equal(f.rpc.replies[0].result.decision,'accept');
});
test('file symlink escape never suggests a broad replacement authorization',t=>{
  const f=fixture(t),alias=path.join(f.project,'escape');fs.symlinkSync(f.extra,alias);assert.throws(()=>requiredFileDirectories(f.config,f.project,[{path:'escape/new',kind:{type:'add'},diff:'+x'}]),/符号链接/);
});
test('protected command cwd is denied rather than offered authorization',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command(1,f.state));assert.equal(f.rpc.replies[0].result.decision,'decline');assert.ok(f.messages.every(m=>!m.keyboard));
});
test('root command cwd cannot be granted remotely',async t=>{
  const f=fixture(t);f.current();await f.b.serverRequest(f.command(1,'/'));assert.equal(f.rpc.replies[0].result.decision,'decline');assert.equal(f.saved.length,0);
});
test('remote root identity checked again immediately before command execution',async t=>{
  const f=fixture(t);await f.grant();f.current();await f.b.serverRequest(f.command());const m=f.messages.at(-1);fs.renameSync(f.extra,path.join(f.root,'moved'));fs.mkdirSync(f.extra);await f.click(m);assert.equal(f.rpc.replies[0].result.decision,'decline');
});
test('directory grant does not silently expand turn sandbox writable roots',async t=>{
  const f=fixture(t);await f.grant();f.b.selected=f.thread;await f.b.startTurn('work');const p=f.rpc.calls.find(c=>c.method==='turn/start').params;assert.deepEqual(p.sandboxPolicy.writableRoots,[f.project]);assert.equal(p.approvalPolicy,'untrusted');assert.equal(p.sandboxPolicy.networkAccess,false);
});
test('max ten directory confirmation items and max hundred stored grants',t=>{
  const f=fixture(t),proposal=remoteCandidate(f.extra,f.config);assert.throws(()=>f.b.grants.grant(Array(11).fill(proposal)),/10/);assert.throws(()=>new DirectoryGrants(f.config,{grants:Array(101).fill({})}),/100/);
});
test('authorizing parent of protected code folder fails even when that folder is not target',t=>{
  const f=fixture(t);f.config.protectedPaths.push(path.join(f.extra,'bridge-code'));assert.throws(()=>remoteCandidate(f.extra,f.config),/受保护/);
});
test('protected comparisons reject case aliases without case-folding allowlists',t=>{
  const f=fixture(t);for(const p of ['/sYsTeM/Library','/uSr/local',os.homedir()+'/.SSH',os.homedir()+'/.CoDeX',f.state.toUpperCase()]) assert.throws(()=>assertUnprotected(f.config,p),/受保护/);
  assert.throws(()=>remoteCandidate(os.homedir().toUpperCase(),f.config));
  const credential=path.join(f.extra,'.SSH');fs.mkdirSync(credential);assert.throws(()=>remoteCandidate(credential,f.config),/受保护/);
});
test('symlink followed by parent traversal is rejected before lexical normalization',t=>{
  const f=fixture(t),nested=path.join(f.extra,'nested');fs.mkdirSync(nested);fs.symlinkSync(nested,path.join(f.project,'link'));
  assert.throws(()=>requiredFileDirectories(f.config,f.project,[{path:'link/../secret.txt',kind:{type:'add'},diff:'+x'}]),/父目录跳转/);
  assert.throws(()=>remoteCandidate(f.project+'/link/..',f.config),/父目录跳转/);
  assert.throws(()=>allowedThread(f.config,{id:'alias',cwd:f.project+'/link/..'}),/父目录跳转/);
});
test('failed external session selection cannot send the next task to an older session',async t=>{
  const f=fixture(t);f.b.selected=f.thread;f.rpc.handler=()=>({thread:{...f.thread,id:'other-thread',cwd:f.extra}});
  await f.b.handle(f.message('/use other-thread'));await f.b.handle(f.message('run here'));
  assert.ok(!f.rpc.calls.some(c=>c.method==='turn/start'));assert.equal(f.b.previewed.id,'other-thread');
});
test('state serialization can remain separate from bot credentials',t=>{
  const f=fixture(t),configFile=path.join(f.state,'config.json'),grantsFile=path.join(f.state,'directories.json');writePrivateJson(configFile,{token:'synthetic-only'});const before=fs.readFileSync(configFile);
  const g=new DirectoryGrants(f.config,{saveGrants:grants=>writePrivateJson(grantsFile,{userId:123,chatId:123,grants})});g.grant([remoteCandidate(f.extra,f.config)]);
  assert.deepEqual(fs.readFileSync(configFile),before);assert.equal(fs.statSync(grantsFile).mode&0o777,0o600);assert.equal(readJson(grantsFile).grants.length,1);
});
