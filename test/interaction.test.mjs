import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {Bridge} from '../src/bridge.mjs';
import {Telegram} from '../src/telegram.mjs';
import {markdownBlocks,markdownMessages,inlineEntities} from '../src/format.mjs';

const cwd=path.dirname(fileURLToPath(import.meta.url));
class MockRpc extends EventEmitter {
  calls=[];replies=[];
  async call(method,params){this.calls.push({method,params});return this.handler(method,params);}
  respond(id,result){this.replies.push({id,result});} reject(id){this.replies.push({id,error:true});}
}
function fixture(t){
  const config={userId:123,chatId:123,projects:[{id:'p1',name:'Test',cwd}],approvalTimeoutSeconds:600};
  const thread={id:'t1',name:'Example',cwd,historyMode:'legacy',status:{type:'idle'},turns:[{items:[{type:'userMessage',content:[{type:'text',text:'question'}]},{type:'agentMessage',text:'answer\n```sh\npwd\n```'}]}]};
  const rpc=new MockRpc(),messages=[],richCalls=[],clears=[],diagnostics=[];
  const tg={async say(_id,text,keyboard){const message={message_id:messages.length+1,text,keyboard};messages.push(message);return message;},async rich(_id,text){richCalls.push(text);return this.say(_id,text);},async ack(){},async clear(_chat,id){clears.push(id);}};
  rpc.handler=(method,p)=>method==='thread/list'?{data:[thread],nextCursor:null}:method==='turn/start'?{turn:{id:'turn1'}}:{thread:{...thread,id:p.threadId||thread.id}};
  const b=new Bridge(config,rpc,tg,{diagnostic:(kind,e)=>diagnostics.push(kind)});
  const message=text=>({message:{from:{id:123},chat:{id:123,type:'private'},text}});
  const cb=(m,data,user=123)=>({id:'callback',from:{id:user},message:{message_id:m.message_id,chat:{id:123,type:'private'}},data});
  t.after(()=>b.dispose());return {config,thread,rpc,tg,b,messages,richCalls,clears,diagnostics,message,cb};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('history preview stays read-only and offers explicit connection',async t=>{
  const f=fixture(t);await f.b.history('t1');assert.equal(f.b.selected,null);assert.equal(f.b.previewed.id,'t1');
  assert.equal(f.messages.at(-1).keyboard[0][0].text,'选择此会话');assert.ok(!f.rpc.calls.some(c=>c.method==='thread/resume'||c.method==='turn/start'));
});
test('text after preview prompts connection, never executes or queues old text',async t=>{
  const f=fixture(t);await f.b.history('t1');await f.b.handle(f.message('do work'));
  assert.ok(f.messages.at(-1).text.includes('没有排队'));assert.ok(!f.rpc.calls.some(c=>c.method==='turn/start'));
  let m=f.messages.at(-1);await f.b.callback(f.cb(m,m.keyboard[0][0].callback_data));
  assert.ok(!f.rpc.calls.some(c=>c.method==='thread/resume'));m=f.messages.at(-1);await f.b.callback(f.cb(m,m.keyboard[0][0].callback_data));
  assert.equal(f.b.selected.id,'t1');assert.equal(f.b.previewed,null);assert.ok(!f.rpc.calls.some(c=>c.method==='turn/start'));
  await f.b.handle(f.message('do work now'));assert.equal(f.rpc.calls.filter(c=>c.method==='turn/start').length,1);
});
test('preview B does not send the next message to connected conversation A',async t=>{
  const f=fixture(t);f.b.selected={...f.thread,id:'A'};await f.b.history('B');await f.b.handle(f.message('continue B'));
  assert.equal(f.b.selected.id,'A');assert.ok(!f.rpc.calls.some(c=>c.method==='turn/start'));assert.ok(f.messages.at(-1).text.includes('尚未选择'));
});
test('preview of selected conversation allows ordinary continuation',async t=>{
  const f=fixture(t);f.b.selected=f.thread;await f.b.history('t1');await f.b.handle(f.message('continue'));assert.equal(f.rpc.calls.at(-1).method,'turn/start');
});
test('no selected conversation produces actionable response not silent rejection',async t=>{
  const f=fixture(t);await f.b.handle(f.message('hello'));assert.ok(f.messages.at(-1).text.includes('没有选择'));assert.ok(f.messages.at(-1).keyboard);assert.equal(f.rpc.calls.length,0);
});
test('archived preview never connects or sends text to an old active selection',async t=>{
  const f=fixture(t);f.b.selected=f.thread;await f.b.history('t1',{readOnly:true});assert.equal(f.messages.at(-1).keyboard,undefined);
  await f.b.handle(f.message('continue'));assert.ok(f.messages.at(-1).text.includes('归档'));assert.ok(!f.rpc.calls.some(c=>c.method==='turn/start'));
});
test('viewing history retains the original list navigation buttons',async t=>{
  const f=fixture(t);await f.b.list();const list=f.messages.at(-1),key=list.keyboard[0][0].callback_data;
  await f.b.callback(f.cb(list,key));await tick();assert.equal(f.clears.length,0);assert.ok(f.b.buttons.has(key.slice(2)));
});
test('failed callback spinner acknowledgement cannot discard a valid resume click',async t=>{
  const f=fixture(t);await f.b.offerResume('t1');const m=f.messages.at(-1);f.tg.ack=async()=>{throw new Error('network');};
  await f.b.callback(f.cb(m,m.keyboard[0][0].callback_data));await tick();assert.equal(f.b.selected.id,'t1');assert.ok(f.diagnostics.includes('callback-ack-failed'));
});
test('stalled callback ack does not block received authorized actions',async t=>{
  const f=fixture(t);await f.b.offerResume('t1');const m=f.messages.at(-1);f.tg.ack=()=>new Promise(()=>{});
  await f.b.callback(f.cb(m,m.keyboard[0][0].callback_data));assert.equal(f.b.selected.id,'t1');
});
test('failed keyboard cleanup does not prevent resume nor create duplicate action',async t=>{
  const f=fixture(t);await f.b.offerResume('t1');const m=f.messages.at(-1),data=m.keyboard[0][0].callback_data;f.tg.clear=async()=>{throw new Error('network');};
  await f.b.callback(f.cb(m,data));await f.b.callback(f.cb(m,data));await tick();assert.equal(f.rpc.calls.filter(c=>c.method==='thread/read').length,2);assert.equal(f.b.selected.id,'t1');assert.ok(f.diagnostics.includes('keyboard-clear-failed'));
});
test('unauthorized callbacks remain denied even when ack fails',async t=>{
  const f=fixture(t);await f.b.offerResume('t1');const m=f.messages.at(-1);f.tg.ack=async()=>{throw new Error('offline');};
  await f.b.callback(f.cb(m,m.keyboard[0][0].callback_data,999));assert.equal(f.b.selected,null);
});
test('state-changing button remains usable after busy rejection',async t=>{
  const f=fixture(t);await f.b.offerResume('t1');const m=f.messages.at(-1),data=m.keyboard[0][0].callback_data;
  f.b.active={threadId:'old',turnId:'busy'};await f.b.callback(f.cb(m,data));assert.ok(f.b.buttons.has(data.slice(2)));
  f.b.active=null;await f.b.callback(f.cb(m,data));assert.equal(f.b.selected.id,'t1');
});
test('status distinguishes preview from connected conversation',async t=>{
  const f=fixture(t);await f.b.history('t1');await f.b.handle(f.message('/status'));const text=f.messages.at(-1).text;assert.ok(text.includes('未选择'));assert.ok(text.includes('正在预览：t1'));
});
test('failure to deliver an error is reported locally without an uncaught rejection',async t=>{
  const f=fixture(t);f.tg.say=async()=>{throw new Error('offline');};await f.b.report(new Error('private prompt'));assert.deepEqual(f.diagnostics,['operation-failed','error-message-undelivered']);
});
test('history renders each message independently, fences cannot cross speaker boundaries',async t=>{
  const f=fixture(t);f.thread.turns=[{items:[{type:'userMessage',content:[{type:'text',text:'```sh\nprintf **KEEP**\n'}]},{type:'agentMessage',text:'end\n```'}]}];
  await f.b.history('t1');assert.equal(f.richCalls.length,2);assert.ok(!f.richCalls[0].includes('end'));assert.equal(markdownMessages(f.richCalls[0]).some(m=>m.reply_markup),false);
});
test('truncated history is explicitly marked and not rich-rendered as executable code',async t=>{
  const f=fixture(t);f.thread.turns=[{items:[{type:'agentMessage',text:'```sh\n'+'x'.repeat(17000)+'\n```'}]}];
  await f.b.history('t1');assert.equal(f.richCalls.length,0);assert.ok(f.messages.some(m=>m.text.includes('截断预览')));
});
test('normal assistant messages use rich output while approvals remain literal',async t=>{
  const f=fixture(t);f.b.managed.set('t1',f.thread);f.b.active={threadId:'t1',turnId:'turn1'};
  await f.b.notification({method:'item/completed',params:{threadId:'t1',turnId:'turn1',item:{type:'agentMessage',text:'```sh\npwd\n```'}}});
  assert.equal(f.richCalls.length,1);
  await f.b.serverRequest({id:7,method:'item/commandExecution/requestApproval',params:{threadId:'t1',turnId:'turn1',itemId:'i',cwd,command:'printf "**literal**"'}});
  assert.equal(f.richCalls.length,1);assert.ok(f.messages.at(-1).text.includes('**literal**'));assert.ok(f.messages.at(-1).keyboard[0][0].callback_data.startsWith('a:'));
});
test('callback ack failure never causes repeated approval response',async t=>{
  const f=fixture(t);f.b.managed.set('t1',f.thread);f.b.active={threadId:'t1',turnId:'turn1'};
  await f.b.serverRequest({id:8,method:'item/commandExecution/requestApproval',params:{threadId:'t1',turnId:'turn1',itemId:'i',cwd,command:'pwd'}});
  const m=f.messages.at(-1),data=m.keyboard[0][0].callback_data;f.tg.ack=async()=>{throw new Error('offline');};
  await f.b.callback(f.cb(m,data));await f.b.callback(f.cb(m,data));assert.deepEqual(f.rpc.replies,[{id:8,result:{decision:'accept'}}]);
});

test('fenced code yields standalone pre entity and exact native copy text',()=>{
  const messages=markdownMessages('Explain\n```bash\nprintf "hello"\n```\nDone');const code=messages.find(m=>m.entities.some(e=>e.type==='pre'));
  assert.equal(code.text,'printf "hello"\n');assert.deepEqual(code.entities,[{type:'pre',offset:0,length:15,language:'bash'}]);assert.equal(code.reply_markup.inline_keyboard[0][0].copy_text.text,code.text);
});
test('literal HTML, ampersands and numeric entities are not decoded or interpreted',()=>{
  const raw='<tag>&#39; &amp; >\n';const messages=markdownMessages('```html\n'+raw+'```');const code=messages.find(m=>m.entities.some(e=>e.type==='pre'));
  assert.equal(code.text,raw);assert.ok(messages.some(m=>m.text.includes('未自动改写')));assert.ok(messages.every(m=>!m.parse_mode));
});
test('entity offsets use UTF16 units after astral Unicode',()=>{
  const r=inlineEntities('𠀀 **bold** and `code`');assert.equal(r.text,'𠀀 bold and code');assert.deepEqual(r.entities,[{type:'bold',offset:3,length:4},{type:'code',offset:12,length:4}]);
});
test('long intact code block uses pre formatting but no invalid >256 copy_text button',()=>{
  const code='x'.repeat(300)+'\n';const m=markdownMessages('```\n'+code+'```').find(m=>m.entities.some(e=>e.type==='pre'));assert.equal(m.text,code);assert.equal(m.reply_markup,undefined);
});
test('split code preserves contents and no final fragment gets one-click copy',()=>{
  const code='x'.repeat(3600)+'\n';const messages=markdownMessages('```sh\n'+code+'```');const parts=messages.filter(m=>m.entities.some(e=>e.type==='pre'));
  assert.equal(parts.length,2);assert.equal(parts.map(p=>p.text).join(''),code);assert.ok(parts.every(p=>!p.reply_markup));assert.ok(messages.some(m=>m.text.includes('勿单独执行')));
});
test('unclosed fences remain literal, including Markdown characters',()=>{
  const raw='```sh\nprintf **KEEP** `literal`\n';assert.deepEqual(markdownBlocks(raw),[{type:'literal',text:raw}]);const messages=markdownMessages(raw);assert.equal(messages.map(m=>m.text).join(''),raw);assert.ok(messages.every(m=>!m.reply_markup&&m.entities.length===0));
});
test('tilde and longer fences preserve embedded shorter backticks',()=>{
  const code='```inside```\n';const blocks=markdownBlocks('~~~~md\n'+code+'~~~~');assert.deepEqual(blocks,[{type:'code',language:'md',text:code}]);
});
test('mismatched closing fence is not treated as complete code',()=>{
  const raw='```sh\npwd\n~~~';const blocks=markdownBlocks(raw);assert.equal(blocks[0].type,'literal');assert.equal(blocks[0].text,raw);
});
test('CRLF code content and indentation remain exact',()=>{
  const raw='  line1\r\n\tline2\r\n';const code=markdownMessages('```text\r\n'+raw+'```\r\n').find(m=>m.entities.some(e=>e.type==='pre'));assert.equal(code.text,raw);
});
test('multiple independent code blocks each get their own message',()=>{
  const m=markdownMessages('```sh\npwd\n```\nnext\n```python\nprint(1)\n```');const codes=m.filter(x=>x.entities.some(e=>e.type==='pre'));assert.equal(codes.length,2);assert.ok(codes.every(x=>x.reply_markup));
});
test('very many Markdown blocks fall back to complete literal text without flood',()=>{
  const raw='```sh\npwd\n```\n'.repeat(30);const m=markdownMessages(raw);assert.equal(m.map(x=>x.text).join(''),raw);assert.ok(m.every(x=>!x.reply_markup));assert.ok(m.length<40);
});
test('short copy cutoff conservatively counts UTF16, not UTF8 bytes',()=>{
  const raw='𠀀'.repeat(127)+'\n';const m=markdownMessages('```\n'+raw+'```').find(x=>x.entities.some(e=>e.type==='pre'));assert.ok(m.reply_markup);assert.equal(m.entities[0].length,255);
});

function telegramMock(respond){
  const sent=[];const tg=new Telegram('synthetic-token',{fetchFn:async(url,opts)=>{const params=JSON.parse(opts.body);sent.push({url,params});return respond?respond(params,sent.length):{ok:true,json:async()=>({ok:true,result:{message_id:sent.length}})};}});return {tg,sent};
}
test('rich transport sends entities not HTML and literal code copy payload',async()=>{
  const {tg,sent}=telegramMock();await tg.rich(123,'Before\n```sh\nprintf "<>&"\n```');const m=sent.find(x=>x.params.entities.some(e=>e.type==='pre')).params;assert.equal(m.text,'printf "<>&"\n');assert.equal(m.reply_markup.inline_keyboard[0][0].copy_text.text,m.text);assert.equal(m.parse_mode,undefined);
});
test('explicit copy button rejection falls back once without copy button',async()=>{
  const {tg,sent}=telegramMock(p=>p.reply_markup?{ok:false,status:400,json:async()=>({ok:false,error_code:400})}:{ok:true,json:async()=>({ok:true,result:{message_id:10}})});
  await tg.rich(123,'```sh\npwd\n```');const code=sent.filter(s=>s.params.text==='pwd\n');assert.equal(code.length,2);assert.ok(code[0].params.reply_markup);assert.equal(code[1].params.reply_markup,undefined);assert.deepEqual(code[0].params.entities,code[1].params.entities);
});
test('ambiguous rich send failure is not automatically retried',async()=>{
  let sent=0;const tg=new Telegram('dummy',{fetchFn:async()=>{sent++;throw new Error('offline');}});await assert.rejects(tg.rich(123,'```sh\npwd\n```'));assert.equal(sent,1);
});
test('raw say path preserves Markdown and does not install copy buttons on approvals',async()=>{
  const {tg,sent}=telegramMock();const raw='```sh\npwd\n```';await tg.say(123,raw,[[{text:'Allow',callback_data:'a:1:yes'}]]);assert.equal(sent[0].params.text,raw);assert.equal(sent[0].params.entities,undefined);assert.equal(sent[0].params.reply_markup.inline_keyboard[0][0].callback_data,'a:1:yes');
});
