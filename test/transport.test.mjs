import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexRpc } from '../src/codex.mjs';
import { Telegram } from '../src/telegram.mjs';

function mockProcess() {
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=[];
  child.kill=signal=>{child.killed.push(signal);queueMicrotask(()=>child.emit('exit',null,signal));return true;};return child;
}
async function connected(t,{timeoutMs=1000}={}) {
  const child=mockProcess(),sent=[];
  child.stdin.on('data',data=>{
    for(const line of data.toString().trim().split('\n')) {
      const message=JSON.parse(line);sent.push(message);
      if(message.method==='initialize') queueMicrotask(()=>child.stdout.write(JSON.stringify({id:message.id,result:{userAgent:'mock-codex'}})+'\n'));
    }
  });
  let invocation;
  const rpc=new CodexRpc({codexPath:'/mock/codex',codexHome:'/mock/home'},{timeoutMs,spawnFn:(...args)=>{invocation=args;return child;}});
  rpc.on('fatal',()=>{});t.after(()=>rpc.close());
  await rpc.start();return {rpc,child,sent,invocation};
}
test('Codex handshake is bidirectional JSONL with managed network and no exposed port',async t=>{
  const f=await connected(t);assert.equal(f.invocation[2].shell,false);assert.deepEqual(f.invocation[1],['app-server','--enable','network_proxy','--listen','stdio://']);
  assert.equal(f.invocation[2].env.CODEX_HOME,'/mock/home');assert.equal(f.sent[0].method,'initialize');assert.equal(f.sent[1].method,'initialized');assert.equal(f.sent[0].jsonrpc,undefined);
  assert.equal(f.sent[0].params.capabilities.mcpServerOpenaiFormElicitation,true);
});
test('out-of-order RPC results match their request IDs',async t=>{
  const f=await connected(t);const one=f.rpc.call('thread/read',{threadId:'a'}),two=f.rpc.call('thread/read',{threadId:'b'});
  const [a,b]=f.sent.slice(-2);f.child.stdout.write(JSON.stringify({id:b.id,result:{name:'B'}})+'\n'+JSON.stringify({id:a.id,result:{name:'A'}})+'\n');
  assert.deepEqual(await one,{name:'A'});assert.deepEqual(await two,{name:'B'});
});
test('split multibyte UTF-8 notifications decode without corruption',async t=>{
  const f=await connected(t);let received;f.rpc.on('notification',m=>{received=m;});
  const data=Buffer.from(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'中文内容'}})+'\n');
  const at=data.indexOf(Buffer.from('中'))+1;f.child.stdout.write(data.subarray(0,at));f.child.stdout.write(data.subarray(at));assert.equal(received.params.delta,'中文内容');
});
test('server approval requests route separately from regular responses',async t=>{
  const f=await connected(t);let request;f.rpc.on('request',m=>{request=m;});f.child.stdout.write(JSON.stringify({id:100,method:'item/commandExecution/requestApproval',params:{command:'git status'}})+'\n');
  assert.equal(request.id,100);f.rpc.respond(100,{decision:'decline'});assert.deepEqual(f.sent.at(-1),{id:100,result:{decision:'decline'}});
});
test('invalid JSON closes the connection and rejects pending work',async t=>{
  const f=await connected(t);const pending=f.rpc.call('turn/start',{});const rejected=assert.rejects(pending,/无效 JSON/);f.child.stdout.write('not json\n');await rejected;assert.equal(f.rpc.closed,true);assert.deepEqual(f.child.killed,['SIGTERM']);
});
test('RPC timeout never automatically retries a potentially started turn',async t=>{
  const f=await connected(t,{timeoutMs:20});await assert.rejects(f.rpc.call('turn/start',{}),/超时/);assert.equal(f.sent.filter(m=>m.method==='turn/start').length,1);assert.equal(f.rpc.closed,true);
});
test('child exit rejects pending calls without retries',async t=>{
  const f=await connected(t);const pending=f.rpc.call('thread/resume',{});const rejected=assert.rejects(pending,/连接已结束/);f.child.emit('exit',1,null);await rejected;assert.equal(f.rpc.pending.size,0);
});
function autoChild(log,{exitOnKill=true}={}) {
  const child=mockProcess();
  if(!exitOnKill) child.kill=signal=>{child.killed.push(signal);return true;};
  child.stdin.on('data',data=>{
    for(const line of data.toString().trim().split('\n')) {
      const message=JSON.parse(line);log.push(message);
      if(!Object.hasOwn(message,'id')) continue;
      const result=message.method==='initialize'?{userAgent:'mock-codex'}:{method:message.method};
      queueMicrotask(()=>child.stdout.write(`${JSON.stringify({id:message.id,result})}\n`));
    }
  });
  return child;
}
test('intentional close releases the worker and the next call starts a fresh generation',async()=>{
  const logs=[],children=[],fatals=[];
  const rpc=new CodexRpc({codexPath:'/mock/codex',codexHome:'/mock/home'},{spawnFn:()=>{const log=[];logs.push(log);const child=autoChild(log);children.push(child);return child;}});
  rpc.on('fatal',error=>fatals.push(error));
  await rpc.start();assert.equal(rpc.generation,1);await rpc.close();assert.equal(rpc.isRunning,false);
  assert.deepEqual(await rpc.call('thread/read',{}),{method:'thread/read'});
  assert.equal(rpc.generation,2);assert.equal(children.length,2);assert.equal(fatals.length,0);
  await rpc.shutdown();
});
test('concurrent cold calls share one worker and one initialize handshake',async()=>{
  const log=[];let spawns=0;const rpc=new CodexRpc({codexPath:'/mock/codex',codexHome:'/mock/home'},{spawnFn:()=>{spawns++;return autoChild(log);}});
  rpc.on('fatal',()=>{});
  const results=await Promise.all([rpc.call('thread/read',{}),rpc.call('model/list',{}),rpc.call('thread/list',{})]);
  assert.equal(spawns,1);assert.equal(log.filter(message=>message.method==='initialize').length,1);
  assert.deepEqual(results.map(result=>result.method),['thread/read','model/list','thread/list']);await rpc.shutdown();
});
test('a late exit from a released worker cannot tear down its replacement',async()=>{
  const logs=[],children=[];const rpc=new CodexRpc({codexPath:'/mock/codex',codexHome:'/mock/home'},{closeTimeoutMs:20,spawnFn:()=>{const log=[];logs.push(log);const child=autoChild(log,{exitOnKill:children.length>0});children.push(child);return child;}});
  rpc.on('fatal',()=>{});await rpc.start();const old=children[0];await rpc.close();
  assert.deepEqual(await rpc.call('thread/read',{}),{method:'thread/read'});old.emit('exit',0,'SIGTERM');
  assert.equal(rpc.isRunning,true);assert.equal(rpc.generation,2);assert.equal(children.length,2);await rpc.shutdown();
});
test('permanent shutdown cannot be undone by a later RPC call',async()=>{
  const log=[];const rpc=new CodexRpc({codexPath:'/mock/codex',codexHome:'/mock/home'},{spawnFn:()=>autoChild(log)});rpc.on('fatal',()=>{});
  await rpc.start();await rpc.shutdown();await assert.rejects(rpc.call('thread/read',{}),/永久关闭/);
  assert.equal(log.filter(message=>message.method==='initialize').length,1);
});
test('Telegram send splits long plain text and attaches buttons only at end',async()=>{
  const requests=[];const tg=new Telegram('dummy',{fetchFn:async(url,options)=>{requests.push({url,params:JSON.parse(options.body)});return {ok:true,json:async()=>({ok:true,result:{message_id:requests.length}})};}});
  await tg.say(123,'x'.repeat(8000),[[{text:'Approve',callback_data:'one'}]]);assert.equal(requests.length,3);
  assert.equal(requests[0].params.reply_markup,undefined);assert.ok(requests[2].params.reply_markup);assert.ok(requests.every(x=>!x.params.parse_mode));
});
test('Telegram transport errors cannot leak a token even if fetch throws its URL',async()=>{
  const token='123456:THIS_IS_A_DUMMY_TOKEN_NOT_REAL';const tg=new Telegram(token,{fetchFn:async url=>{throw new Error(url);}});
  await assert.rejects(tg.call('getMe'),e=>!e.message.includes(token)&&e.message.includes('网络请求失败'));
});
test('polling uses positive timeout and callback updates',async()=>{
  let params;const tg=new Telegram('dummy',{fetchFn:async(_url,options)=>{params=JSON.parse(options.body);return {ok:true,json:async()=>({ok:true,result:[]})};}});
  await tg.updates(50);assert.equal(params.offset,50);assert.equal(params.timeout,10);assert.ok(params.allowed_updates.includes('callback_query'));
});
test('network diagnostics retain only known error codes, never raw URLs or secrets',async()=>{
  const token='123456:THIS_IS_A_DUMMY_TOKEN_NOT_REAL';
  const tg=new Telegram(token,{fetchFn:async url=>{const e=new Error(url);e.cause={code:'ECONNRESET',message:url};throw e;}});
  await assert.rejects(tg.call('getUpdates'),e=>e.networkCode==='ECONNRESET' && !e.message.includes(token));
  const other=new Telegram(token,{fetchFn:async()=>{const e=new Error(token);e.cause={code:token};throw e;}});
  await assert.rejects(other.call('getUpdates'),e=>e.networkCode==='NETWORK_ERROR' && !e.message.includes(token));
});
test('request timeout is distinguished from DNS or connection reset',async()=>{
  const tg=new Telegram('dummy',{fetchFn:async()=>{throw new DOMException('sensitive upstream text','TimeoutError');}});
  await assert.rejects(tg.call('getUpdates'),e=>e.networkCode==='TIMEOUT' && !e.message.includes('sensitive'));
});
test('Telegram 409 conflicts remain distinguishable and never retried by sender',async()=>{
  let count=0;const tg=new Telegram('dummy',{fetchFn:async()=>{count++;return {ok:false,status:409,json:async()=>({ok:false,error_code:409,description:'Conflict'})};}});
  await assert.rejects(tg.call('getUpdates'),e=>e.code===409);assert.equal(count,1);
});
