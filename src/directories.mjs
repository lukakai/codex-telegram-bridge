import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonicalDirectory, canonicalTarget, within, nonce, allowedThread, assertUnprotected, assertNoParentTraversal } from './util.mjs';

// Remote authorization is a local bridge allowlist, NOT an OS sandbox or a
// persistent command approval. Credentials/state remain excluded even if nested.
export function remoteCandidate(value,config) {
  if(typeof value!=='string' || !path.isAbsolute(value) || value.length>4096 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error('请提供现有工作文件夹的完整绝对路径，不支持控制字符或相对路径。');
  assertNoParentTraversal(value);
  const requested=path.resolve(value),cwd=canonicalDirectory(requested);
  const home=os.homedir();
  const broad=['/',home,'/Users','/Volumes','/tmp','/private/tmp','/var','/private/var',...['Desktop','Documents','Downloads','Public'].map(p=>path.join(home,p))];
  for(const p of [requested,cwd]) {
    if(broad.some(root=>root.toLowerCase()===p.toLowerCase())) {
      const error=new Error(`不能在 Telegram 授权整个用户主目录、桌面、文档、下载、磁盘根或临时根目录：${p}。请选择具体工作子目录。`);
      error.code='DIRECTORY_PROTECTED';error.cwd=p;throw error;
    }
    assertUnprotected(config,p,true);
  }
  const stat=fs.statSync(cwd);
  return {requested,cwd,device:String(stat.dev),inode:String(stat.ino)};
}

export function revalidateCandidate(proposal,config) {
  if(!proposal || typeof proposal.requested!=='string') throw new Error('目录授权请求无效。');
  const current=remoteCandidate(proposal.requested,config);
  if(current.cwd!==proposal.cwd || current.device!==proposal.device || current.inode!==proposal.inode) throw new Error('目录或符号链接已变化，请重新 /allow 生成确认，旧授权未生效。');
  return current;
}

export class DirectoryGrants {
  constructor(config,{grants=[],saveGrants=()=>{}}={}) {
    this.config=config;this.base=[...config.projects];this.saveGrants=saveGrants;
    if(!Array.isArray(grants) || grants.length>100) throw new Error('目录授权状态无效或超出100项，请检查 directories.json。');
    const ids=new Set(this.base.map(p=>p.id));
    this.grants=grants.map(g=>{
      if(!g || !/^tg_[a-zA-Z0-9_-]{16}$/.test(g.id) || ids.has(g.id) || typeof g.cwd!=='string' || typeof g.requested!=='string' || typeof g.inode!=='string' || typeof g.device!=='string') throw new Error('目录授权状态格式无效，未加载。');
      ids.add(g.id);return {...g};
    });
    this.sync();
  }
  valid(g) {try{revalidateCandidate(g,this.config);return true;}catch{return false;}}
  sync() {
    // Invalidated/missing grants stay visible in /permissions for revocation,
    // but never enter the effective authorization list.
    this.config.projects=[...this.base,...this.grants.filter(g=>this.valid(g)).map(g=>({id:g.id,name:`TG · ${path.basename(g.cwd)}`,cwd:g.cwd,remote:true,grantIdentity:g}))];
  }
  covered(cwd) {try{allowedThread(this.config,{id:'directory-check',cwd});return true;}catch{return false;}}
  grant(proposals) {
    if(!Array.isArray(proposals) || !proposals.length || proposals.length>10) throw new Error('一次最多明确授权10个目录。');
    const valid=proposals.map(p=>revalidateCandidate(p,this.config));
    const additions=[];const seen=new Set();
    for(const p of valid) if(!this.covered(p.cwd) && !seen.has(p.cwd)) {seen.add(p.cwd);additions.push({id:`tg_${nonce()}`,...p});}
    if(this.grants.length+additions.length>100) throw new Error('远程授权最多100项，请先撤销不再需要的目录。');
    if(!additions.length) return [];
    const next=[...this.grants,...additions];
    // This callback must be synchronous/atomic: no await between final path
    // validation, saving and in-memory publication (especially during approvals).
    this.saveGrants(next);this.grants=next;this.sync();return additions;
  }
  revoke(id) {
    const record=this.grants.find(g=>g.id===id);
    if(!record) throw new Error('这个目录不是 Telegram 新增授权，或已经撤销。初始授权请在 Mac 管理。');
    const next=this.grants.filter(g=>g.id!==id);this.saveGrants(next);this.grants=next;this.sync();
    return {record,stillCovered:this.covered(record.cwd)};
  }
}

export function requiredCommandDirectories(config,cwd) {
  try {allowedThread(config,{id:'command-cwd',cwd});return [];}
  catch(e) {if(e.code!=='DIRECTORY_NOT_AUTHORIZED') throw e;return [remoteCandidate(cwd,config)];}
}

function existingParent(target) {
  let parent=path.dirname(target);
  for(let i=0;i<128;i++) {
    try {if(fs.statSync(parent).isDirectory()) return parent;} catch(e) {if(e.code!=='ENOENT') throw e;}
    const next=path.dirname(parent);if(next===parent) break;parent=next;
  }
  throw new Error('目标文件没有可核验的现有父目录。');
}

export function requiredFileDirectories(config,cwd,changes) {
  if(typeof cwd!=='string' || !Array.isArray(changes) || !changes.length) throw new Error('文件审批缺少工作目录或完整diff。');
  assertNoParentTraversal(cwd);
  const missing=new Map();
  for(const c of changes) {
    if(!['add','delete','update'].includes(c.kind?.type) || typeof c.path!=='string' || !c.path || typeof c.diff!=='string') throw new Error('无法识别文件变更，已拒绝。');
    const targets=[c.path];
    if(c.kind.type==='update' && c.kind.move_path!=null) {
      if(typeof c.kind.move_path!=='string' || !c.kind.move_path) throw new Error('移动目标无效。');
      targets.push(c.kind.move_path);
    }
    for(const target of targets) {
      assertNoParentTraversal(target);
      const lexical=path.resolve(cwd,target),physical=canonicalTarget(lexical);
      assertUnprotected(config,lexical);assertUnprotected(config,physical);
      const covered=config.projects.some(root=>{
        if(!within(root.cwd,lexical)||!within(root.cwd,physical)) return false;
        try{allowedThread(config,{id:'file-root-check',cwd:root.cwd});return true;}catch{return false;}
      });
      if(covered) continue;
      // Do not offer a broader parent grant that would hide a symlink escape.
      if(lexical!==physical) throw new Error('文件路径经过符号链接或非规范别名，不能自动建议扩大授权。请使用实际路径并重新请求。');
      const p=remoteCandidate(existingParent(physical),config);missing.set(p.cwd,p);
    }
  }
  if(missing.size>10) throw new Error('本次涉及超过10个未授权目录，已拒绝。请拆分任务。');
  return [...missing.values()];
}
