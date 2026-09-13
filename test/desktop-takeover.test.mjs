import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopTakeover, desktopAppServerCandidate, parseProcessSnapshot } from '../src/desktop-takeover.mjs';

const testDir=path.dirname(fileURLToPath(import.meta.url));

function fixture(t) {
  const root=fs.mkdtempSync(path.join(testDir,'.fixture-takeover-'));
  const app=path.join(root,'ChatGPT.app'),codexPath=path.join(app,'Contents','Resources','codex'),desktopPath=path.join(app,'Contents','MacOS','ChatGPT');
  fs.mkdirSync(path.dirname(codexPath),{recursive:true});fs.mkdirSync(path.dirname(desktopPath),{recursive:true});
  fs.writeFileSync(codexPath,'');fs.writeFileSync(desktopPath,'');
  const uid=501,records=[
    {pid:100,ppid:1,uid,command:desktopPath},
    {pid:101,ppid:100,uid,command:codexPath},
    {pid:202,ppid:999,uid,command:codexPath}
  ];
  t.after(()=>{});
  return {config:{codexPath},uid,records,codexPath,desktopPath};
}

test('process snapshot parser reads only identity fields and no arguments',()=>{
  assert.deepEqual(parseProcessSnapshot('  100  1  501 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n  101 100 501 /Applications/ChatGPT.app/Contents/Resources/codex\n'),[
    {pid:100,ppid:1,uid:501,command:'/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'},
    {pid:101,ppid:100,uid:501,command:'/Applications/ChatGPT.app/Contents/Resources/codex'}
  ]);
});

test('desktop candidate must be the sole exact Codex child of the exact ChatGPT app',t=>{
  const f=fixture(t),candidate=desktopAppServerCandidate(f.config,f.records,{uid:f.uid,excludePid:202});
  assert.equal(candidate.pid,101);
  assert.throws(()=>desktopAppServerCandidate(f.config,[...f.records,{pid:102,ppid:100,uid:f.uid,command:f.codexPath}],{uid:f.uid}),/多个/);
  assert.throws(()=>desktopAppServerCandidate(f.config,f.records.map(record=>record.pid===101?{...record,ppid:1}:record),{uid:f.uid}),/没有找到/);
});

test('desktop takeover revalidates the same process before graceful termination',async t=>{
  const f=fixture(t),terminated=[];let snapshots=0;
  const takeover=new DesktopTakeover(f.config,{uid:f.uid,snapshot:()=>{snapshots++;return f.records;},terminate:async pid=>terminated.push(pid)});
  assert.deepEqual(await takeover.release({excludePid:202}),{released:true});assert.equal(snapshots,2);assert.deepEqual(terminated,[101]);
});

test('desktop takeover refuses a changed process and never terminates it',async t=>{
  const f=fixture(t),terminated=[];let snapshots=0;
  const takeover=new DesktopTakeover(f.config,{uid:f.uid,snapshot:()=>++snapshots===1?f.records:f.records.map(record=>record.pid===101?{...record,pid:103}:record),terminate:async pid=>terminated.push(pid)});
  await assert.rejects(takeover.release(),/发生变化/);assert.deepEqual(terminated,[]);
});

test('desktop takeover refuses non-ChatGPT Codex layouts',t=>{
  const root=fs.mkdtempSync(path.join(testDir,'.fixture-takeover-')),codexPath=path.join(root,'codex');fs.writeFileSync(codexPath,'');
  assert.throws(()=>desktopAppServerCandidate({codexPath},[],{uid:501}),/不是 ChatGPT\.app/);
});
