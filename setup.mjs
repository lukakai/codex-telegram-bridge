import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { Telegram } from './src/telegram.mjs';
import { expand, canonicalDirectory, validateProject, validateConfig, within, writePrivateJson, safeError } from './src/util.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
export function locateCodex(input='') {
  const candidates=input ? [expand(input)] : [
    '/Applications/Codex.app/Contents/Resources/codex',path.join(os.homedir(),'Applications/Codex.app/Contents/Resources/codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex',path.join(os.homedir(),'Applications/ChatGPT.app/Contents/Resources/codex'),
    ...(process.env.PATH||'').split(path.delimiter).filter(Boolean).map(p=>path.join(p,'codex'))
  ];
  for (let candidate of candidates) {
    if (candidate.endsWith('.app')) candidate=path.join(candidate,'Contents/Resources/codex');
    try {
      fs.accessSync(candidate,fs.constants.X_OK);
      const v=spawnSync(candidate,['--version'],{encoding:'utf8',timeout:10000,shell:false});
      if (v.status===0 && /codex/i.test(v.stdout)) return {path:fs.realpathSync(candidate),version:v.stdout.trim()};
    } catch {}
  }
  return null;
}
export async function hiddenToken() {
  const input=process.stdin, output=process.stdout;
  if (!input.isTTY) throw new Error('请在 Mac 终端中配置，Token 输入需要交互式终端。');
  output.write('Bot Token（隐藏输入，仅保存到本机）：');
  const wasRaw=Boolean(input.isRaw); input.setRawMode(true); input.resume();
  return new Promise((resolve,reject)=>{
    let secret='';
    const cleanup=()=>{input.off('data',onData); input.off('end',onEnd); input.setRawMode(wasRaw); input.pause(); output.write('\n');};
    const onEnd=()=>{cleanup(); reject(new Error('输入已结束。'));};
    const onData=buf=>{
      for (const c of buf.toString('utf8')) {
        if (c==='\u0003' || c==='\u0004') {cleanup(); reject(new Error('已取消，未保存 Token。')); return;}
        if (c==='\r' || c==='\n') {cleanup(); resolve(secret.trim()); return;}
        if (c==='\u007f' || c==='\b') secret=secret.slice(0,-1);
        else if (/[A-Za-z0-9_:\-]/.test(c)) secret+=c;
      }
    };
    input.on('data',onData); input.once('end',onEnd);
  });
}
export async function setup(configPath=path.join(root,'state/config.json')) {
  if (!process.stdin.isTTY) throw new Error('首次使用请在 Mac 终端运行 start.command，完成本机配对。');
  let rl=createInterface({input:process.stdin,output:process.stdout});
  const ask=async text=>(await rl.question(text)).trim();
  let token='';
  try {
    console.log('\nCodex ↔ Telegram · 本机配置\n仅支持你本人的私聊；不会安装软件、修改 Codex 配置或启用开机启动。');
    console.log('建议新建专用 Bot。配对会消费该 Bot 的消息；不能与其他轮询程序或 webhook 共用。');
    console.log('选择的历史摘要、任务文字、回复及审批命令/diff 会经 Telegram 云端传输，Bot 对话不是端到端加密。');
    if ((await ask('理解以上边界并开始配置？输入 yes：'))!=='yes') throw new Error('已取消配置。');
    if (fs.existsSync(configPath) && (await ask('配置已存在。要重新配对并覆盖本程序的配置吗？输入 yes：'))!=='yes') throw new Error('保留原配置，已取消。');
    const found=locateCodex();
    const input=await ask(`Codex 可执行文件或 .app 路径${found?` [${found.path}]`:''}：`);
    const codex=locateCodex(input || found?.path || '');
    if (!codex) throw new Error('未找到可运行的 Codex。请找到 Codex.app 的真实位置，或已有的 codex CLI 路径，再运行配置。没有为你安装其他版本。');
    console.log(`检测到 ${codex.version}`);
    const homeDefault=process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
    const codexHome=canonicalDirectory((await ask(`与桌面版相同的 CODEX_HOME [${homeDefault}]：`)) || homeDefault);
    const projects=[];
    for (;;) {
      const value=await ask(projects.length?'再添加一个项目目录（留空结束）：':'允许 Telegram 操作的具体项目目录：');
      if (!value && projects.length) break;
      if (!value) continue;
      try {
        const cwd=validateProject(value);
        // Resolve the existing parent so a symlink does not hide the token directory.
        const stateParent=fs.existsSync(path.dirname(configPath))?fs.realpathSync(path.dirname(configPath)):path.join(fs.realpathSync(path.dirname(path.dirname(configPath))),path.basename(path.dirname(configPath)));
        if (within(cwd,stateParent)) throw new Error('桥接程序配置不能位于这个获准目录中。请选择其他具体工作项目。');
        if (projects.some(p=>p.cwd===cwd)) throw new Error('该目录已添加。');
        const name=(await ask(`项目名称 [${path.basename(cwd)}]：`)) || path.basename(cwd);
        projects.push({id:`p${projects.length+1}`,name,cwd});
      } catch(e) {console.log(safeError(e));}
    }
    rl.close(); token=await hiddenToken();
    rl=createInterface({input:process.stdin,output:process.stdout});
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Token 格式无效，未保存。');
    const tg=new Telegram(token);
    const bot=await tg.call('getMe');
    const webhook=await tg.call('getWebhookInfo');
    if (webhook.url) throw new Error('这个 Bot 已配置 webhook。请换一个专用 Bot；程序不会替你删除 webhook。');
    const code=randomBytes(16).toString('hex'), since=Math.floor(Date.now()/1000);
    console.log(`\n请在 Telegram 打开 @${bot.username} 的私聊，发送：\n/start ${code}\n配对等待最多 5 分钟。请勿将此一次性口令发到群聊。`);
    let offset=0, paired;
    const deadline=Date.now()+5*60000;
    while (Date.now()<deadline && !paired) {
      const updates=await tg.updates(offset);
      for (const update of updates) {
        offset=Math.max(offset,update.update_id+1);
        const m=update.message;
        if (m?.chat?.type==='private' && m.from?.id===m.chat.id && m.date>=since && m.text===`/start ${code}`) {paired=m; break;}
      }
    }
    if (!paired) throw new Error('配对超时，未保存 Token。');
    console.log(`\n请求配对：${paired.from.username?'@'+paired.from.username:'未设置用户名'}\nTelegram 用户 ID：${paired.from.id}`);
    if ((await ask('请核对这是你自己的账号。确认保存请输入 yes：'))!=='yes') throw new Error('未确认身份，未保存配置。');
    fs.mkdirSync(path.dirname(configPath),{recursive:true,mode:0o700});
    const config={token,userId:paired.from.id,chatId:paired.chat.id,codexPath:codex.path,codexHome,projects,networkAllowedDomains:[],approvalTimeoutSeconds:600};
    validateConfig(config,configPath); writePrivateJson(configPath,config);
    writePrivateJson(path.join(path.dirname(configPath),'runtime.json'),{offset});
    console.log(`配置已保存：${configPath}\n文件仅当前用户可读写；不要上传 state 文件夹或把它放入工作项目。`);
    try {await tg.say(config.chatId,'本机配对完成。桥接连接启动后可用 /projects、/threads、/new。');} catch {console.log('配对已保存，但确认消息发送失败，请检查网络。');}
    return config;
  } finally {rl.close(); token='';}
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  setup().catch(e=>{console.error(safeError(e));process.exitCode=1;});
}
