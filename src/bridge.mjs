import path from 'node:path';
import { ThreadCatalog } from './threads.mjs';
import { ModelSettings } from './models.mjs';
import { ApprovalSettings, approvalPolicy } from './approval-settings.mjs';
import { DirectoryGrants, remoteCandidate, revalidateCandidate, requiredCommandDirectories, requiredFileDirectories } from './directories.mjs';
import { allowedThread, canonicalTarget, chunks, nonce, safeError, within } from './util.mjs';
import { incomingAttachment, saveAttachment, describeExport, readExport, imageKind } from './attachments.mjs';
import { DesktopTakeover } from './desktop-takeover.mjs';

const HELP = `Codex · Telegram 本地桥接\n\n/projects 选择已授权项目\n/approval 切换严格审批/自动审查\n/permissions 查看目录授权\n/allow 完整目录 申请新增目录授权\n/revoke 授权代号 撤销TG新增授权\n/threads [关键词] 查看项目及子目录历史\n/archived [关键词] 查看归档历史（只读）\n/history [会话ID] 查看最近对话\n/use <会话ID> 选择旧会话\n/new <任务描述> 在当前项目新建任务\n/model 选择模型（可直接 /model 模型ID）\n/effort 选择推理强度（可直接 /effort 强度）\n/status 当前会话、模型、任务、待审批\n/release 释放 TG 自己持有的临时 writer\n/stop 请求中止当前任务\n/answer <问题编号> <回答> 回答 Codex 提问\n\n选定会话后，可直接发文字、图片或单个文件（最大 20 MB）。文件 caption 就是任务说明；Codex 产生或更新的文件会在任务结束时直接发回。同一时间只运行一个 TG 任务。平时只读历史、不持有 writer；任务执行时临时恢复会话，结束后立即释放。桌面 writer 占用时会提供经二次确认的强制接管入口。`;
const CMD='item/commandExecution/requestApproval';
const FILE='item/fileChange/requestApproval';
const INPUT='item/tool/requestUserInput';
const PERMISSION='item/permissions/requestApproval';

function documentInput(caption,file) {
  const instruction=caption||'请查看这个文件。';
  const prefix=`${instruction}\n\n文件：`;
  const text=`${prefix}${file.path}`;
  return {
    type:'text',
    text,
    // App-server has no arbitrary local-file input. Keep the actual path in
    // model-visible text, while allowing rich clients to render only a
    // human-friendly filename for that span.
    text_elements:[{
      byteRange:{start:Buffer.byteLength(prefix),end:Buffer.byteLength(text)},
      placeholder:`📎 ${file.originalName}`
    }]
  };
}

function directiveAttribute(source,name) {
  const match=source.match(new RegExp(`(?:^|\\s)${name}="((?:\\\\.|[^"\\\\])*)"`));
  return match?.[1]?.replace(/\\(["\\])/g,'$1');
}

function safeDirectiveText(value,limit) {
  if(typeof value!=='string') return '';
  return value.replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu,' ').trim().slice(0,limit);
}

function citationLabel(attributes,uploadNames) {
  const citedPath=directiveAttribute(attributes,'path');
  const known=citedPath?uploadNames.get(citedPath):'';
  const leaf=safeDirectiveText(known || citedPath?.split(/[\\/]/).at(-1) || '当前附件',120);
  const sheet=safeDirectiveText(directiveAttribute(attributes,'sheet'),80);
  const range=safeDirectiveText(directiveAttribute(attributes,'range'),80);
  const location=sheet && range?`${sheet}!${range}`:sheet||range;
  return `📎 来源：${leaf||'当前附件'}${location?` · ${location}`:''}`;
}

function telegramCodexText(text,uploadNames) {
  const followups=[];
  let rendered=text.replace(/^[ \t]*:{1,2}codex-file-citation\{([^\r\n]*)\}[ \t]*$/gmu,
    (_line,attributes)=>citationLabel(attributes,uploadNames));
  // Codex may append the desktop citation directly after a sentence instead
  // of placing it on its own line. Render that form as a separate, readable
  // source line as well, without leaking the uploaded file's private path.
  rendered=rendered.replace(/[ \t]*:{1,2}codex-file-citation\{([^}\r\n]*)\}/gu,
    (_directive,attributes)=>`\n\n${citationLabel(attributes,uploadNames)}`);
  rendered=rendered.replace(/^[ \t]*-\s*:{1,2}codex-followup\[([^\]\r\n]{1,200})\]\{[^\r\n]*\}[ \t]*$/gmu,
    (_line,label)=>{const safe=safeDirectiveText(label,80);if(safe) followups.push(safe);return '';});
  rendered=rendered.replace(/\n{3,}/g,'\n\n').trim();
  if(followups.length) rendered+=`${rendered?'\n\n':''}可继续：${followups.join('；')}`;
  return rendered;
}

export class Bridge {
  constructor(config,rpc,tg,{now=Date.now,preferences={},savePreferences=()=>{},diagnostic=()=>{},grants=[],saveGrants=()=>{},approvalMode='strict',saveApproval=()=>{},desktopTakeover=new DesktopTakeover(config)}={}) {
    this.config=config; this.rpc=rpc; this.tg=tg; this.now=now;
    this.desktopTakeover=desktopTakeover;
    this.networkAllowedDomains=new Set(config.networkAllowedDomains||[]);
    this.previewed=null; this.diagnostic=diagnostic;
    this.grants=new DirectoryGrants(config,{grants,saveGrants});
    this.grantRevision=0;this.directoryWarnings=new Map();
    this.project=config.projects[0]; this.selected=null; this.managed=new Map(); this.active=null;
    this.buttons=new Map(); this.approvals=new Map(); this.questions=new Map(); this.items=new Map(); this.finished=new Set();
    this.outputFiles=new Map();
    this.uploadNames=new Map();
    this.sendChain=Promise.resolve(); this.broken=false; this.releasePromise=null; this.takeoverReservation=null;
    this.loadedThreadId=null; this.loadedGeneration=null;
    this.requests=new Map(); this.settled=new WeakSet();
    this.threads=new ThreadCatalog(config,rpc);
    this.models=new ModelSettings(rpc,{now,preferences,savePreferences});
    this.approvalSettings=new ApprovalSettings({mode:approvalMode,save:saveApproval});
    // 流式输出状态管理
    this.streamingMessages=new Map(); // turnId -> {messageId, buffer, lastUpdate, throttleTimer}
    rpc.on('request', msg => { void this.serverRequest(msg).catch(e => this.requestFailed(msg,e)); });
    rpc.on('notification', msg => { void this.notification(msg).catch(e => this.report(e)); });
    rpc.on('fatal', error => { this.broken=true; this.dispose(); void this.say(`Codex 连接已断开：${safeError(error,config.token)}\n请在 Mac 检查后重启；不会自动重试或恢复任务。`).catch(()=>{}); });
  }
  say(text,keyboard) {
    const task=this.sendChain.then(()=>this.tg.say(this.config.chatId,text,keyboard));
    this.sendChain=task.catch(()=>{}); return task;
  }
  rich(text) {
    const task=this.sendChain.then(()=>this.tg.rich?this.tg.rich(this.config.chatId,text):this.tg.say(this.config.chatId,text));
    this.sendChain=task.catch(()=>{});return task;
  }
  sendDocument(file) {
    const task=this.sendChain.then(()=>this.tg.sendDocument(this.config.chatId,file));
    this.sendChain=task.catch(()=>{});return task;
  }
  sendPhoto(file) {
    const task=this.sendChain.then(()=>this.tg.sendPhoto(this.config.chatId,file));
    this.sendChain=task.catch(()=>{});return task;
  }
  async report(e) {
    // Only fixed categories/codes go to local diagnostics; never prompts/errors
    // from Codex, since those can contain private user content.
    this.diagnostic('operation-failed',e);
    try {
      if(e?.code==='DIRECTORY_NOT_AUTHORIZED' || e?.code==='DIRECTORY_PROTECTED') {await this.directoryProblem(e);return;}
      if(e?.code==='DESKTOP_WRITER_BUSY' || String(e?.message||'').includes('already has an active writer')) {await this.offerDesktopTakeover(e?.threadId||this.selected?.id||this.previewed?.id);return;}
      await this.say(`操作未完成：${safeError(e,this.config.token)}`);
    }
    catch(sendError) {this.diagnostic('error-message-undelivered',sendError);}
  }
  connectionStatus() {
    if (this.broken) return '故障（需在 Mac 重启桥接）';
    if (this.releasePromise) return '正在释放临时 worker';
    if (this.takeoverReservation) return 'TG 已接管，等待任务（两分钟后自动释放）';
    if (this.rpc.isRunning===true) return this.active?'临时 worker 运行中':'只读连接待命（未恢复会话）';
    return '待命（未持有会话 writer）';
  }
  async waitForRelease() { if (this.releasePromise) await this.releasePromise; }
  clearTakeoverReservation() {
    if(this.takeoverReservation?.timer) clearTimeout(this.takeoverReservation.timer);
    this.takeoverReservation=null;
  }
  reserveTakeover(threadId) {
    this.clearTakeoverReservation();
    const reservation={threadId,timer:null};
    reservation.timer=setTimeout(()=>{
      if(this.active || this.takeoverReservation!==reservation) return;
      const task=this.releaseWorker(threadId);this.releasePromise=task;
      void task.then(()=>this.say('TG 接管等待已超时，临时 writer 已自动释放；会话选择仍保留。')).catch(()=>{}).finally(()=>{if(this.releasePromise===task)this.releasePromise=null;});
    },2*60000);
    reservation.timer.unref?.();this.takeoverReservation=reservation;
  }
  async releaseWorker(threadId) {
    this.clearTakeoverReservation();
    try {
      if (this.rpc.isRunning!==false) await this.rpc.call('thread/unsubscribe',{threadId});
    } catch(error) { this.diagnostic('session-release-failed',error); }
    try { await this.rpc.close?.(); }
    catch(error) { this.diagnostic('session-release-failed',error); }
    this.loadedThreadId=null; this.loadedGeneration=null;
  }
  async releaseSelected() {
    this.requireIdle();
    const threadId=this.loadedThreadId||this.selected?.id;
    if(this.loadedThreadId && threadId) await this.releaseWorker(threadId);
    else {this.clearTakeoverReservation();try {await this.rpc.close?.();} catch(error) {this.diagnostic('session-release-failed',error);}}
    return this.say('TG 自己的临时连接已释放；会话选择仍保留。此命令不能释放桌面端持有的 writer。');
  }
  authorized(user,chat) { return user?.id===this.config.userId && chat?.id===this.config.chatId && chat?.type==='private'; }
  requireIdle() { if (this.active) throw new Error('当前任务仍在运行。请等待完成，或使用 /stop 并等到中止确认。'); }
  async handle(update) {
    if (update.callback_query) return this.callback(update.callback_query);
    const m=update.message;
    if (!m || !this.authorized(m.from,m.chat)) return;
    await this.waitForRelease();

    // Handle photo messages
    if (m.photo?.length) return this.handlePhotoMessage(m);

    // Handle document messages
    if (m.document) return this.handleDocumentMessage(m);

    if (typeof m.text!=='string') return;
    try {
      const text=m.text.trim();
      const match=text.match(/^\/([a-z_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/i);
      if (!match) { if (text.startsWith('/')) return this.say('未知指令，请用 /help。'); return await this.startTurn(text); }
      const cmd=match[1].toLowerCase(), arg=(match[2]||'').trim();
      if (cmd==='start' || cmd==='help') return this.say(HELP);
      if (cmd==='status') return this.say(`项目：${this.project.name}\n目录：${this.project.cwd}\n已选择会话：${this.selected?.id || '未选择（查看历史不等于选择）'}\n正在预览：${this.previewed?.id || '无'}\n任务：${this.active ? `运行中（${this.active.turnId||'启动中'}）` : '空闲'}\n待审批：${this.approvals.size}\n待回答：${this.questions.size}\n${this.models.summary(this.selected)}\n${this.approvalSettings.summary(this.active)}\n受限网络白名单：${[...this.networkAllowedDomains].join(', ')||'无'}\n模型设置作用于此 Bot 的后续任务，切换会话后仍有效。\nCodex 连接：${this.connectionStatus()}`);
      if (this.broken) throw new Error('Codex 已断开，请在 Mac 重启程序。');
      if (cmd==='approval') return arg?await this.offerApprovalMode(arg):await this.approvalMenu();
      if (cmd==='permissions') return await this.permissions();
      if (cmd==='allow') { this.requireIdle(); if(!arg) return await this.say('用法：/allow /完整/工作目录\n只新增具体工作目录；发送后还须点击确认，不自动授权。/permissions 查看授权，/revoke 代号 撤销TG授权。');return await this.offerGrant([remoteCandidate(arg,this.config)]); }
      if (cmd==='revoke') {this.requireIdle();return await this.offerRevoke(arg);}
      if (cmd==='model' || cmd==='models') return arg?await this.chooseModel(arg):await this.modelMenu();
      if (cmd==='effort') return arg?await this.chooseEffort(arg):await this.effortMenu();
      if (cmd==='projects') return this.projects();
      if (cmd==='threads' || cmd==='archived') return this.list(arg,null,cmd==='archived');
      if (cmd==='history') return await this.history(arg || this.selected?.id);
      if (cmd==='use') { if (!arg) throw new Error('用法：/use <会话ID>'); this.requireIdle(); return await this.offerResume(arg); }
      if (cmd==='new') { if (!arg) throw new Error('用法：/new <任务描述>，可先用 /projects 选择目录。'); return await this.newThread(arg); }
      if (cmd==='release') return this.releaseSelected();
      if (cmd==='stop') return this.stop();
      if (cmd==='answer') return this.answer(arg);
      return this.say('未知指令，请用 /help。');
    } catch(e) { return this.report(e); }
  }
  button(kind,data) {
    // Bound RAM use; losing old navigation buttons is safe.
    for (const [k,v] of this.buttons) if (v.expires <= this.now()) this.buttons.delete(k);
    if (this.buttons.size >= 400) this.buttons.delete(this.buttons.keys().next().value);
    const key=nonce(); this.buttons.set(key,{kind,data,expires:this.now()+15*60000,messageId:null}); return `b:${key}`;
  }
  async withButtons(text,rows) {
    const message=await this.say(text,rows);
    for (const row of rows) for (const b of row) { const r=this.buttons.get(b.callback_data?.slice(2)); if (r) r.messageId=message.message_id; }
    return message;
  }
  async offerDesktopTakeover(threadId) {
    this.requireIdle();
    if(typeof threadId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)) return this.say('桌面 writer 正在占用，但无法安全确定对应会话；未执行释放。');
    const data={threadId,group:nonce()};
    const rows=[[{text:'确认释放桌面并由 TG 接管',callback_data:this.button('desktopTakeoverConfirm',data)},{text:'取消',callback_data:this.button('desktopTakeoverCancel',data)}]];
    for(const button of rows[0]) this.buttons.get(button.callback_data.slice(2)).expires=this.now()+2*60000;
    return this.withButtons(`桌面端占用中：${threadId}\n\n是否强制释放并由 TG 接管？\n\n这会重启 ChatGPT 的桌面 Codex 后端，但不会退出 ChatGPT 窗口。桌面端所有正在执行的 Codex 任务、等待中的审批和终端都可能被中断；已经产生的文件或外部操作不会回滚。\n\nBridge 只会匹配 ChatGPT 主进程直属的一个 Codex App Server，排除自己的 worker；目标不唯一时会拒绝。只请求 SIGTERM，不会使用 SIGKILL。\n\n确认后只接管会话，不会自动重发刚才失败的任务。请在两分钟内重新发送任务，否则 TG 会自动释放 writer。`,rows);
  }
  async confirmDesktopTakeover(data) {
    this.requireIdle();
    this.expireGrantGroup(data.group);
    const meta=await this.metadata(data.threadId),cwd=allowedThread(this.config,meta);
    this.selected=meta;this.previewed=null;this.managed.set(meta.id,meta);this.loadedThreadId=null;this.loadedGeneration=null;
    this.project=this.config.projects.find(project=>within(project.cwd,cwd));
    const overrides=await this.models.overrides();let restarted=false;
    try {await this.ensureSelectedLoaded(overrides);}
    catch(error) {
      if(!String(error?.message||'').includes('already has an active writer')) throw error;
      await this.desktopTakeover.release({excludePid:this.rpc.child?.pid});restarted=true;
      try {await this.ensureSelectedLoaded(overrides);}
      catch {
        await this.releaseWorker(meta.id);
        const failed=new Error('桌面 Codex 后端已经收到释放请求，但桌面端可能自动重新占用，TG 未能安全接管。请在桌面端切换到其他会话后重试。');
        failed.code='DESKTOP_TAKEOVER_RACE';throw failed;
      }
    }
    this.reserveTakeover(meta.id);
    return this.say(`${restarted?'桌面 Codex 后端已释放，TG 已接管会话。':'桌面占用已经消失，TG 已接管会话。'}\n会话：${meta.id}\n\n请在两分钟内重新发送刚才的任务；旧任务没有自动提交或重发。任务结束后 TG 会立即释放 writer。`);
  }
  async approvalMenu() {
    const rows=[[{text:'自动审查（减少常规询问）',callback_data:this.button('approvalOffer','auto')}],[{text:'严格人工审批',callback_data:this.button('approvalOffer','strict')}]];
    return this.withButtons(`${this.approvalSettings.summary(this.active)}\n\nstrict：使用 user + untrusted，需要你在 TG 审批较多命令。\nauto：使用 Codex 原生 auto_review + on-request，由风险审查代理判断沙箱外请求；不是无条件允许。\n\n两种模式都保留 workspace-write，不开放整台 Mac，也不使用 danger-full-access 或 never。目录白名单不变。\n只改变本 Bot 后续任务，跨会话、重启保留；桌面配置不修改。${this.active?'\n当前任务还在运行，不能中途切换。请等结束，或 /stop 并等到已中止。':''}`,rows);
  }
  async offerApprovalMode(mode) {
    this.requireIdle();approvalPolicy(mode);
    const data={mode,revision:this.approvalSettings.revision,group:nonce()};
    const rows=[[{text:mode==='auto'?'确认启用自动审查':'确认使用严格审批',callback_data:this.button('approvalConfirm',data)},{text:'取消',callback_data:this.button('approvalCancel',data)}]];
    for(const b of rows[0]) this.buttons.get(b.callback_data.slice(2)).expires=this.now()+5*60000;
    return this.withButtons(`确认切换为：${this.approvalSettings.label(mode)}\n\n${mode==='auto'?'你发出任务后，沙箱允许的工作区读写照常执行；越界请求交给 Codex 原生风险审查代理决定，可能自动拒绝，也可能在风险可接受时批准。':'将对后续任务使用较严格的人工命令审批。'}\n\n仍保留 workspace-write 沙箱、当前项目目录和受限网络；不启用全盘权限、never 或无条件自动允许。/allow 加入目录白名单也不等于将它加入当前任务可写沙箱。\n这是下一次新建/恢复/发送任务时使用的设置，应用于此 Bot 后续各会话，重启保留；不会立即执行任务、不会批准或补发旧请求。\n设置只保存本机 bridge state/approval.json，不修改 ChatGPT 桌面设置。`,rows);
  }
  async confirmApprovalMode(data) {
    this.requireIdle();
    this.approvalSettings.set(data.mode,data.revision);
    this.expireGrantGroup(data.group);
    return this.say(`已保存：${this.approvalSettings.summary()}\n下次发送任务时生效；未执行任务、未批准任何旧请求。\n自动审查仍可能拒绝高风险操作或要求你确认。用 /approval strict 可恢复严格模式，/status 查看当前设置。`);
  }
  async directoryProblem(error) {
    const key=`${error.code}:${error.cwd}`;
    const last=this.directoryWarnings.get(key);
    if(last!=null && this.now()-last<30000) return;
    this.directoryWarnings.set(key,this.now());
    if(this.directoryWarnings.size>100) this.directoryWarnings.delete(this.directoryWarnings.keys().next().value);
    if(error.code==='DIRECTORY_PROTECTED') return this.say(safeError(error,this.config.token));
    let candidate;
    try {candidate=remoteCandidate(error.cwd,this.config);}catch(e){return this.say(`${safeError(error,this.config.token)}\n\n${safeError(e,this.config.token)}`);}
    return this.withButtons(`缺少的是“目录授权”，不等于项目仍在运行。\n路径：${candidate.cwd}\n\n可在 Telegram 申请授权这个具体目录；确认后才加入目录列表，不会自动重发刚才的任务。${this.active?'\n当前任务运行中，若请求已拒绝请等任务结束再 /allow；仍在等待的审批可用该审批下的目录授权按钮。':''}`,[[{text:'申请这个目录的授权',callback_data:this.button('directoryOffer',{cwd:candidate.requested,threadId:error.threadId})}]]);
  }
  async permissions() {
    this.grants.sync();
    const base=this.grants.base.map(p=>`${p.id} · 本机初始授权\n${p.cwd}`);
    const remote=this.grants.grants.map(g=>`${g.id} · TG授权${this.grants.valid(g)?'':'（失效，未加载）'}\n${g.cwd}`);
    return this.say(`目录授权（包含子目录）\n\n${[...base,...remote].join('\n\n')}\n\n/allow /完整/目录：申请新增并确认\n/revoke tg_代号：撤销TG新增授权（任务空闲时）\n撤销父授权不自动撤销另行授权的子目录；本机初始授权需本机管理。目录授权不是自动批准命令，也不是系统级文件防火墙。`);
  }
  requirePendingApproval(key) {
    const r=this.approvals.get(key);
    if(!r || r.expires<=this.now() || !this.isCurrent(r.msg.params) || this.settled.has(r.msg)) throw new Error('关联审批已结束或过期，未增加目录权限。');
    return r;
  }
  async offerGrant(proposals,{threadId=null,requestKey=null}={}) {
    if(requestKey) this.requirePendingApproval(requestKey);else this.requireIdle();
    const verified=proposals.map(p=>revalidateCandidate(p,this.config));
    if(!verified.length || verified.length>10) throw new Error('一次最多明确授权10个具体目录。');
    const data={proposals:verified,threadId,requestKey,revision:this.grantRevision,group:nonce()};
    const rows=[[{text:'确认加入目录白名单',callback_data:this.button('grantConfirm',data)},{text:'取消',callback_data:this.button('grantCancel',data)}]];
    for(const b of rows[0]) {
      const record=this.buttons.get(b.callback_data.slice(2));
      record.expires=Math.min(record.expires,this.now()+5*60000,requestKey?this.requirePendingApproval(requestKey).expires:Infinity);
    }
    return this.withButtons(`确认新增目录授权\n\n${verified.map((p,i)=>`${i+1}. ${p.cwd}${p.requested!==p.cwd?'\n输入路径：'+p.requested:''}`).join('\n\n')}\n\n范围：以上目录及其子目录，可用于读取会话与作为工作目录；不创建、不移动、不删除文件。\n持续到你 /revoke 撤销，重启后保留。会话与审批内容可能经 Telegram 云端传输。\n这里只加入桥接白名单，不授予系统全盘权限、不自动批准命令、不扩大当前沙箱。${requestKey?'\n确认目录后，还需另点“允许本次”批准原请求，原超时时间不延长。':'\n确认后自行选择会话或重新发任务，旧任务不会自动补发。'}\n不要授权包含密码、Token、私钥的目录。`,rows);
  }
  expireGrantGroup(group) {for(const [key,r] of this.buttons) if(r.data?.group===group) this.buttons.delete(key);}
  async confirmGrant(data) {
    if(data.revision!==this.grantRevision) throw new Error('目录授权状态已变化，旧确认失效，请重新申请。');
    const pending=data.requestKey?this.requirePendingApproval(data.requestKey):null;
    if(!pending) this.requireIdle();
    const added=this.grants.grant(data.proposals);
    this.grantRevision++;this.expireGrantGroup(data.group);this.directoryWarnings.clear();
    if(pending) {
      // Directory permission never implies execution permission. A new card has
      // the same live request and original expiry but requires another click.
      const missing=pending.missingDirectories();
      await this.renderApproval(data.requestKey,missing);
      return this.say('目录已授权，但命令/文件操作尚未批准。请核对审批详情，再决定是否“允许本次”。');
    }
    const rows=data.threadId?[[{text:'重新选择这个会话',callback_data:this.button('resumeOffer',data.threadId)}]]:[];
    return this.withButtons(`目录授权已保存：\n${data.proposals.map(p=>p.cwd).join('\n')}\n${added.length?'可用 /projects 选择，/permissions 查看或撤销。':'原有授权已覆盖，无需重复新增。'}\n未启动任务，之前失败的任务不会自动重发。`,rows);
  }
  async offerRevoke(id) {
    this.requireIdle();
    const grant=this.grants.grants.find(g=>g.id===id);
    if(!grant) return this.say('用法：/revoke tg_授权代号\n先 /permissions 查看代号。这里只撤销TG新增授权；本机初始授权需在 Mac 管理。');
    return this.withButtons(`确认撤销此TG授权？\n${grant.cwd}\n撤销不会删除文件或撤销已完成操作；若仍有其他父目录授权覆盖，访问仍然有效。`,[[{text:'确认撤销',callback_data:this.button('revokeConfirm',{id,revision:this.grantRevision})}]]);
  }
  async confirmRevoke(data) {
    this.requireIdle();if(data.revision!==this.grantRevision) throw new Error('授权状态已变化，请重新 /permissions。');
    const result=this.grants.revoke(data.id);this.grantRevision++;
    // Invalidate previously issued navigation and permission offers after a revoke.
    this.buttons.clear();this.previewed=null;this.directoryWarnings.clear();
    if(this.selected) {try{allowedThread(this.config,this.selected);}catch{this.selected=null;}}
    if(!this.config.projects.some(p=>p.id===this.project.id)) this.project=this.config.projects[0];
    return this.say(`已撤销TG授权：${result.record.cwd}\n${result.stillCovered?'注意：另一个授权目录仍覆盖此路径，因此仍可访问。':'桥接将阻止新的会话连接或审批访问此目录。'}\n未删除文件，已经完成的操作不会回滚。`);
  }
  async pendingDirectoryOffer(q,key) {
    const record=this.requirePendingApproval(key);
    if(record.messageId!==q.message.message_id) throw new Error('审批消息不匹配。');
    const proposals=record.missingDirectories();
    if(!proposals.length) {await this.renderApproval(key,[]);return;}
    return this.offerGrant(proposals,{requestKey:key});
  }
  async renderApproval(key,missing) {
    const record=this.requirePendingApproval(key),p=record.msg.params;
    const old=record.messageId;record.messageId=null;
    if(old) Promise.resolve().then(()=>this.tg.clear(this.config.chatId,old)).catch(()=>{});
    const row=missing.length?[{text:'先授权所需目录',callback_data:`d:${key}`},{text:'拒绝本次',callback_data:`a:${key}:no`}]:[{text:'允许本次',callback_data:`a:${key}:yes`},{text:'拒绝',callback_data:`a:${key}:no`}];
    const message=await this.say(`${record.detail}\n\n会话：${p.threadId}\n任务：${p.turnId}${missing.length?'\n尚未授权目录：\n'+missing.map(x=>x.cwd).join('\n'):''}\n剩余确认时间约${Math.max(0,Math.ceil((record.expires-this.now())/1000))}秒；目录授权和执行审批分开。`,[row]);
    record.messageId=message.message_id;
    if(!this.approvals.has(key) || record.expires<=this.now()) await this.tg.clear(this.config.chatId,message.message_id);
  }
  async modelMenu(page=0) {
    this.requireIdle();
    const models=await this.models.catalog(true),start=page*8,shown=models.slice(start,start+8);
    if (!shown.length) throw new Error('模型列表已变化，请重新发送 /model。');
    const rows=shown.map(m=>[{text:`${m.model===this.models.choice.model?'✓ ':''}${m.displayName||m.model}`.slice(0,60),callback_data:this.button('model',m.model)}]);
    const nav=[];
    if (page>0) nav.push({text:'上一页',callback_data:this.button('modelPage',page-1)});
    if (start+8<models.length) nav.push({text:'下一页',callback_data:this.button('modelPage',page+1)});
    if (nav.length) rows.push(nav);
    rows.push([{text:'沿用会话/配置（取消覆盖）',callback_data:this.button('model','default')}]);
    return this.withButtons(`${this.models.summary(this.selected)}\n\n可选模型（来自当前 Codex）：\n${shown.map(m=>`${m.displayName||m.model}\nID：${m.model}\n支持强度：${this.models.levels(m).map(o=>o.reasoningEffort).join(', ')||'无可选强度'}`).join('\n\n')}\n\n选择后对本 Bot 后续的新任务和恢复后的回复生效，重启保留；不会改变当前正在执行的任务。`,rows);
  }
  async chooseModel(value) {
    this.requireIdle(); const model=await this.models.setModel(value);
    if (!model) return this.say('已取消模型与强度覆盖，后续沿用当前会话/配置。注意：Codex 已执行任务的模型设置具有延续性，这不是恢复最初模型。');
    return this.withButtons(`已保存后续任务设置：\n${this.models.summary(this.selected)}\n切换模型已重置为这个模型自身的默认强度。不会立即启动任务。`,[[{text:'选择推理强度',callback_data:this.button('effortMenu',null)}]]);
  }
  async effortMenu() {
    this.requireIdle(); const model=await this.models.effectiveModel(this.selected,true),levels=this.models.levels(model);
    if (!levels.length) return this.say(`模型 ${model.model} 未提供可选推理强度。`);
    const rows=levels.map(o=>[{text:`${o.reasoningEffort}${o.reasoningEffort===model.defaultReasoningEffort?'（默认）':''}`,callback_data:this.button('effort',{model:model.model,effort:o.reasoningEffort})}]);
    return this.withButtons(`推理强度 · ${model.displayName||model.model}\n当前设置：${this.models.choice.effort||this.selected?.reasoningEffort||'沿用会话/配置'}\n\n${levels.map(o=>`${o.reasoningEffort}：${o.description||'Codex 支持的选项'}`).join('\n')}\n\n选择后绑定此模型，对本 Bot 后续任务生效；更高强度通常耗时更长。`,rows);
  }
  async chooseEffort(value,expectedModel=null) {
    this.requireIdle(); await this.models.setEffort(value,this.selected,expectedModel);
    return this.say(`已保存：\n${this.models.summary(this.selected)}\n下次发送任务时生效，当前不会启动任务。`);
  }
  async projects() {
    const rows=this.config.projects.map(p=>[{text:`${p.id} · ${p.name}`,callback_data:this.button('project',p.id)}]);
    return this.withButtons(`当前项目：${this.project.name}\n显示本机初始授权与已确认的TG授权目录。选择后可用 /threads 或 /new；/permissions 查看与撤销远程授权。`,rows);
  }
  async list(query='',cursor=null,archived=false,projectId=this.project.id) {
    const project=this.config.projects.find(p=>p.id===projectId); if (!project) throw new Error('项目已失效。');
    const page=await this.threads.page(project,query,archived,cursor);
    const visible=page.threads;
    if (!visible.length && !page.next) return this.say(`${project.name}：未找到${archived?'归档':''}会话。\n范围包含该目录及子目录；仅展示普通来源会话，子代理记录不重复展示。请检查 CODEX_HOME、搜索词、会话是否归档，以及目录是否仍存在。`);
    const lines=[`${project.name} · ${archived?'归档历史（只读）':'历史会话'}`, `范围：${project.cwd}（包含子目录）`, visible.length?`第 ${page.start+1}–${page.start+visible.length} 条${page.next?' · 可继续翻页':' · 已到末页'}`:'尚未在这批索引中找到匹配会话，请点继续检索。', '点击可查看最近对话或确认恢复。']; const rows=[];
    for (let i=0;i<visible.length;i++) {
      const t=visible[i], title=String(t.name || t.preview || '未命名会话').replace(/\s+/g,' ').slice(0,90);
      const number=page.start+i+1;
      lines.push(`\n${number}. ${title}\n目录：${path.relative(project.cwd,t.cwd)||'.'}\n${t.id}`);
      const row=[{text:`${number} 仅查看`,callback_data:this.button('history',{id:t.id,readOnly:archived})}];
      if (!archived) row.push({text:`${number} 选择会话`,callback_data:this.button('resumeOffer',t.id)});
      rows.push(row);
    }
    if (page.next) rows.push([{text:visible.length?'下一页':'继续检索',callback_data:this.button('page',{query,cursor:page.next,archived,projectId})}]);
    rows.push([{text:'刷新列表',callback_data:this.button('page',{query,cursor:null,archived,projectId})}]);
    return this.withButtons(lines.join('\n'),rows);
  }
  async metadata(id) {
    if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('请先选择会话，或提供有效会话 ID。');
    const {thread}=await this.rpc.call('thread/read',{threadId:id,includeTurns:false});
    if(thread?.id!==id) throw new Error('返回的会话ID与请求不一致，已停止。');
    try{allowedThread(this.config,thread);}catch(e){
      if(e.code==='DIRECTORY_NOT_AUTHORIZED') e.threadId=id;
      if(e.code==='DIRECTORY_NOT_AUTHORIZED' || e.code==='DIRECTORY_PROTECTED') this.previewed={id,name:id,readOnly:false};
      throw e;
    } return thread;
  }
  async history(id,{readOnly=false}={}) {
    const meta=await this.metadata(id); let items;
    this.previewed={id:meta.id,name:meta.name||meta.id,readOnly};
    if (meta.historyMode==='paginated') {
      const page=await this.rpc.call('thread/items/list',{threadId:id,limit:40,sortDirection:'desc'});
      items=(page.data||[]).map(e=>e.item).reverse();
    } else {
      const {thread}=await this.rpc.call('thread/read',{threadId:id,includeTurns:true});
      allowedThread(this.config,thread); items=(thread.turns||[]).flatMap(t=>t.items||[]);
    }
    const messages=items.filter(x=>x && ['userMessage','agentMessage'].includes(x.type)).slice(-8);
    const selected=[];let budget=16000,omitted=false;
    for (const item of [...messages].reverse()) {
      const body=item.type==='userMessage'?(item.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'):item.text||'';
      if(body.length>budget) {
        if(!selected.length) selected.unshift({role:item.type,text:chunks(body,16000)[0],truncated:true});
        omitted=true;break;
      }
      selected.unshift({role:item.type,text:body,truncated:false});budget-=body.length;
    }
    await this.say(`历史预览 · ${meta.name||id}\n会话ID：${meta.id}\n这里只是查看记录，不会开始工作。最多8条，仅用户和助手文字。${omitted?'\n记录较长，部分历史省略；截断内容不提供代码复制按钮。':''}`);
    if (!selected.length) await this.say('暂无可展示的文字记录。');
    for (const item of selected) {
      // Render each original message separately: fences must not cross roles.
      await this.say(item.role==='userMessage'?'你（历史记录）：':'Codex（历史记录）：');
      if(item.truncated) await this.say(`以下为截断预览，非完整内容，请勿当作完整命令执行：\n${item.text}\n（其余内容请在 Mac 查看）`);
      else await this.rich(item.text||'（空消息）');
    }
    if (readOnly) return this.say('这是归档历史的只读预览，未连接。若要继续，请先在 Mac 解除归档，再重新选择。');
    if (this.selected?.id===meta.id) return this.say(`这条会话已经选中：${meta.id}\n现在直接发送任务即可；执行时才会临时恢复，结束后自动释放。`);
    return this.withButtons(`当前只是预览，尚未选择这条会话。\n想继续对话，请点下面“选择此会话”。`,[[{text:'选择此会话',callback_data:this.button('resumeOffer',meta.id)}]]);
  }
  async connectionNeeded() {
    if (this.previewed?.readOnly) return this.say('你正在查看归档历史，未发送这条文字，也不会转发到其他会话。请先在 Mac 解除归档，再通过 /threads 连接。');
    if (this.previewed) return this.withButtons(`你刚才只查看了历史，尚未选择这条会话：\n${this.previewed.name}\n\n这条文字没有发送给 Codex，也没有排队。请点“选择此会话”，完成确认后重新发送任务。`,[[{text:'选择此会话',callback_data:this.button('resumeOffer',this.previewed.id)}]]);
    return this.withButtons('当前没有选择会话，这条文字未发送。\n请用 /threads 选择会话，或者用 /new <任务描述> 新建任务。',[[{text:'选择会话',callback_data:this.button('page',{query:'',cursor:null,archived:false,projectId:this.project.id})}]]);
  }
  async offerResume(id) {
    this.requireIdle(); const thread=await this.metadata(id);
    if (thread.status?.type==='active') {const error=new Error('桌面任务占用中。');error.code='DESKTOP_WRITER_BUSY';error.threadId=thread.id;throw error;}
    this.previewed={id:thread.id,name:thread.name||thread.id,readOnly:false};
    return this.withButtons(`准备选择（不会恢复会话）：${thread.name || thread.id}\n目录：${thread.cwd}\n\n确认后只保存会话 ID，不持有 writer，也不会执行任务。你随后发送任务时，TG 才会启动临时 worker；若桌面任务仍在运行，TG 会明确提示占用，不会抢锁。`,[[{text:'选择此会话',callback_data:this.button('resume',thread.id)}]]);
  }
  policy() { return {approvalPolicy:this.approvalSettings.policy(),approvalsReviewer:this.approvalSettings.reviewer(),sandbox:'workspace-write'}; }
  markLoaded(threadId) { this.loadedThreadId=threadId; this.loadedGeneration=this.rpc.generation??null; }
  async ensureSelectedLoaded(overrides={}) {
    await this.waitForRelease();
    await this.rpc.start?.();
    const rpcGeneration=this.rpc.generation;
    // Lightweight test transports and older adapters have no lifecycle
    // generation; in that case the selected session is already connected.
    if (rpcGeneration==null || this.loadedThreadId===this.selected.id && this.loadedGeneration===rpcGeneration) return;
    const meta=this.selected, cwd=allowedThread(this.config,meta);
    const response=await this.rpc.call('thread/resume',{threadId:meta.id,cwd,...this.policy(),...(overrides.model?{model:overrides.model}:{}),...(meta.historyMode==='paginated'?{excludeTurns:true}:{})});
    const thread={...response.thread,model:response.model||response.thread?.model,reasoningEffort:response.reasoningEffort??response.thread?.reasoningEffort};
    allowedThread(this.config,thread);
    if (thread.id!==meta.id) throw new Error('恢复接口返回的会话 ID 不一致，已停止。');
    this.selected=thread; this.managed.set(thread.id,thread); this.markLoaded(thread.id);
  }
  async resume(id) {
    this.requireIdle(); const meta=await this.metadata(id);
    if (meta.status?.type==='active') {const error=new Error('桌面任务占用中。');error.code='DESKTOP_WRITER_BUSY';error.threadId=meta.id;throw error;}
    const cwd=allowedThread(this.config,meta);
    this.selected=meta; this.previewed=null; this.managed.set(id,meta);
    this.loadedThreadId=null; this.loadedGeneration=null;
    this.project=this.config.projects.find(p=>within(p.cwd,cwd));
    return this.say(`已选择会话（尚未恢复）：${meta.name || meta.id}\n${this.models.summary(meta)}\n${this.approvalSettings.summary()}\n现在直接发任务即可。TG 会临时恢复会话，任务结束后立即释放 writer；空闲时桌面端可正常查看最新上下文。`);
  }
  async newThread(prompt) {
    await this.waitForRelease();
    this.requireIdle();
    if(this.takeoverReservation) await this.releaseWorker(this.takeoverReservation.threadId);
    allowedThread(this.config,{id:'new-thread',cwd:this.project.cwd});
    const overrides=await this.models.overrides();
    const response=await this.rpc.call('thread/start',{cwd:this.project.cwd,...this.policy(),ephemeral:false,...(overrides.model?{model:overrides.model}:{})});
    const thread={...response.thread,model:response.model||response.thread?.model,reasoningEffort:response.reasoningEffort??response.thread?.reasoningEffort};
    allowedThread(this.config,thread);
    this.selected=thread; this.previewed=null; this.managed.set(thread.id,thread);
    this.markLoaded(thread.id);
    await this.say(`已新建会话：${thread.id}\n项目：${this.project.name}`);
    return this.startTurn(prompt);
  }
  async handlePhotoMessage(m) {
    try {
      await this.waitForRelease();
      this.requireIdle();
      if (!this.selected || this.previewed && (this.previewed.readOnly || this.previewed.id!==this.selected.id)) return this.connectionNeeded();
      const descriptor=incomingAttachment(m);
      if (!descriptor?.image) throw new Error('无效的图片附件。');
      await this.say('正在接收图片…');
      const bytes=await this.tg.download(descriptor.fileId,{maxBytes:20_000_000});
      const saved=saveAttachment(this.config,this.selected,descriptor,bytes);
      this.uploadNames.set(saved.path,saved.originalName);
      if(this.uploadNames.size>500) this.uploadNames.delete(this.uploadNames.keys().next().value);
      const cwd=allowedThread(this.config,this.selected);
      const caption=typeof m.caption==='string'?m.caption.trim():'';

      const id = this.selected.id;
      const taskSettings = await this.models.overrides();
      this.clearTakeoverReservation();
      await this.ensureSelectedLoaded(taskSettings);
      this.active = { threadId: id, turnId: null, approvalMode: this.approvalSettings.mode };

      try {
        const input=[{type:'localImage',path:saved.path}];
        if(caption) input.unshift({type:'text',text:caption});
        const result = await this.rpc.call('turn/start', {
          ...taskSettings,
          threadId: id,
          input,
          cwd,
          approvalPolicy: this.approvalSettings.policy(),
          approvalsReviewer: this.approvalSettings.reviewer(),
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [cwd],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true
          }
        });

        const turn = result.turn;
        if (!turn?.id) throw new Error('Codex 未返回有效任务 ID；请在 Mac 检查后重启，勿重复发送。');
        if (this.active?.threadId === id && !this.finished.has(turn.id)) this.active.turnId = turn.id;
        if (taskSettings.model) this.selected.model = taskSettings.model;
        if (taskSettings.effort) this.selected.reasoningEffort = taskSettings.effort;

        await this.say(`图片已作为附件提交：${turn.id}\n${this.models.summary(this.selected)}`);
      } catch (e) {
        if (e.code && this.active?.threadId === id && !this.active.turnId) {
          this.active = null; await this.releaseWorker(id);
        }
        throw e;
      }
    } catch (e) {
      return this.report(e);
    }
  }

  async handleDocumentMessage(m) {
    try {
      await this.waitForRelease();
      this.requireIdle();
      if (!this.selected || this.previewed && (this.previewed.readOnly || this.previewed.id!==this.selected.id)) return this.connectionNeeded();
      const descriptor=incomingAttachment(m);
      if (!descriptor || descriptor.image) throw new Error('无效的文件附件。');
      await this.say(`正在接收文件：${descriptor.originalName}…`);
      const bytes=await this.tg.download(descriptor.fileId,{maxBytes:20_000_000});
      const saved=saveAttachment(this.config,this.selected,descriptor,bytes);
      this.uploadNames.set(saved.path,saved.originalName);
      if(this.uploadNames.size>500) this.uploadNames.delete(this.uploadNames.keys().next().value);
      const cwd=allowedThread(this.config,this.selected);
      const caption=typeof m.caption==='string'?m.caption.trim():'';
      const id = this.selected.id;
      const taskSettings = await this.models.overrides();
      this.clearTakeoverReservation();
      await this.ensureSelectedLoaded(taskSettings);
      this.active = { threadId: id, turnId: null, approvalMode: this.approvalSettings.mode };

      try {
        const result = await this.rpc.call('turn/start', {
          ...taskSettings,
          threadId: id,
          input:[documentInput(caption,saved)],
          cwd,
          approvalPolicy: this.approvalSettings.policy(),
          approvalsReviewer: this.approvalSettings.reviewer(),
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [cwd],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true
          }
        });

        const turn = result.turn;
        if (!turn?.id) throw new Error('Codex 未返回有效任务 ID；请在 Mac 检查后重启，勿重复发送。');
        if (this.active?.threadId === id && !this.finished.has(turn.id)) this.active.turnId = turn.id;
        if (taskSettings.model) this.selected.model = taskSettings.model;
        if (taskSettings.effort) this.selected.reasoningEffort = taskSettings.effort;
        await this.say(`文件已提交：${turn.id}\n📎 ${saved.originalName}\n${this.models.summary(this.selected)}`);
      } catch (e) {
        if (e.code && this.active?.threadId === id && !this.active.turnId) {
          this.active = null; await this.releaseWorker(id);
        }
        throw e;
      }
    } catch (e) {
      return this.report(e);
    }
  }

  async startTurn(text) {
    await this.waitForRelease();
    this.requireIdle();
    if (!this.selected || this.previewed && (this.previewed.readOnly || this.previewed.id!==this.selected.id)) return this.connectionNeeded();
    if (!text || text.length>30000) throw new Error('任务文字不能为空，也不能超过 30000 字符。');
    const cwd=allowedThread(this.config,this.selected), id=this.selected.id;
    const taskSettings=await this.models.overrides();
    this.clearTakeoverReservation();
    await this.ensureSelectedLoaded(taskSettings);
    this.active={threadId:id,turnId:null,approvalMode:this.approvalSettings.mode};
    try {
      const result=await this.rpc.call('turn/start',{...taskSettings,threadId:id,input:[{type:'text',text}],cwd,approvalPolicy:this.approvalSettings.policy(),approvalsReviewer:this.approvalSettings.reviewer(),sandboxPolicy:{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}});
      const turn=result.turn;
      if (!turn?.id) throw new Error('Codex 未返回有效任务 ID；请在 Mac 检查后重启，勿重复发送。');
      if (this.active?.threadId===id && !this.finished.has(turn.id)) this.active.turnId=turn.id;
      if (taskSettings.model) this.selected.model=taskSettings.model;
      if (taskSettings.effort) this.selected.reasoningEffort=taskSettings.effort;
      await this.say(`任务已提交：${turn.id}\n${this.models.summary(this.selected)}\n${this.approvalSettings.summary(this.active)}\n需要 Codex 审批时会发来按钮；/stop 可请求中止。`);
    } catch(e) {
      // Do not clear an uncertain start: fail closed until explicit stop/restart.
      if (e.code && this.active?.threadId===id && !this.active.turnId) {
        this.active=null; await this.releaseWorker(id);
      }
      throw e;
    }
  }
  async stop() {
    if (!this.active) return this.say('没有由此桥接运行的任务。');
    if (!this.active.turnId) throw new Error('任务 ID 尚未确认。请在 Mac 检查；程序不会猜测或重发任务。');
    const {threadId,turnId}=this.active;
    this.active.stopping=true;
    this.invalidateTurn(threadId,turnId,true);
    await this.rpc.call('turn/interrupt',{threadId,turnId});
    return this.say('中止请求已提交，等待 Codex 确认。已经完成的文件修改或外部操作不会回滚。');
  }
  async callback(q) {
    if (!this.authorized(q.from,q.message?.chat)) { try { await this.tg.ack(q.id,'无权操作'); } catch {} return; }
    try {
      // Spinner acknowledgement is independent from action authorization. A
      // transient ack failure must not discard a legitimate received click.
      Promise.resolve().then(()=>this.tg.ack(q.id)).catch(e=>this.diagnostic('callback-ack-failed',e));
      await this.waitForRelease();
      const data=String(q.data||'');
      if (data.startsWith('a:')) return await this.decide(q,data);
      if (data.startsWith('d:')) return await this.pendingDirectoryOffer(q,data.slice(2));
      const key=data.startsWith('b:')?data.slice(2):''; const record=this.buttons.get(key);
      if (!record || record.expires<=this.now() || record.messageId!==q.message.message_id) return this.say('按钮已失效，请重新发送指令。');
      const navigation=['history','resumeOffer','page','modelPage','effortMenu'].includes(record.kind);
      if (!navigation) {
        if(record.kind==='grantConfirm' && record.data.requestKey) this.requirePendingApproval(record.data.requestKey);
        else if(!['grantCancel','approvalCancel'].includes(record.kind)) this.requireIdle();
        this.buttons.delete(key);
        // UI cleanup is cosmetic; server-side token consumption enforces once.
        Promise.resolve().then(()=>this.tg.clear(this.config.chatId,q.message.message_id)).catch(e=>this.diagnostic('keyboard-clear-failed',e));
      }
      const d=record.data;
      if (record.kind==='desktopTakeoverConfirm') return await this.confirmDesktopTakeover(d);
      if (record.kind==='desktopTakeoverCancel') {this.expireGrantGroup(d.group);return await this.say('已取消桌面接管；没有结束任何进程，也没有提交任务。');}
      if (record.kind==='approvalOffer') return await this.offerApprovalMode(d);
      if (record.kind==='approvalConfirm') return await this.confirmApprovalMode(d);
      if (record.kind==='approvalCancel') {this.expireGrantGroup(d.group);return await this.say('已取消审批模式切换，原设置保持不变。');}
      if (record.kind==='grantConfirm') return await this.confirmGrant(d);
      if (record.kind==='grantCancel') {this.expireGrantGroup(d.group);return await this.say('已取消目录授权，原权限不变。关联操作尚未批准，可在审批消息中点拒绝或等待超时。');}
      if (record.kind==='revokeConfirm') return await this.confirmRevoke(d);
      if (record.kind==='directoryOffer') return await this.offerGrant([remoteCandidate(d.cwd,this.config)],{threadId:d.threadId});
      if (record.kind==='model') return await this.chooseModel(d);
      if (record.kind==='modelPage') return await this.modelMenu(d);
      if (record.kind==='effortMenu') return await this.effortMenu();
      if (record.kind==='effort') return await this.chooseEffort(d.effort,d.model);
      if (record.kind==='history') return await this.history(typeof d==='string'?d:d.id,typeof d==='string'?{}:{readOnly:d.readOnly});
      if (record.kind==='resumeOffer') return await this.offerResume(d);
      if (record.kind==='resume') return await this.resume(d);
      if (record.kind==='page') return await this.list(d.query,d.cursor,d.archived,d.projectId);
      if (record.kind==='project') {
        this.requireIdle(); const project=this.config.projects.find(p=>p.id===d); if(!project) throw new Error('项目授权已撤销或失效，请重新 /projects。'); this.project=project; this.selected=null; this.previewed=null;
        return this.say(`已选择 ${this.project.name}\n${this.project.cwd}\n用 /threads 查看历史，或 /new <任务描述> 开始。`);
      }
    } catch(e) { return this.report(e); }
  }
  isCurrent(params) {
    return !this.broken && this.active && !this.active.stopping && typeof params.turnId==='string' && params.threadId===this.active.threadId && (!this.active.turnId || params.turnId===this.active.turnId) && !this.finished.has(params.turnId);
  }
  reply(msg,result) {
    if (this.settled.has(msg)) return;
    // Mark before writing, so a transport failure cannot cause a second decision.
    this.settled.add(msg);
    if (result===undefined) this.rpc.reject(msg.id); else this.rpc.respond(msg.id,result);
  }
  deny(msg) {
    if ([CMD,FILE].includes(msg.method)) this.reply(msg,{decision:'decline'});
    else if (msg.method===PERMISSION) this.reply(msg,{permissions:{},scope:'turn'});
    else if (msg.method===INPUT) this.reply(msg,{answers:{}});
    else this.reply(msg);
  }
  allowedNetworkAmendment(params) {
    const context=params.networkApprovalContext;
    if (!context || context.protocol!=='https' || typeof context.host!=='string') return null;
    const host=context.host.trim().toLowerCase();
    if (!this.networkAllowedDomains.has(host)) return null;
    const amendment=(params.proposedNetworkPolicyAmendments||[]).find(item=>item?.host?.toLowerCase()===host && item.action==='allow');
    return amendment?{host,action:'allow'}:null;
  }
  async serverRequest(msg) {
    if (this.requests.has(msg.id)) return;
    if (this.requests.size>=10000) { this.rpc.fail(new Error('本次连接的交互请求已达上限，请在 Mac 重启。')); return; }
    this.requests.set(msg.id,msg);
    const p=msg.params||{};
    if (!this.isCurrent(p)) { this.deny(msg); return; }
    if (!this.active.turnId && p.turnId) this.active.turnId=p.turnId;
    if (msg.method===CMD) {
      const amendment=this.allowedNetworkAmendment(p);
      if (amendment) {
        this.reply(msg,{decision:{applyNetworkPolicyAmendment:{network_policy_amendment:amendment}}});
        return;
      }
    }
    if (msg.method===INPUT) return this.askInput(msg);
    if (![CMD,FILE].includes(msg.method)) {
      this.deny(msg); await this.say(`Codex 请求了暂未支持的交互（${msg.method}），已拒绝；未授予额外权限。`); return;
    }
    let detail='', missingDirectories=()=>[], recheck=()=>{};
    if (msg.method===CMD) {
      if ((p.kind && p.kind!=='command') || !p.command || !p.cwd) { this.deny(msg); return this.say('审批缺少完整命令、目录，或属于终端输入审批，已拒绝。请在 Mac 处理。'); }
      // A different command cwd requires a separate local project authorization.
      missingDirectories=()=>requiredCommandDirectories(this.config,p.cwd);
      detail=`命令执行审批\n\n目录：${p.cwd}\n命令（完整）：\n${p.command}\n\n原因：${p.reason || '未提供'}\n${p.networkApprovalContext ? `网络上下文：${JSON.stringify(p.networkApprovalContext)}\n` : ''}允许可能使本次命令获得超出常规沙箱的权限；目录白名单不是命令行为防火墙。`;
    } else {
      const item=this.items.get(`${p.threadId}:${p.turnId}:${p.itemId}`);
      if (p.grantRoot || !item?.changes?.length || item.changes.some(c=>typeof c.diff!=='string' || !c.path)) {
        this.deny(msg); return this.say('文件审批缺少可核对的完整 diff，或请求长期扩展写入根目录，已拒绝。请回到 Mac 检查。');
      }
      const cwd=this.managed.get(p.threadId)?.cwd;
      missingDirectories=()=>requiredFileDirectories(this.config,cwd,item.changes);
      detail=`文件变更审批\n原因：${p.reason||'未提供'}\n\n${item.changes.map(c=>`${c.path}\n类型：${JSON.stringify(c.kind)}\n${c.diff}`).join('\n\n')}`;
    }
    // Never attach an approve button to truncated details.
    if (detail.length>12000 || /[\u202a-\u202e\u2066-\u2069]/u.test(detail)) { this.deny(msg); return this.say('审批详情过长或含有双向文本控制字符，无法安全展示，已拒绝。请在 Mac 审查。'); }
    let missing;
    try {missing=missingDirectories();} catch(e) {this.deny(msg);return this.report(e);}
    recheck=()=>{if(missingDirectories().length) throw new Error('目录授权不足或已失效，本次操作未允许执行。');};
    const key=nonce(), record={msg,recheck,missingDirectories,detail,expires:this.now()+this.config.approvalTimeoutSeconds*1000,messageId:null,timer:null};
    this.approvals.set(key,record);
    record.timer=setTimeout(()=>{ void this.expire(key); },this.config.approvalTimeoutSeconds*1000); record.timer.unref?.();
    try {
      await this.renderApproval(key,missing);
    } catch(e) {
      if (this.approvals.delete(key)) { clearTimeout(record.timer); this.deny(msg); }
      throw e;
    }
  }
  async decide(q,data) {
    const match=data.match(/^a:([A-Za-z0-9_-]{16}):(yes|no)$/); const key=match?.[1], record=this.approvals.get(key);
    if (!record || record.messageId!==q.message.message_id) return this.say('审批不存在、已经处理或已失效。');
    if (record.expires<=this.now() || !this.isCurrent(record.msg.params)) { await this.expire(key); return this.say('审批已过期，未授权执行。'); }
    this.approvals.delete(key); clearTimeout(record.timer);
    if (match[2]==='yes') {
      try { record.recheck(); }
      catch(e) { this.deny(record.msg); await this.tg.clear(this.config.chatId,record.messageId); throw e; }
    }
    this.reply(record.msg,{decision:match[2]==='yes'?'accept':'decline'});
    await this.tg.clear(this.config.chatId,record.messageId);
    return this.say(match[2]==='yes'?'已将“允许本次”提交给 Codex；不代表任务已完成。':'已将拒绝决定提交给 Codex。');
  }
  async expire(key) {
    const r=this.approvals.get(key); if (!r) return;
    this.approvals.delete(key); clearTimeout(r.timer);
    try { this.deny(r.msg); } catch {}
    if (r.messageId) await this.tg.clear(this.config.chatId,r.messageId);
    try { await this.say('一项审批已超时或失效，未允许执行。'); } catch {}
  }
  async askInput(msg) {
    const questions=msg.params.questions;
    if (!Array.isArray(questions) || !questions.length || questions.length>10 || questions.some(q=>!q || q.isSecret || typeof q.id!=='string' || !q.id || typeof q.question!=='string') || new Set(questions.map(q=>q.id)).size!==questions.length) {
      this.deny(msg); await this.say('此提问包含敏感输入或不受支持的结构，未转发。请在 Mac 处理；不要在 Telegram 发送密码。'); return;
    }
    const group={msg,answers:Object.create(null),remaining:new Set(),timer:null,expires:this.now()+this.config.approvalTimeoutSeconds*1000};
    for (const q of questions) {
      const key=nonce(); group.remaining.add(key); this.questions.set(key,{question:q,group});
    }
    group.timer=setTimeout(()=>{
      for (const key of group.remaining) this.questions.delete(key);
      group.remaining.clear(); try { this.deny(msg); } catch {}
      void this.say('Codex 提问已超时，已结束等待。').catch(()=>{});
    },this.config.approvalTimeoutSeconds*1000); group.timer.unref?.();
    try {
      for (const key of group.remaining) {
        const q=this.questions.get(key).question;
        const options=(q.options||[]).map(o=>`${o.label}：${o.description||''}`).join('\n');
        await this.say(`Codex 需要你回答：\n${q.header||''}\n${q.question}\n${options}\n\n回复：/answer ${key} 你的回答\n不要发送密码或 Token。`);
      }
    } catch(e) {
      for (const key of group.remaining) this.questions.delete(key);
      group.remaining.clear(); clearTimeout(group.timer); this.deny(msg); throw e;
    }
  }
  async answer(arg) {
    const m=arg.match(/^(\S+)\s+([\s\S]+)$/), record=this.questions.get(m?.[1]);
    if (!record || !this.isCurrent(record.group.msg.params)) throw new Error('问题编号无效或已过期；用法：/answer <编号> <回答>。');
    if (record.group.expires<=this.now()) {
      for (const key of record.group.remaining) this.questions.delete(key);
      record.group.remaining.clear(); clearTimeout(record.group.timer); this.deny(record.group.msg);
      throw new Error('问题已过期，未提交回答。');
    }
    const key=m[1], answer=m[2].trim(); if (!answer) throw new Error('回答不能为空。');
    if (record.question.options?.length && !record.question.isOther && !record.question.options.some(o=>o.label===answer)) throw new Error('请回复一个列出的选项名称；这个问题不允许自定义答案。');
    record.group.answers[record.question.id]={answers:[answer]};
    this.questions.delete(key); record.group.remaining.delete(key);
    if (!record.group.remaining.size) { clearTimeout(record.group.timer); this.reply(record.group.msg,{answers:record.group.answers}); }
    return this.say(record.group.remaining.size?'已记录，请继续回答剩余问题。':'回答已提交给 Codex。');
  }
  requestFailed(msg,e) { try { this.deny(msg); } catch {} void this.report(e); }
  invalidateTurn(threadId,turnId,respond=false) {
    for (const [key,r] of this.approvals) if (r.msg.params.threadId===threadId && r.msg.params.turnId===turnId) {
      this.approvals.delete(key); clearTimeout(r.timer); if (respond) { try { this.deny(r.msg); } catch {} } else this.settled.add(r.msg);
      if (r.messageId) void this.tg.clear(this.config.chatId,r.messageId);
    }
    const groups=new Set();
    for (const [key,r] of this.questions) if (r.group.msg.params.threadId===threadId && r.group.msg.params.turnId===turnId) { groups.add(r.group); this.questions.delete(key); }
    for (const group of groups) { clearTimeout(group.timer); group.remaining.clear(); if (respond) { try { this.deny(group.msg); } catch {} } else this.settled.add(group.msg); }
    for (const key of this.items.keys()) if (key.startsWith(`${threadId}:${turnId}:`)) this.items.delete(key);
  }
  async finishTurn(threadId,turn) {
    let outputWarning=false;
    try { await this.cleanupStreamingMessage(turn.id); await this.flushFileOutputs(threadId,turn.id); }
    catch(error) { outputWarning=true; this.diagnostic('turn-output-failed',error); }
    this.invalidateTurn(threadId,turn.id);
    if (this.active?.threadId===threadId && (!this.active.turnId || this.active.turnId===turn.id)) this.active=null;
    try { await this.say(`任务${turn.status==='completed'?'已完成':turn.status==='interrupted'?'已中止':'已结束'}：${turn.id}\n状态：${turn.status}${turn.error?`\n${safeError(turn.error,this.config.token)}`:''}${outputWarning?'\n部分输出未能回传，请在桌面端核对。':''}\n临时 worker 正在释放；完成后桌面端可接手此会话。`); }
    finally { await this.releaseWorker(threadId); }
  }
  async notification(msg) {
    const p=msg.params||{};
    if (msg.method==='serverRequest/resolved') {
      const original=this.requests.get(p.requestId); if (original) this.settled.add(original);
      for (const [key,r] of this.approvals) if (r.msg.id===p.requestId) { this.approvals.delete(key); clearTimeout(r.timer); if (r.messageId) void this.tg.clear(this.config.chatId,r.messageId); }
      const groups=new Set();
      for (const [key,r] of this.questions) if (r.group.msg.id===p.requestId) { groups.add(r.group); this.questions.delete(key); }
      for (const g of groups) { clearTimeout(g.timer); g.remaining.clear(); }
      return;
    }
    if (!this.managed.has(p.threadId)) return;
    if (msg.method==='turn/started' && p.turn?.id && this.active?.threadId===p.threadId && (!this.active.turnId || this.active.turnId===p.turn.id) && !this.finished.has(p.turn.id)) this.active.turnId=p.turn.id;
    if (msg.method==='item/started' && this.isCurrent(p) && p.item?.type==='fileChange') this.items.set(`${p.threadId}:${p.turnId}:${p.item.id}`,p.item);

    // 流式输出：处理响应增量
    if (msg.method==='turn/response/delta' && this.isCurrent(p) && p.delta?.type==='text' && typeof p.delta.text==='string') {
      return this.handleStreamingDelta(p.turnId, p.delta.text);
    }

    if (msg.method==='item/completed' && this.isCurrent(p) && p.item?.type==='agentMessage' && p.item.text) {
      // 如果有流式消息，先清理它
      await this.cleanupStreamingMessage(p.turnId);
      this.queueLinkedFileOutputs(p.turnId,p.item.text);

      const displayText=telegramCodexText(p.item.text,this.uploadNames);
      const parts=chunks(displayText||'（Codex 返回了仅供桌面端显示的内容。）',30000);
      if(parts.length>1) return this.say(`Codex 回复过长，以下是截断预览，不提供代码复制，勿作为完整命令执行：\n${parts[0]}\n（其余内容请在 Mac 查看）`);
      return this.rich(`Codex：\n${parts[0]}`);
    }

    // Keep only the final version of each changed file and send it when the
    // turn completes. App-server's fileChange shape is {changes:[...]}; it has
    // no top-level path/operation fields.
    if (msg.method==='item/completed' && this.isCurrent(p) && p.item?.type==='fileChange') {
      this.queueFileOutputs(p.turnId,p.item);
      return;
    }
    if (msg.method==='item/completed' && this.isCurrent(p)
        && p.item?.type==='imageGeneration' && typeof p.item.savedPath==='string') {
      this.queueOutputPath(p.turnId,p.item.savedPath);
      return;
    }
    if (msg.method==='turn/completed') {
      const turn=p.turn; if (!turn?.id) return;
      if (this.finished.has(turn.id)) return;
      this.finished.add(turn.id); if (this.finished.size>500) this.finished.delete(this.finished.values().next().value);
      const task=this.finishTurn(p.threadId,turn); this.releasePromise=task;
      try { return await task; }
      finally { if (this.releasePromise===task) this.releasePromise=null; }
    }
    if (msg.method==='error') return this.say(`Codex 报告错误：${safeError(p.error,this.config.token)}`);
  }
  dispose() {
    this.clearTakeoverReservation();
    for (const r of this.approvals.values()) clearTimeout(r.timer);
    for (const r of this.questions.values()) clearTimeout(r.group.timer);
    // 清理所有流式消息的节流定时器
    for (const stream of this.streamingMessages.values()) {
      if (stream.throttleTimer) clearTimeout(stream.throttleTimer);
    }
    this.approvals.clear(); this.questions.clear(); this.buttons.clear(); this.items.clear(); this.streamingMessages.clear(); this.outputFiles.clear(); this.uploadNames.clear();
  }

  // 流式输出：处理增量文本
  async handleStreamingDelta(turnId, deltaText) {
    if (!deltaText) return;

    let stream = this.streamingMessages.get(turnId);

    // 首次接收流式数据，创建初始预览消息
    if (!stream) {
      const initialMsg = await this.say('💭 思考中...');
      stream = {
        messageId: initialMsg.message_id,
        buffer: '',
        lastUpdate: 0,
        throttleTimer: null
      };
      this.streamingMessages.set(turnId, stream);
    }

    // 累积增量到缓冲区
    stream.buffer += deltaText;

    // 节流：每秒最多更新一次，避免 Telegram 频率限制
    const now = this.now();
    const timeSinceLastUpdate = now - stream.lastUpdate;

    if (timeSinceLastUpdate >= 1000) {
      // 立即更新
      await this.updateStreamingMessage(stream);
    } else if (!stream.throttleTimer) {
      // 设置节流定时器
      const delay = 1000 - timeSinceLastUpdate;
      stream.throttleTimer = setTimeout(() => {
        stream.throttleTimer = null;
        void this.updateStreamingMessage(stream).catch(e => this.diagnostic('streaming-update-failed', e));
      }, delay);
      stream.throttleTimer.unref?.();
    }
  }

  // 更新流式预览消息
  async updateStreamingMessage(stream) {
    const MAX_PREVIEW_LENGTH = 3500; // 保留空间给省略标记
    let preview = stream.buffer;

    // 截断过长消息
    if (preview.length > MAX_PREVIEW_LENGTH) {
      // 在字符边界截断（避免截断 emoji 或多字节字符）
      preview = preview.slice(0, MAX_PREVIEW_LENGTH);
      // 找到最后一个完整的换行符
      const lastNewline = preview.lastIndexOf('\n');
      if (lastNewline > MAX_PREVIEW_LENGTH - 200) {
        preview = preview.slice(0, lastNewline);
      }
      preview += '\n\n[预览截断，完整内容将在生成结束后显示...]';
    }

    try {
      await this.tg.editMessageText(this.config.chatId, stream.messageId, `💬 Codex 正在生成...\n\n${preview}`);
      stream.lastUpdate = this.now();
    } catch (e) {
      // 编辑失败（可能因为内容未变化或频率限制），记录但不中断
      this.diagnostic('streaming-edit-failed', e);
    }
  }

  // 清理流式消息
  async cleanupStreamingMessage(turnId) {
    const stream = this.streamingMessages.get(turnId);
    if (!stream) return;

    // 清理节流定时器
    if (stream.throttleTimer) {
      clearTimeout(stream.throttleTimer);
      stream.throttleTimer = null;
    }

    // 删除预览消息（最终完整消息会由 item/completed 处理）
    try {
      await this.tg.deleteMessage(this.config.chatId, stream.messageId);
    } catch (e) {
      // 删除失败不影响主流程
      this.diagnostic('streaming-cleanup-failed', e);
    }

    this.streamingMessages.delete(turnId);
  }

  queueOutputPath(turnId,userPath) {
    if(typeof turnId!=='string' || typeof userPath!=='string' || !userPath) return;
    let files=this.outputFiles.get(turnId);
    if(!files) {files=new Map();this.outputFiles.set(turnId,files);}
    files.set(userPath,userPath);
  }

  queueLinkedFileOutputs(turnId,text) {
    if(typeof text!=='string') return;
    const targets=[];
    for(const match of text.matchAll(/\[[^\]\r\n]*\]\(<([^>\r\n]+)>\)/g)) targets.push(match[1]);
    for(const match of text.matchAll(/\[[^\]\r\n]*\]\((?!<)([^\s)]+)\)/g)) targets.push(match[1]);
    for(let target of targets) {
      if(/^[a-z][a-z0-9+.-]*:/i.test(target) && !path.isAbsolute(target)) continue;
      target=target.replace(/:\d+(?::\d+)?$/,'');
      this.queueOutputPath(turnId,target);
    }
  }

  queueFileOutputs(turnId,item) {
    if(item.status && item.status!=='completed') return;
    if(!Array.isArray(item.changes)) return;
    for(const change of item.changes) {
      if(!change || typeof change.path!=='string' || !change.path) continue;
      const kind=change.kind?.type;
      const files=this.outputFiles.get(turnId);
      if(kind==='delete') {files?.delete(change.path);continue;}
      if(kind!=='add' && kind!=='update') continue;
      if(kind==='update' && typeof change.kind.move_path==='string' && change.kind.move_path) {
        files?.delete(change.path);
        this.queueOutputPath(turnId,change.kind.move_path);
      } else this.queueOutputPath(turnId,change.path);
    }
  }

  async flushFileOutputs(threadId,turnId) {
    const files=this.outputFiles.get(turnId);
    this.outputFiles.delete(turnId);
    if(!files?.size) return;
    const thread=this.managed.get(threadId);
    if(!thread) return;
    let failed=0;
    for(const userPath of files.values()) {
      try {
        const proposal=describeExport(this.config,thread,userPath);
        const file=readExport(this.config,thread,proposal);
        const kind=imageKind(file.bytes);
        if(kind && file.bytes.length<=10_000_000) {
          await this.sendPhoto({bytes:file.bytes,caption:`📷 ${file.name}`,mime:kind.mime});
        } else {
          await this.sendDocument({bytes:file.bytes,name:file.name,mime:file.mime});
        }
      } catch(error) {
        failed++;
        this.diagnostic('file-output-failed',error);
      }
    }
    if(failed) await this.say(`${failed} 个变更文件未能回传（可能已删除、过大或属于隐藏/敏感路径），请在 Mac 查看。`);
  }
}
