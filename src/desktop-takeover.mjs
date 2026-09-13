import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function takeoverError(code,message) {
  const error=new Error(message);error.code=code;return error;
}

export function parseProcessSnapshot(output) {
  if(typeof output!=='string') throw takeoverError('DESKTOP_PROCESS_LOOKUP_FAILED','无法读取桌面 Codex 进程列表。');
  const records=[];
  for(const line of output.split('\n')) {
    const match=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/);
    if(!match) continue;
    records.push({pid:Number(match[1]),ppid:Number(match[2]),uid:Number(match[3]),command:match[4]});
  }
  return records;
}

function processSnapshot() {
  // Deliberately omit process arguments: other apps may place credentials in
  // their command lines, and takeover only needs verified executable ancestry.
  const result=spawnSync('/bin/ps',['-axo','pid=,ppid=,uid=,comm='],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024,shell:false});
  if(result.status!==0 || result.error) throw takeoverError('DESKTOP_PROCESS_LOOKUP_FAILED','无法安全识别桌面 Codex 后端，未执行接管。');
  return parseProcessSnapshot(result.stdout);
}

function expectedPaths(config) {
  let codexPath;
  try {codexPath=fs.realpathSync(config.codexPath);} catch {throw takeoverError('DESKTOP_TAKEOVER_UNSUPPORTED','Codex 路径无法验证，未执行桌面接管。');}
  const resources=path.dirname(codexPath),contents=path.dirname(resources),app=path.dirname(contents);
  if(path.basename(codexPath)!=='codex' || path.basename(resources)!=='Resources' || path.basename(contents)!=='Contents' || path.basename(app)!=='ChatGPT.app') {
    throw takeoverError('DESKTOP_TAKEOVER_UNSUPPORTED','当前 Codex 不是 ChatGPT.app 内置后端，不能使用桌面接管。');
  }
  return {codexPath,desktopPath:path.join(app,'Contents','MacOS','ChatGPT')};
}

export function desktopAppServerCandidate(config,records,{excludePid=null,uid=process.getuid?.()}={}) {
  const {codexPath,desktopPath}=expectedPaths(config);
  const parents=new Set(records.filter(record=>record.uid===uid && record.command===desktopPath).map(record=>record.pid));
  const candidates=records.filter(record=>record.uid===uid && record.pid!==process.pid && record.pid!==excludePid && parents.has(record.ppid) && record.command===codexPath);
  if(candidates.length===0) throw takeoverError('DESKTOP_BACKEND_NOT_FOUND','没有找到可安全确认的 ChatGPT 桌面 Codex 后端，未执行接管。');
  if(candidates.length!==1) throw takeoverError('DESKTOP_BACKEND_AMBIGUOUS','检测到多个 ChatGPT 桌面 Codex 后端，无法确定占用者，未执行接管。');
  return candidates[0];
}

async function terminateGracefully(pid) {
  try {process.kill(pid,'SIGTERM');}
  catch(error) {
    if(error?.code==='ESRCH') return;
    throw takeoverError('DESKTOP_BACKEND_TERMINATE_FAILED','无法请求桌面 Codex 后端释放，未执行接管。');
  }
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    await delay(100);
    try {process.kill(pid,0);} catch(error) {if(error?.code==='ESRCH') return;throw takeoverError('DESKTOP_BACKEND_TERMINATE_FAILED','无法确认桌面 Codex 后端状态，未执行接管。');}
  }
  throw takeoverError('DESKTOP_BACKEND_STILL_RUNNING','桌面 Codex 后端没有在安全等待时间内退出；未使用强制结束。');
}

export class DesktopTakeover {
  constructor(config,{snapshot=processSnapshot,terminate=terminateGracefully,uid=process.getuid?.()}={}) {
    this.config=config;this.snapshot=snapshot;this.terminate=terminate;this.uid=uid;
  }
  async release({excludePid=null}={}) {
    const first=desktopAppServerCandidate(this.config,this.snapshot(),{excludePid,uid:this.uid});
    const second=desktopAppServerCandidate(this.config,this.snapshot(),{excludePid,uid:this.uid});
    if(first.pid!==second.pid || first.ppid!==second.ppid) throw takeoverError('DESKTOP_BACKEND_CHANGED','桌面 Codex 后端在确认期间发生变化，未执行接管。');
    await this.terminate(second.pid);
    return {released:true};
  }
}
