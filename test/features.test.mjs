import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/bridge.mjs';
import { ThreadCatalog } from '../src/threads.mjs';
import { ModelSettings } from '../src/models.mjs';

const fixtureRoot=path.dirname(fileURLToPath(import.meta.url));
const modelA={id:'catalog-a',model:'test-model-a',displayName:'Test A',hidden:false,isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Faster'},{reasoningEffort:'medium'},{reasoningEffort:'high'},{reasoningEffort:'ultra'}]};
const modelB={id:'catalog-b',model:'test-model-b',displayName:'Test B',hidden:false,isDefault:false,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]};
class MockRpc extends EventEmitter {
  calls=[];responses=[];
  async call(method,params){this.calls.push({method,params});return this.handler(method,params);}
  respond(id,result){this.responses.push({id,result});} reject(){}
}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(fixtureRoot,'.fixture-features-'));
  const project=path.join(root,'project'),nested=path.join(project,'nested'),outside=path.join(root,'project-sibling');
  fs.mkdirSync(nested,{recursive:true});fs.mkdirSync(outside);
  const config={userId:123,chatId:123,approvalTimeoutSeconds:600,projects:[{id:'p1',name:'Parent',cwd:project}]};
  const rpc=new MockRpc(),messages=[],saved=[];
  const tg={async say(chatId,text,keyboard){const m={message_id:messages.length+1,text,keyboard};messages.push(m);return m;},async ack(){},async clear(){}};
  const b=new Bridge(config,rpc,tg,{savePreferences:p=>{saved.push({...p});}});
  const thread={id:'thread-1',cwd:nested,model:'test-model-b',reasoningEffort:'low',historyMode:'legacy'};
  const message=text=>({message:{from:{id:123},chat:{id:123,type:'private'},text}});
  const callback=(m,data)=>({from:{id:123},message:{message_id:m.message_id,chat:{id:123,type:'private'}},id:'callback',data});
  rpc.handler=(method)=>method==='model/list'?{data:[modelA,modelB],nextCursor:null}:method==='thread/read'?{thread}:method==='thread/start'||method==='thread/resume'?{thread,model:thread.model,reasoningEffort:thread.reasoningEffort}:method==='turn/start'?{turn:{id:'turn-1'}}:{};
  t.after(()=>b.dispose());return {root,project,nested,outside,config,rpc,b,messages,saved,thread,message,callback};
}

test('recursive list includes root and descendants, excludes siblings and external roots',async t=>{
  const f=fixture(t),other={id:'other',name:'Other',cwd:f.outside};f.config.projects.push(other);
  f.rpc.handler=()=>({data:[{id:'parent',cwd:f.project},{id:'child',cwd:f.nested},{id:'sibling',cwd:f.outside},{id:'missing',cwd:path.join(f.project,'not-found')}],nextCursor:null});
  const page=await new ThreadCatalog(f.config,f.rpc).page(f.config.projects[0]);
  assert.deepEqual(page.threads.map(t=>t.id),['parent','child']);assert.equal(f.rpc.calls[0].params.cwd,undefined);
});
test('history navigation keeps overflow from a 100-item backend page',async t=>{
  const f=fixture(t);const data=Array.from({length:23},(_,i)=>({...f.thread,id:`t-${i}`}));f.rpc.handler=()=>({data,nextCursor:null});
  const catalog=new ThreadCatalog(f.config,f.rpc),a=await catalog.page(f.config.projects[0]),b=await catalog.page(f.config.projects[0],'',false,a.next),c=await catalog.page(f.config.projects[0],'',false,b.next);
  assert.deepEqual([a.threads.length,b.threads.length,c.threads.length],[8,8,7]);assert.equal(c.next,null);assert.equal(f.rpc.calls.length,1);
  assert.equal(new Set([...a.threads,...b.threads,...c.threads].map(t=>t.id)).size,23);assert.deepEqual([a.start,b.start,c.start],[0,8,16]);
});
test('backend excluded pages are skipped without declaring an empty result',async t=>{
  const f=fixture(t);f.rpc.handler=(_m,p)=>p.cursor===null?{data:[{id:'foreign',cwd:f.outside}],nextCursor:'p2'}:{data:[f.thread],nextCursor:null};
  const result=await new ThreadCatalog(f.config,f.rpc).page(f.config.projects[0],'query',true);assert.equal(result.threads.length,1);
  assert.equal(f.rpc.calls.length,2);assert.ok(f.rpc.calls.every(c=>c.params.archived&&c.params.searchTerm==='query'&&c.params.useStateDbOnly));
});
test('scan budget preserves cursor for explicit continuation',async t=>{
  const f=fixture(t);let n=0;f.rpc.handler=()=>({data:[],nextCursor:`p${++n}`});
  const catalog=new ThreadCatalog(f.config,f.rpc),a=await catalog.page(f.config.projects[0]);assert.equal(f.rpc.calls.length,10);assert.equal(a.threads.length,0);assert.ok(a.next);
  f.rpc.handler=()=>({data:[f.thread],nextCursor:null});const b=await catalog.page(f.config.projects[0],'',false,a.next);assert.equal(b.threads[0].id,'thread-1');assert.equal(f.rpc.calls.at(-1).params.cursor,'p10');
});
test('repeated backend cursor fails instead of looping forever',async t=>{
  const f=fixture(t);f.rpc.handler=()=>({data:[],nextCursor:'same'});await assert.rejects(new ThreadCatalog(f.config,f.rpc).page(f.config.projects[0]),/游标/);
});
test('repeated thread IDs across backend pages are deduplicated',async t=>{
  const f=fixture(t);f.rpc.handler=(_m,p)=>p.cursor===null?{data:[f.thread],nextCursor:'p2'}:{data:[f.thread,{...f.thread,id:'unique'}],nextCursor:null};
  const result=await new ThreadCatalog(f.config,f.rpc).page(f.config.projects[0]);assert.equal(result.threads.length,2);
});
test('history continuation cannot be reused under another project or search',async t=>{
  const f=fixture(t);f.rpc.handler=()=>({data:Array.from({length:10},(_,i)=>({...f.thread,id:`t${i}`})),nextCursor:null});const c=new ThreadCatalog(f.config,f.rpc),a=await c.page(f.config.projects[0]);
  await assert.rejects(c.page(f.config.projects[0],'changed',false,a.next),/条件已变化/);
});
test('buffered history paths are revalidated after symlink replacement',async t=>{
  const f=fixture(t),link=path.join(f.project,'alias');fs.symlinkSync(f.nested,link);
  f.rpc.handler=()=>({data:Array.from({length:10},(_,i)=>({...f.thread,cwd:link,id:`t${i}`})),nextCursor:null});const c=new ThreadCatalog(f.config,f.rpc),a=await c.page(f.config.projects[0]);
  // Remove only our synthetic symlink, never a user directory.
  fs.unlinkSync(link);fs.symlinkSync(f.outside,link);const b=await c.page(f.config.projects[0],'',false,a.next);assert.equal(b.threads.length,0);
});
test('model menu exposes account catalog and binds choice to correct model identifier',async t=>{
  const f=fixture(t);await f.b.handle(f.message('/model'));const m=f.messages.at(-1);assert.ok(m.text.includes('test-model-a'));assert.ok(!f.rpc.calls.some(c=>c.method==='turn/start'));
  const data=m.keyboard[0][0].callback_data;assert.ok(Buffer.byteLength(data)<=64);await f.b.callback(f.callback(m,data));assert.deepEqual(f.saved.at(-1),{model:'test-model-a',effort:'medium'});
});
test('direct commands select model and supported effort for new task',async t=>{
  const f=fixture(t);await f.b.handle(f.message('/model test-model-a'));await f.b.handle(f.message('/effort high'));await f.b.handle(f.message('/new run tests'));
  const start=f.rpc.calls.find(c=>c.method==='thread/start'),turn=f.rpc.calls.find(c=>c.method==='turn/start');assert.equal(start.params.model,'test-model-a');assert.equal(turn.params.model,'test-model-a');assert.equal(turn.params.effort,'high');assert.equal(turn.params.approvalPolicy,'untrusted');
});
test('saved preferences override resumed task, while metadata captures actual model',async t=>{
  const f=fixture(t);f.rpc.generation=1;f.rpc.start=async()=>{};await f.b.models.setModel('test-model-a');await f.b.models.setEffort('ultra');await f.b.resume('thread-1');await f.b.startTurn('continue');
  const resume=f.rpc.calls.find(c=>c.method==='thread/resume'),turn=f.rpc.calls.find(c=>c.method==='turn/start');assert.equal(resume.params.model,'test-model-a');assert.equal(turn.params.effort,'ultra');assert.equal(f.b.selected.reasoningEffort,'ultra');
});
test('without explicit preferences existing task model and effort are inherited',async t=>{
  const f=fixture(t);await f.b.resume('thread-1');await f.b.startTurn('continue');const turn=f.rpc.calls.find(c=>c.method==='turn/start');assert.equal(turn.params.model,undefined);assert.equal(turn.params.effort,undefined);assert.ok(!f.rpc.calls.some(c=>c.method==='model/list'));
});
test('choosing effort without model uses selected session model, not catalog default',async t=>{
  const f=fixture(t);f.b.selected=f.thread;await f.b.chooseEffort('low');assert.deepEqual(f.saved.at(-1),{model:'test-model-b',effort:'low'});
});
test('choosing effort on a new conversation pins actual catalog default',async t=>{
  const f=fixture(t);await f.b.chooseEffort('high');assert.deepEqual(f.saved.at(-1),{model:'test-model-a',effort:'high'});
});
test('invalid effort and model never change saved state',async t=>{
  const f=fixture(t);await f.b.chooseModel('test-model-b');const saved=JSON.stringify(f.saved);await assert.rejects(f.b.chooseEffort('high'),/不支持/);await assert.rejects(f.b.chooseModel('not-in-catalog'),/不在/);assert.equal(JSON.stringify(f.saved),saved);
});
test('switching models resets unsupported previous effort to new default',async t=>{
  const f=fixture(t);await f.b.chooseModel('test-model-a');await f.b.chooseEffort('ultra');await f.b.chooseModel('test-model-b');assert.deepEqual(f.b.models.choice,{model:'test-model-b',effort:'low'});
});
test('outdated effort buttons cannot apply to a different model',async t=>{
  const f=fixture(t);await f.b.chooseModel('test-model-a');await f.b.effortMenu();const m=f.messages.at(-1);await f.b.chooseModel('test-model-b');const saved=JSON.stringify(f.saved);
  await f.b.callback(f.callback(m,m.keyboard[0][0].callback_data));assert.equal(JSON.stringify(f.saved),saved);assert.ok(f.messages.at(-1).text.includes('模型已变化'));
});
test('running task prevents both model and effort changes',async t=>{
  const f=fixture(t);f.b.active={threadId:'thread-1',turnId:'turn-1'};await f.b.handle(f.message('/model test-model-a'));await f.b.handle(f.message('/effort high'));assert.equal(f.saved.length,0);assert.equal(f.rpc.calls.length,0);assert.ok(f.messages.at(-1).text.includes('仍在运行'));
});
test('model preferences survive restart without access to Bot Token storage',async t=>{
  const f=fixture(t);await f.b.chooseModel('test-model-a');await f.b.chooseEffort('high');const restored=new ModelSettings(f.rpc,{preferences:f.saved.at(-1)});assert.deepEqual(await restored.overrides(),{model:'test-model-a',effort:'high'});
});
test('preference save failure does not modify in-memory choice or start work',async t=>{
  const f=fixture(t),settings=new ModelSettings(f.rpc,{savePreferences:()=>{throw new Error('disk full');}});await assert.rejects(settings.setModel('test-model-a'),/disk full/);assert.deepEqual(settings.choice,{model:null,effort:null});
});
test('model reset clears overrides without claiming to undo server sticky configuration',async t=>{
  const f=fixture(t);await f.b.chooseModel('test-model-a');await f.b.chooseModel('default');assert.deepEqual(await f.b.models.overrides(),{});assert.ok(f.messages.at(-1).text.includes('不是恢复最初模型'));
});
test('model catalog follows pagination and hides hidden models',async t=>{
  const f=fixture(t);f.rpc.handler=(_m,p)=>p.cursor===null?{data:[modelA,{...modelB,hidden:true}],nextCursor:'p2'}:{data:[modelB],nextCursor:null};const s=new ModelSettings(f.rpc),models=await s.catalog();assert.deepEqual(models.map(m=>m.model),['test-model-a','test-model-b']);assert.equal(f.rpc.calls.length,2);assert.ok(f.rpc.calls.every(c=>c.params.includeHidden===false));
});
test('removed catalog model blocks next turn, never silently substitutes one',async t=>{
  const f=fixture(t);await f.b.chooseModel('test-model-a');f.b.models.cachedAt=0;f.rpc.handler=()=>({data:[modelB],nextCursor:null});f.b.selected=f.thread;await assert.rejects(f.b.startTurn('run'),/当前不可用/);assert.equal(f.b.active,null);assert.ok(!f.rpc.calls.some(c=>c.method==='turn/start'));
});
test('unauthorized user cannot modify generation settings',async t=>{
  const f=fixture(t);await f.b.handle({message:{from:{id:999},chat:{id:123,type:'private'},text:'/model test-model-a'}});assert.equal(f.saved.length,0);assert.equal(f.rpc.calls.length,0);
});
