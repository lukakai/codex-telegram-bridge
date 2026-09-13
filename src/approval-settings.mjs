// Policy values are matched to the app-server schema commit recorded in util.mjs.
// Auto review keeps workspace-write + on-request, but routes escalation review
// to Codex's risk-based reviewer instead of blindly accepting requests.
const MODES=Object.freeze({strict:'untrusted',auto:'on-request'});
export function approvalPolicy(mode) {
  if(typeof mode!=='string' || !Object.hasOwn(MODES,mode)) throw new Error('审批模式无效，只支持 strict 或 auto。不会自动降级权限策略。');
  return MODES[mode];
}
export function approvalModeFromState(saved,identity) {
  if(saved==null) return 'strict';
  if(typeof saved!=='object' || Array.isArray(saved)) throw new Error('审批模式状态文件无效，请在 Mac 检查 approval.json。');
  // Auto is not inherited by a newly paired user, chat, or bot.
  if(saved.userId!==identity.userId || saved.chatId!==identity.chatId || saved.botId!==identity.botId) return 'strict';
  if(saved.version!==1) throw new Error('审批模式状态版本不兼容，未启用自动模式。');
  approvalPolicy(saved.mode);return saved.mode;
}
export function approvalState(mode,identity) {
  approvalPolicy(mode);
  if(![identity.userId,identity.chatId,identity.botId].every(x=>Number.isSafeInteger(x)&&x>0) || identity.userId!==identity.chatId) throw new Error('审批模式必须绑定有效的 Bot 和已配对私聊用户。');
  return {version:1,userId:identity.userId,chatId:identity.chatId,botId:identity.botId,mode};
}
export class ApprovalSettings {
  constructor({mode='strict',save=()=>{}}={}) {
    approvalPolicy(mode);this.mode=mode;this.revision=0;this.save=save;
  }
  policy() {return approvalPolicy(this.mode);}
  reviewer(mode=this.mode) {approvalPolicy(mode);return mode==='auto'?'auto_review':'user';}
  label(mode=this.mode) {
    approvalPolicy(mode);return mode==='auto'?'自动审查（auto_review / on-request）':'严格审批（user / untrusted）';
  }
  summary(active) {
    return `后续任务审批模式：${this.label()}${active?.approvalMode?'\n当前任务审批模式：'+this.label(active.approvalMode):''}`;
  }
  set(mode,revision) {
    approvalPolicy(mode);
    if(revision!==this.revision) throw new Error('审批模式已变化，旧确认失效；请重新 /approval。');
    // Synchronous atomic persistence supplied by main.mjs, just like directory
    // grants. Publish only after successful persistence, with no await gap.
    this.save(mode);this.mode=mode;this.revision++;
  }
}
