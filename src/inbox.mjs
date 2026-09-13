// Persist-before-dispatch trades occasional lost messages for avoiding automatic
// re-execution after process crashes. It is not a distributed exactly-once claim.
export class Inbox {
  constructor({offset=0,since,save}) {
    if (!Number.isSafeInteger(offset) || offset<0) throw new Error('消息偏移状态无效，拒绝自动重放。');
    this.offset=offset; this.since=since; this.save=save;
  }
  async dispatch(update,handle) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id<0 || update.update_id>=Number.MAX_SAFE_INTEGER || update.update_id<this.offset) return false;
    const next=update.update_id+1;
    this.save({offset:next}); this.offset=next;
    if (update.message && (!Number.isInteger(update.message.date) || update.message.date<this.since)) return false;
    await handle(update); return true;
  }
}
