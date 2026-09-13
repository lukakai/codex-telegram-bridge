// Model names and reasoning levels come from this installed Codex/account's
// model/list response, never from a hardcoded list or marketing model names.
export class ModelSettings {
  constructor(rpc,{now=Date.now,preferences={},savePreferences=()=>{}}={}) {
    this.rpc=rpc;this.now=now;this.savePreferences=savePreferences;
    for (const key of ['model','effort']) if (preferences[key]!=null && (typeof preferences[key]!=='string' || !preferences[key] || preferences[key].length>200)) throw new Error('模型偏好文件无效，请检查 preferences.json。');
    if (preferences.effort && !preferences.model) throw new Error('推理强度必须绑定模型，请检查 preferences.json。');
    this.choice={model:preferences.model||null,effort:preferences.effort||null};
    this.cache=null;this.cachedAt=0;
  }
  async catalog(force=false) {
    if (!force && this.cache && this.now()-this.cachedAt<60000) return this.cache;
    const models=[],ids=new Set(),cursors=new Set();let cursor=null;
    for (let page=0;page<50;page++) {
      const response=await this.rpc.call('model/list',{cursor,limit:100,includeHidden:false});
      if (!Array.isArray(response?.data)) throw new Error('Codex 模型列表结构不兼容，未更改设置。');
      for (const model of response.data) {
        if (!model || model.hidden || typeof model.model!=='string' || !model.model || !Array.isArray(model.supportedReasoningEfforts)) continue;
        if (ids.has(model.model)) continue;
        ids.add(model.model);models.push(model);
      }
      cursor=response.nextCursor??null;
      if (cursor===null) {
        if (!models.length) throw new Error('Codex 没有返回可选模型，请在 Mac 检查登录与模型配置。');
        this.cache=models;this.cachedAt=this.now();return models;
      }
      if (typeof cursor!=='string' || cursors.has(cursor)) throw new Error('模型列表分页异常，未更改设置。');
      cursors.add(cursor);
    }
    throw new Error('模型列表页数过多，未使用不完整的列表。');
  }
  levels(model) {
    return model.supportedReasoningEfforts.filter(o=>o && typeof o.reasoningEffort==='string' && o.reasoningEffort.length>0);
  }
  async commit(next) {await this.savePreferences(next);this.choice={...next};}
  async setModel(value) {
    if (value==='default') {await this.commit({model:null,effort:null});return null;}
    const models=await this.catalog(true);
    const model=models.find(m=>m.model===value || m.id===value);
    if (!model) throw new Error('这个模型不在 Codex 返回的可选列表中，请发送 /model 重新选择。');
    const level=this.levels(model).find(o=>o.reasoningEffort===model.defaultReasoningEffort)?.reasoningEffort||null;
    // Model changes reset effort to the new model's own default, never carry an
    // unsupported effort level across models.
    await this.commit({model:model.model,effort:level});return model;
  }
  async effectiveModel(thread,force=false) {
    const models=await this.catalog(force);
    const name=this.choice.model || thread?.model;
    const model=name ? models.find(m=>m.model===name || m.id===name) : models.find(m=>m.isDefault);
    if (!model) throw new Error('无法从可选列表确认当前模型，请先 /model 选择模型，再设置推理强度。');
    return model;
  }
  async setEffort(value,thread,expectedModel=null) {
    const model=await this.effectiveModel(thread,true);
    if (expectedModel && model.model!==expectedModel) throw new Error('模型已变化，旧强度按钮失效，请重新发送 /effort。');
    const effort=value==='default'?model.defaultReasoningEffort:value;
    if (!this.levels(model).some(o=>o.reasoningEffort===effort)) throw new Error('该模型不支持这个推理强度，请发送 /effort 查看实际可选项。');
    await this.commit({model:model.model,effort});return model;
  }
  async overrides() {
    if (!this.choice.model) return {};
    const model=(await this.catalog()).find(m=>m.model===this.choice.model);
    if (!model) throw new Error('保存的模型当前不可用，请 /model 重新选择。任务尚未提交。');
    if (this.choice.effort && !this.levels(model).some(o=>o.reasoningEffort===this.choice.effort)) throw new Error('保存的推理强度已不受支持，请 /effort 重新选择。任务尚未提交。');
    return {model:this.choice.model,...(this.choice.effort?{effort:this.choice.effort}:{})};
  }
  summary(thread) {
    const chosen=this.choice.model;
    return `模型：${chosen || thread?.model || '沿用 Codex 配置'}${chosen?'（下次任务指定）':'（未覆盖）'}\n推理强度：${this.choice.effort || (chosen?'该模型默认':thread?.reasoningEffort||'沿用会话/配置')}`;
  }
}
