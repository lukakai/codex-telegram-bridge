import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const VERSION = '0.4.1';
export const REFERENCE_COMMIT = '654b0a77d0d2f81aa21f61caf7af4be88fe550bb';
export const nonce = () => crypto.randomBytes(12).toString('base64url');
export const expand = p => p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(p);
export function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
export function assertNoParentTraversal(value) {
  if(typeof value!=='string' || value.split(path.sep).includes('..')) throw new Error('路径含父目录跳转（..），无法安全授权；请改用不含 .. 的实际绝对路径。');
}
export function canonicalDirectory(value) {
  assertNoParentTraversal(value);
  const p = fs.realpathSync(expand(value));
  if (!fs.statSync(p).isDirectory()) throw new Error('路径不是目录。');
  return p;
}
// Resolve existing parent symlinks even when the target file does not yet exist.
export function canonicalTarget(value) {
  assertNoParentTraversal(value);
  let current=path.resolve(value); const suffix=[];
  for (;;) {
    try {
      fs.lstatSync(current);
      return path.join(fs.realpathSync(current),...suffix.reverse());
    } catch(e) {
      if (e.code!=='ENOENT') throw e;
      // A dangling symlink is not an ordinary missing file: fail closed.
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('目标包含失效的符号链接。'); } catch(inner) { if (inner.code!=='ENOENT') throw inner; }
      const parent=path.dirname(current); if (parent===current) throw e;
      suffix.push(path.basename(current)); current=parent;
    }
  }
}
export function validateProject(value) {
  const p = canonicalDirectory(value);
  const home = os.homedir();
  const denied = ['/', '/System', '/Library', '/Applications', '/usr', '/etc', '/private', '/var', '/Users', home, ...['Desktop','Documents','Downloads','Library','.ssh','.config','.codex','.workbuddy-ai'].map(x => path.join(home,x))];
  if (denied.includes(p) || within('/System',p) || within('/usr',p) || within(path.join(home,'Library'),p)) {
    throw new Error('请选择具体项目文件夹，不要授权整个主目录、桌面、下载目录或系统目录。');
  }
  return p;
}
export function validateConfig(config, configPath) {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.token || '')) throw new Error('Bot Token 格式无效，请在本机重新配置。');
  if (!Number.isSafeInteger(config.userId) || config.userId <= 0 || !Number.isSafeInteger(config.chatId) || config.chatId <= 0 || config.userId !== config.chatId) throw new Error('只支持配对用户的一对一私聊。');
  if (!path.isAbsolute(config.codexPath || '')) throw new Error('Codex 可执行文件必须为绝对路径。');
  fs.accessSync(config.codexPath, fs.constants.X_OK);
  config.codexHome = canonicalDirectory(config.codexHome);
  if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('至少配置一个项目目录。');
  const seen = new Set();
  for (const p of config.projects) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(p.id) || seen.has(p.id)) throw new Error('项目代号无效或重复。');
    seen.add(p.id);
    p.cwd = validateProject(p.cwd);
    p.name = String(p.name || p.id).slice(0,100);
    if (configPath && within(p.cwd, fs.realpathSync(path.dirname(configPath)))) throw new Error('桥接程序配置目录不能放在获准的项目目录内。');
  }
  const domains=config.networkAllowedDomains??[];
  if (!Array.isArray(domains) || domains.length>20 || domains.some(domain=>typeof domain!=='string' || domain!==domain.trim().toLowerCase() || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))) throw new Error('网络白名单域名无效；只接受小写完整域名，不接受 URL、端口、通配符或 IP。');
  config.networkAllowedDomains=[...new Set(domains)];
  config.approvalTimeoutSeconds = Math.max(30, Math.min(1800, Number(config.approvalTimeoutSeconds) || 600));
  return config;
}
export function assertUnprotected(config,target,includeAncestors=false) {
  const p=path.resolve(target),home=os.homedir();
  const protectedRoots=['/System','/Library','/Applications','/usr','/bin','/sbin','/dev','/etc','/private/etc','/var','/private/var',path.join(home,'Library'),
    ...['.ssh','.gnupg','.aws','.azure','.kube','.docker','.config','.codex','.workbuddy-ai'].map(x=>path.join(home,x)),
    ...(config.protectedPaths||[]),...(config.codexHome?[config.codexHome]:[])];
  const sensitiveNames=new Set(['.ssh','.gnupg','.aws','.azure','.kube','.docker','.config','.codex','.workbuddy-ai']);
  // Deny checks deliberately case-fold on EVERY filesystem. On case-sensitive
  // volumes this can reject a harmless alias, but never expands an allow rule.
  // Allowlist containment itself stays case-sensitive.
  const folded=p.toLowerCase();
  if(folded.split(path.sep).some(x=>sensitiveNames.has(x)) || protectedRoots.some(root=>within(path.resolve(root).toLowerCase(),folded) || includeAncestors && within(folded,path.resolve(root).toLowerCase()))) {
    const e=new Error(`受保护目录不能通过 Telegram 扩大访问权限：${p}。系统、凭据、Codex数据及桥接代码/配置目录不开放。`);
    e.code='DIRECTORY_PROTECTED';e.cwd=p;throw e;
  }
}
export function allowedThread(config, thread) {
  if (!thread || typeof thread.cwd !== 'string' || typeof thread.id !== 'string') throw new Error('会话缺少有效的工作目录或 ID。');
  const cwd = canonicalDirectory(thread.cwd);
  assertUnprotected(config,path.resolve(thread.cwd));assertUnprotected(config,cwd);
  const granted=config.projects.some(p=>{
    if(!within(p.cwd,cwd)) return false;
    if(!p.remote) return true;
    try {
      const g=p.grantIdentity;
      const actual=canonicalDirectory(g.requested),stat=fs.statSync(actual);
      return actual===g.cwd && p.cwd===g.cwd && String(stat.dev)===g.device && String(stat.ino)===g.inode;
    } catch {return false;}
  });
  if (!granted) {
    const e=new Error(`该目录不属于已授权项目：${cwd}。可在 Telegram 使用 /allow 完整路径，确认后再继续。`);
    e.code='DIRECTORY_NOT_AUTHORIZED';e.cwd=cwd;throw e;
  }
  return cwd;
}
export function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const tmp = `${file}.${nonce()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value,null,2)}\n`, {mode:0o600, flag:'wx'});
    fs.renameSync(tmp,file);
    fs.chmodSync(file,0o600);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('本地状态文件无法读取，请检查 JSON 格式；不会自动覆盖。'); }
}
export function safeError(error, token = '') {
  let text = String(error?.message || error || '未知错误');
  if (token) text = text.split(token).join('[TOKEN REDACTED]');
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g,'bot[REDACTED]').replace(/\b\d+:[A-Za-z0-9_-]{20,}/g,'[TOKEN REDACTED]').slice(0,1000);
}
export function chunks(text, max = 3500) {
  const chars = Array.from(String(text));
  const out = []; let buf = ''; let size = 0;
  for (const c of chars) { if (size + c.length > max) { out.push(buf); buf=''; size=0; } buf += c; size += c.length; }
  if (buf) out.push(buf);
  return out.length ? out : ['（空）'];
}
export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  try {
    const fd=fs.openSync(file,'wx',0o600); fs.writeFileSync(fd,JSON.stringify({pid:process.pid})); fs.closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const saved=readJson(file); let alive=true;
    if (!Number.isInteger(saved.pid) || saved.pid <= 0) throw new Error('锁文件无效，请检查，程序不会自动覆盖。');
    try { process.kill(saved.pid,0); } catch (e2) { if (e2.code==='ESRCH') alive=false; }
    if (alive) throw new Error('桥接程序已在运行；同一个 Bot 只能启动一个实例。');
    fs.unlinkSync(file); return acquireLock(file);
  }
  return () => { try { if (readJson(file).pid===process.pid) fs.unlinkSync(file); } catch {} };
}
