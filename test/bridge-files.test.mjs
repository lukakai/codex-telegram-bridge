import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/bridge.mjs';

const testDir=path.dirname(fileURLToPath(import.meta.url));

class MockRpc extends EventEmitter {
  calls=[];
  async call(method,params) {
    this.calls.push({method,params});
    if(method==='turn/start') return {turn:{id:'turn-1'}};
    return {};
  }
  respond() {}
  reject() {}
}

class MockTelegram {
  messages=[];documents=[];photos=[];downloads=[];
  async say(_chatId,text,keyboard) {
    const message={message_id:this.messages.length+1,text,keyboard};
    this.messages.push(message);return message;
  }
  async download(fileId,options) {
    this.downloads.push({fileId,options});
    return this.downloadBytes??Buffer.from('attachment bytes');
  }
  async sendDocument(chatId,file) {this.documents.push({chatId,...file});}
  async sendPhoto(chatId,file) {this.photos.push({chatId,...file});}
  async clear() {}
  async ack() {}
}

function fixture(t,{nested=false}={}) {
  const root=fs.mkdtempSync(path.join(testDir,'.fixture-bridge-files-'));
  const project=path.join(root,'project');fs.mkdirSync(project);
  const cwd=nested?path.join(project,'nested'):project;
  if(nested) fs.mkdirSync(cwd);
  const config={
    token:'123456:THIS_IS_A_DUMMY_TOKEN_NOT_REAL',userId:123,chatId:123,
    projects:[{id:'p1',name:'Project',cwd:fs.realpathSync(project)}],
    approvalTimeoutSeconds:600,protectedPaths:[]
  };
  const rpc=new MockRpc(),tg=new MockTelegram();
  const bridge=new Bridge(config,rpc,tg);
  const thread={id:'thread-1',cwd:fs.realpathSync(cwd),name:'Files'};
  bridge.selected=thread;bridge.managed.set(thread.id,thread);
  t.after(()=>bridge.dispose());
  return {bridge,rpc,tg,config,thread,root,project,cwd};
}

function telegramMessage(body) {
  return {message:{from:{id:123},chat:{id:123,type:'private'},...body}};
}

test('Telegram document uses a model-readable path with a UI filename placeholder',async t=>{
  const f=fixture(t);
  await f.bridge.handle(telegramMessage({
    caption:'总结这份文件',
    document:{file_id:'opaque-file-id',file_name:'notes.xyz',file_size:16,mime_type:'application/x-custom'}
  }));

  assert.deepEqual(f.tg.downloads,[{fileId:'opaque-file-id',options:{maxBytes:20_000_000}}]);
  const turn=f.rpc.calls.find(call=>call.method==='turn/start');
  assert.equal(turn.params.input.length,1);
  const input=turn.params.input[0];
  assert.equal(input.type,'text');
  assert.ok(input.text.startsWith('总结这份文件\n\n文件：'));
  const savedPath=input.text.slice(input.text.indexOf('文件：')+'文件：'.length);
  assert.ok(path.isAbsolute(savedPath));
  assert.ok(savedPath.startsWith(`${f.cwd}${path.sep}`));
  assert.deepEqual(fs.readFileSync(savedPath),Buffer.from('attachment bytes'));
  assert.deepEqual(input.text_elements,[{
    byteRange:{
      start:Buffer.byteLength('总结这份文件\n\n文件：'),
      end:Buffer.byteLength(input.text)
    },
    placeholder:'📎 notes.xyz'
  }]);
  assert.ok(!turn.params.input.some(item=>item.type==='mention'));
  assert.equal(f.bridge.active.turnId,'turn-1');
});

test('document without a caption still references the saved opaque file',async t=>{
  const f=fixture(t);
  await f.bridge.handle(telegramMessage({
    document:{file_id:'archive-id',file_name:'sample.bin',file_size:16}
  }));
  const input=f.rpc.calls.find(call=>call.method==='turn/start').params.input;
  assert.equal(input.length,1);
  assert.ok(input[0].text.startsWith('请查看这个文件。\n\n文件：'));
  assert.equal(input[0].text_elements[0].placeholder,'📎 sample.bin');
  assert.ok(!input.some(item=>item.type==='mention'));
});

test('desktop-only file citations and followups render cleanly in Telegram',async t=>{
  const f=fixture(t);
  await f.bridge.handle(telegramMessage({
    caption:'总结这份文件',
    document:{file_id:'sheet-id',file_name:'礼品明细.xlsx',file_size:16,mime_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
  }));
  const input=f.rpc.calls.find(call=>call.method==='turn/start').params.input[0];
  const savedPath=input.text.slice(input.text.indexOf('文件：')+'文件：'.length);

  await f.bridge.notification({method:'item/completed',params:{
    threadId:f.thread.id,turnId:'turn-1',item:{type:'agentMessage',text:[
      `共 10 行、2 列。 :codex-file-citation{path="${savedPath}" purpose="source" artifact_kind="workbook" sheet="Sheet1" range="A1:B10"}`,
      '',
      '- :codex-followup[整理联系人表]{prompt="不应原样显示的内部提示"}',
      '- :codex-followup[检查名单]{prompt="也不应显示"}'
    ].join('\n')}
  }});

  const displayed=f.tg.messages.at(-1).text;
  assert.ok(displayed.includes('共 10 行、2 列。'));
  assert.ok(displayed.includes('📎 来源：礼品明细.xlsx · Sheet1!A1:B10'));
  assert.ok(displayed.includes('可继续：整理联系人表；检查名单'));
  assert.ok(!displayed.includes(savedPath));
  assert.ok(!displayed.includes('codex-file-citation'));
  assert.ok(!displayed.includes('codex-followup'));
  assert.ok(!displayed.includes('内部提示'));
});

test('oversized Telegram metadata is rejected before download or turn start',async t=>{
  const f=fixture(t);
  await f.bridge.handle(telegramMessage({
    document:{file_id:'large-id',file_name:'large.bin',file_size:20_000_001}
  }));
  assert.equal(f.tg.downloads.length,0);
  assert.ok(!f.rpc.calls.some(call=>call.method==='turn/start'));
  assert.ok(f.tg.messages.at(-1).text.includes('20 MB'));
});

test('real fileChange changes are sent from the selected thread cwd on completion',async t=>{
  const f=fixture(t,{nested:true});
  fs.writeFileSync(path.join(f.cwd,'result.bin'),Buffer.from('final bytes'),{flag:'wx'});
  f.bridge.active={threadId:f.thread.id,turnId:'turn-1'};

  await f.bridge.notification({method:'item/completed',params:{
    threadId:f.thread.id,turnId:'turn-1',
    item:{id:'files-1',type:'fileChange',status:'completed',changes:[
      {path:'result.bin',kind:{type:'add'},diff:'+final bytes'}
    ]}
  }});
  assert.equal(f.tg.documents.length,0);

  await f.bridge.notification({method:'turn/completed',params:{
    threadId:f.thread.id,turn:{id:'turn-1',status:'completed'}
  }});
  assert.equal(f.tg.documents.length,1);
  assert.equal(f.tg.documents[0].name,'result.bin');
  assert.equal(f.tg.documents[0].mime,'application/octet-stream');
  assert.deepEqual(f.tg.documents[0].bytes,Buffer.from('final bytes'));
});

test('multiple updates send only the final file and deleted files are omitted',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.cwd,'latest.txt'),'latest',{flag:'wx'});
  fs.writeFileSync(path.join(f.cwd,'deleted.txt'),'old',{flag:'wx'});
  f.bridge.active={threadId:f.thread.id,turnId:'turn-1'};

  for(const changes of [
    [{path:'latest.txt',kind:{type:'add'},diff:'+first'},{path:'deleted.txt',kind:{type:'add'},diff:'+old'}],
    [{path:'latest.txt',kind:{type:'update',move_path:null},diff:'+latest'},{path:'deleted.txt',kind:{type:'delete'},diff:'-old'}]
  ]) await f.bridge.notification({method:'item/completed',params:{
    threadId:f.thread.id,turnId:'turn-1',item:{id:'files',type:'fileChange',status:'completed',changes}
  }});

  await f.bridge.notification({method:'turn/completed',params:{
    threadId:f.thread.id,turn:{id:'turn-1',status:'completed'}
  }});
  assert.deepEqual(f.tg.documents.map(file=>file.name),['latest.txt']);
});

test('changed image is sent as a Telegram photo and unsafe paths are not exported',async t=>{
  const f=fixture(t);
  const png=Buffer.from('89504e470d0a1a0a00000000','hex');
  fs.writeFileSync(path.join(f.cwd,'preview.png'),png,{flag:'wx'});
  fs.writeFileSync(path.join(f.root,'outside.txt'),'private',{flag:'wx'});
  f.bridge.active={threadId:f.thread.id,turnId:'turn-1'};

  await f.bridge.notification({method:'item/completed',params:{
    threadId:f.thread.id,turnId:'turn-1',item:{id:'files',type:'fileChange',status:'completed',changes:[
      {path:'preview.png',kind:{type:'add'},diff:'binary'},
      {path:'../outside.txt',kind:{type:'add'},diff:'+private'}
    ]}
  }});
  await f.bridge.notification({method:'turn/completed',params:{
    threadId:f.thread.id,turn:{id:'turn-1',status:'completed'}
  }});

  assert.equal(f.tg.photos.length,1);
  assert.equal(f.tg.photos[0].mime,'image/png');
  assert.equal(f.tg.documents.length,0);
  assert.ok(f.tg.messages.some(message=>message.text.includes('1 个变更文件未能回传')));
});

test('files linked in the final reply are sent like desktop deliverables',async t=>{
  const f=fixture(t);
  fs.mkdirSync(path.join(f.cwd,'outputs'));
  const deliverable=path.join(f.cwd,'outputs','My Report.pdf');
  fs.writeFileSync(deliverable,Buffer.from('%PDF synthetic'),{flag:'wx'});
  f.bridge.active={threadId:f.thread.id,turnId:'turn-1'};

  await f.bridge.notification({method:'item/completed',params:{
    threadId:f.thread.id,turnId:'turn-1',item:{
      id:'answer',type:'agentMessage',text:`已完成：[My Report.pdf](<${deliverable}:12>)`
    }
  }});
  await f.bridge.notification({method:'turn/completed',params:{
    threadId:f.thread.id,turn:{id:'turn-1',status:'completed'}
  }});

  assert.equal(f.tg.documents.length,1);
  assert.equal(f.tg.documents[0].name,'My Report.pdf');
});

test('native imageGeneration savedPath is returned even without a fileChange item',async t=>{
  const f=fixture(t);
  const imagePath=path.join(f.cwd,'generated.png');
  fs.writeFileSync(imagePath,Buffer.from('89504e470d0a1a0a00000000','hex'),{flag:'wx'});
  f.bridge.active={threadId:f.thread.id,turnId:'turn-1'};

  await f.bridge.notification({method:'item/completed',params:{
    threadId:f.thread.id,turnId:'turn-1',item:{
      id:'image',type:'imageGeneration',savedPath:imagePath
    }
  }});
  await f.bridge.notification({method:'turn/completed',params:{
    threadId:f.thread.id,turn:{id:'turn-1',status:'completed'}
  }});

  assert.equal(f.tg.photos.length,1);
  assert.equal(f.tg.photos[0].mime,'image/png');
});
