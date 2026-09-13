#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexRpc } from './src/codex.mjs';
import { Telegram } from './src/telegram.mjs';
import { retryStartupRead, waitForPollRetry, isTerminalTelegramError, isRetryableTelegramError } from './src/network.mjs';
import { Bridge } from './src/bridge.mjs';
import { approvalModeFromState, approvalState } from './src/approval-settings.mjs';
import { Inbox } from './src/inbox.mjs';
import { setup, locateCodex } from './setup.mjs';
import { VERSION, acquireLock, readJson, validateConfig, writePrivateJson, safeError } from './src/util.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
async function main() {
  if (Number(process.versions.node.split('.')[0])<22) throw new Error('需要 Node.js 22 或更高版本。');
  if (args.includes('--help')) {
    console.log(`Codex Telegram Bridge ${VERSION}\n\nnode main.mjs                  首次本机配置，随后启动\nnode main.mjs --configure      重新配置/配对\nnode main.mjs --doctor         检查配置、Bot、Codex 协议（不运行任务）\nnode main.mjs --config PATH    使用指定配置文件\nnode --test test/*.test.mjs    运行离线测试\n\n保留终端运行，Mac 必须醒着且联网；未自动安装开机启动。`); return;
  }
  const i=args.indexOf('--config');
  if (i>=0 && (!args[i+1] || args[i+1].startsWith('--'))) throw new Error('--config 后需要一个文件路径。');
  const configFile=i>=0?path.resolve(args[i+1]):path.join(root,'state/config.json');
  if (args.includes('--doctor') && !fs.existsSync(configFile)) {
    const found=locateCodex();
    console.log(`Node.js：${process.versions.node}\n配置：尚未创建\nCodex：${found?`${found.version} (${found.path})`:'在标准应用目录或 PATH 未找到'}\n下一步：在本机终端运行 start.command；不需要把 Token 发到聊天里。`);
    return;
  }
  fs.mkdirSync(path.dirname(configFile),{recursive:true,mode:0o700});
  const unlock=acquireLock(path.join(path.dirname(configFile),'bridge.lock'));
  let rpc, bridge, tg, config, stopped=false;
  const cancellation=new AbortController();
  const stop=()=>{stopped=true;cancellation.abort();tg?.close();};
  const shutdown=()=>{
    stop();
    if (bridge?.active) {
      bridge.active.stopping=true;
      if (bridge.active.turnId) bridge.invalidateTurn(bridge.active.threadId,bridge.active.turnId,true);
    }
    console.log('正在停止接收新任务；不会回滚已完成的修改。');
  };
  process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
  try {
    if (args.includes('--configure') || !fs.existsSync(configFile)) await setup(configFile);
    if (process.platform!=='win32' && (fs.statSync(configFile).mode & 0o077)) throw new Error('配置文件权限过宽，请在本机把 config.json 权限设为 600 后重试。');
    config=validateConfig(readJson(configFile),configFile);
    // Never expose this bridge's own code, config or Codex credentials to a
    // remotely selected project, even if a broader parent is otherwise allowed.
    config.protectedPaths=[fs.realpathSync(root),fs.realpathSync(path.dirname(configFile)),fs.realpathSync(config.codexPath)];
    if (stopped) return;
    tg=new Telegram(config.token);
    const startupOptions={signal:cancellation.signal,attempts:5,onRetry:(e,{attempt,attempts})=>{
      console.error(`Telegram 启动检查重试：${safeError(e,config.token)} 已失败 ${attempt}/${attempts} 次。`);
    }};
    const me=await retryStartupRead(tg,'getMe',startupOptions);
    const webhook=await retryStartupRead(tg,'getWebhookInfo',startupOptions);
    if (webhook.url) throw new Error('Bot 已配置 webhook，不能同时长轮询。请使用专用 Bot；不会自动删除 webhook。');
    const preferencesFile=path.join(path.dirname(configFile),'preferences.json');
    const savedPreferences=readJson(preferencesFile,{});
    // A re-paired Bot/user must not inherit a different owner's remote settings.
    const preferences=savedPreferences.userId===config.userId && savedPreferences.chatId===config.chatId ? savedPreferences : {};
    const directoriesFile=path.join(path.dirname(configFile),'directories.json');
    const savedDirectories=readJson(directoriesFile,{});
    const grants=savedDirectories.userId===config.userId && savedDirectories.chatId===config.chatId?savedDirectories.grants:[];
    const approvalFile=path.join(path.dirname(configFile),'approval.json');
    const approvalIdentity={userId:config.userId,chatId:config.chatId,botId:me.id};
    const approvalMode=approvalModeFromState(readJson(approvalFile,null),approvalIdentity);
    rpc=new CodexRpc(config); bridge=new Bridge(config,rpc,tg,{
      preferences,grants,approvalMode,
      saveApproval:mode=>writePrivateJson(approvalFile,approvalState(mode,approvalIdentity)),
      saveGrants:next=>writePrivateJson(directoriesFile,{userId:config.userId,chatId:config.chatId,version:1,grants:next}),
      diagnostic:(event,e)=>{
        const kinds=new Set(['operation-failed','error-message-undelivered','callback-ack-failed','keyboard-clear-failed','session-release-failed','turn-output-failed']);
        if(!kinds.has(event)) return;
        const codes=new Set(['TIMEOUT','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','ENETUNREACH','NETWORK_ERROR','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET']);
        const code=codes.has(e?.networkCode)?e.networkCode:Number.isInteger(e?.code)?String(e.code):'UNSPECIFIED';
        console.error(`[bridge] ${event} (${code})；用 /status 核对会话/任务状态，勿盲目重发任务。`);
      },
      savePreferences:choice=>writePrivateJson(preferencesFile,{userId:config.userId,chatId:config.chatId,...choice})
    });
    rpc.once('fatal',stop);
    if (args.includes('--doctor')) {
      await rpc.start();
      if (stopped) return;
      console.log(`检查通过：Node ${process.versions.node}；Bot @${me.username}；Codex initialize 握手成功；授权项目 ${config.projects.length} 个。\n尚未验证实际生成、桌面历史可见性或审批往返；这些需在 Telegram 中联调。`); return;
    }
    const stateFile=path.join(path.dirname(configFile),'runtime.json'), state=readJson(stateFile,{offset:0});
    const inbox=new Inbox({offset:state.offset,since:Math.floor(Date.now()/1000),save:s=>writePrivateJson(stateFile,s)});
    const shutdown=()=>{
      stopped=true;
      if (bridge.active) {
        bridge.active.stopping=true;
        if (bridge.active.turnId) bridge.invalidateTurn(bridge.active.threadId,bridge.active.turnId,true);
      }
      console.log('正在停止接收新任务；不会回滚已完成的修改。');
    };
    process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
    rpc.once('fatal',()=>{stopped=true;});
    console.log(`桥接 v${VERSION} 运行中 · @${me.username}\n仅接受已配对用户的私聊。不要关闭此终端；Mac 睡眠/断网时无法远程操作。\n按 Control-C 停止。不记录消息正文或 Token。`);
    await bridge.say(`Mac 桥接 v${VERSION} 已待命。\n/projects 选择项目，/threads 查看目录及子目录会话，/new 新建任务。\n/model 选择模型，/effort 选择推理强度。\n/approval：选择严格审批或自动审查。${bridge.approvalSettings.summary()}\n/allow 完整目录：申请远程目录授权；/permissions 查看；/revoke 代号 撤销。\n空闲时不恢复任何会话、不持有 writer；选择会话后，收到任务才启动临时 worker，任务结束会自动释放。若桌面端占用所选会话，TG 会先显示风险说明并询问是否释放桌面后端、由 TG 接管；不会自动重发失败任务。/release 只释放 TG 自己的临时 writer。\n重启前排队的旧消息不会自动执行；请重新发送需要继续的任务。`);
    let failures=0,totalFailures=0,lastNetworkLog=0;
    while (!stopped) {
      let updates;
      try {updates=await tg.updates(inbox.offset); failures=0;}
      catch(e) {
        if ([401,404,409].includes(e.code)) throw new Error(e.code===409?'Bot 被另一个轮询实例占用，已停止本实例。':'Bot 认证失败，请在本机重新配置。');
        if (stopped) break;
        failures++;totalFailures++;
        if (!lastNetworkLog || Date.now()-lastNetworkLog>=30000) {
          console.error(`Telegram 重连：${safeError(e,config.token)} 连续失败 ${failures} 次，本次启动累计 ${totalFailures} 次。任务不会自动重发。`);
          lastNetworkLog=Date.now();
        }
        const retryMs=Number.isFinite(e.retryAfter)?Math.max(1000,Math.min(300000,e.retryAfter*1000)):0;
        await delay(Math.max(retryMs,Math.min(30000,1000*2**Math.min(failures,5)))); continue;
      }
      for (const update of updates.sort((a,b)=>a.update_id-b.update_id)) {
        if (stopped) break;
        // A checkpoint failure propagates and stops the process before execution.
        await inbox.dispatch(update,async u=>{
          try {await bridge.handle(u);} catch(e) {await bridge.report(e);}
        });
      }
    }
    process.off('SIGINT',shutdown); process.off('SIGTERM',shutdown);
  } catch(e) {throw new Error(safeError(e,config?.token));}
  finally {
    if (bridge?.active && !rpc?.closed) {
      bridge.active.stopping=true;
      const {threadId,turnId}=bridge.active;
      if (turnId) {
        bridge.invalidateTurn(threadId,turnId,true);
        try {await Promise.race([rpc.call('turn/interrupt',{threadId,turnId}),delay(5000)]);} catch {}
      }
    }
    bridge?.dispose(); await rpc?.shutdown?.(); unlock();
  }
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
