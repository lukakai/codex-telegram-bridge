import { allowedThread, within } from './util.mjs';

export const THREAD_SOURCES=['cli','vscode','exec','appServer','unknown'];

// Codex's cwd filter is exact, not recursive. Page the metadata index and filter
// locally BEFORE making titles/previews available to Telegram. No file scanning.
export class ThreadCatalog {
  constructor(config,rpc) {this.config=config; this.rpc=rpc;}
  async page(project,query='',archived=false,previous=null) {
    if (previous && (previous.projectId!==project.id || previous.query!==query || previous.archived!==archived)) throw new Error('历史翻页条件已变化，请重新发送 /threads。');
    const state=previous ? {...previous,buffer:[...previous.buffer],seen:new Set(previous.seen)} : {
      projectId:project.id,query,archived,cursor:null,buffer:[],seen:new Set(),done:false,shown:0
    };
    const authorized=thread=>{
      try {return within(project.cwd,allowedThread(this.config,thread));} catch {return false;}
    };
    state.buffer=state.buffer.filter(authorized);
    let pages=0;
    // Bound work per click; if all pages are excluded, offer a continuation
    // rather than incorrectly reporting that no history exists.
    while (state.buffer.length<8 && !state.done && pages<10) {
      const result=await this.rpc.call('thread/list',{
        limit:100,cursor:state.cursor,sortKey:'updated_at',sortDirection:'desc',
        sourceKinds:THREAD_SOURCES,modelProviders:[],archived,useStateDbOnly:true,
        ...(query?{searchTerm:query}:{})
      });
      if (!Array.isArray(result?.data)) throw new Error('历史列表协议格式无效。');
      const next=result.nextCursor ?? null;
      if (next!==null && (typeof next!=='string' || next===state.cursor)) throw new Error('历史分页游标未前进，请重新查询。');
      for (const thread of result.data) {
        if (!authorized(thread) || state.seen.has(thread.id)) continue;
        if (state.seen.size>=10000) throw new Error('单次列表超过一万条，请用 /threads 关键词 缩小范围。');
        state.seen.add(thread.id);
        // Do not retain full thread data or unrelated metadata in navigation state.
        state.buffer.push({id:thread.id,cwd:thread.cwd,name:thread.name,preview:thread.preview,updatedAt:thread.updatedAt});
      }
      state.cursor=next; state.done=next===null; pages++;
    }
    const threads=state.buffer.splice(0,8), start=state.shown;
    state.shown+=threads.length;
    return {threads,start,next:state.buffer.length || !state.done ? state : null};
  }
}
