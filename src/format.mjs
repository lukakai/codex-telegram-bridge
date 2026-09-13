import { chunks } from './util.mjs';

// A conservative Markdown subset converted to Telegram entities, NOT HTML or
// MarkdownV2. Code content (including literal HTML entities) is never decoded,
// escaped, trimmed, or rewritten. This renderer is not used for approvals.
export function markdownBlocks(value) {
  const source=String(value); const lines=source.match(/[^\n]*\n|[^\n]+$/g)||[];
  const blocks=[];let prose='',code='',opening=null,rawOpening='';
  const flush=()=>{if(prose){blocks.push({type:'text',text:prose});prose='';}};
  for(const line of lines) {
    const bare=line.replace(/\r?\n$/,'');
    if (opening) {
      const closing=bare.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if(closing && closing[1][0]===opening.marker[0] && closing[1].length>=opening.marker.length) {
        blocks.push({type:'code',text:code,language:opening.language});opening=null;code='';
      } else code+=line;
    } else {
      const match=bare.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([a-zA-Z0-9_+.#-]*)[ \t]*$/);
      if(match){flush();rawOpening=line;opening={marker:match[1],language:match[2]};}
      else prose+=line;
    }
  }
  // Unclosed fences may indicate a truncated command. Keep the fence visible
  // and do not create a misleading one-click executable snippet.
  if(opening) {flush();blocks.push({type:'literal',text:rawOpening+code});}
  flush();return blocks;
}

export function inlineEntities(source) {
  let text='',entities=[],end=0;
  const expression=/(`+)([^\n]*?)\1|\*\*([^*\n]+)\*\*/g;
  for(const match of source.matchAll(expression)) {
    if(match.index>0 && source[match.index-1]==='\\') continue;
    const content=match[2]??match[3]; if(!content) continue;
    text+=source.slice(end,match.index);
    entities.push({type:match[2]!==undefined?'code':'bold',offset:text.length,length:content.length});
    text+=content;end=match.index+match[0].length;
  }
  text+=source.slice(end);return {text,entities};
}

function splitEntities(text,entities,max=3500) {
  let offset=0;return chunks(text,max).map(part=>{
    const from=offset;offset+=part.length;
    return {text:part,entities:entities.filter(e=>e.offset<offset && e.offset+e.length>from).map(e=>({...e,offset:Math.max(from,e.offset)-from,length:Math.min(offset,e.offset+e.length)-Math.max(from,e.offset)}))};
  });
}

export function markdownMessages(source) {
  const blocks=markdownBlocks(source),messages=[];
  for(const block of blocks) {
    if(!block.text.trim()) continue;
    if(block.type==='literal') {
      messages.push(...chunks(block.text).map(text=>({text,entities:[]})));
    } else if(block.type==='text') {
      const inline=inlineEntities(block.text);messages.push(...splitEntities(inline.text,inline.entities));
    } else {
      const parts=chunks(block.text,3500);
      for(let i=0;i<parts.length;i++) {
        const text=parts[i];if(!text.trim()) continue;
        const label=`代码块${block.language?' · '+block.language:''}${parts.length>1?' · 第 '+(i+1)+'/'+parts.length+' 段':''}`;
        const warning=/&#(?:x[0-9a-f]+|[0-9]+);/i.test(text)?'\n注意：原文含字符实体，未自动改写；执行前请核对。':'';
        messages.push({text:label+'\n'+(parts.length===1 && text.length<=256?'下一条是完整代码块，可点“复制代码”。':parts.length>1?'代码过长，已分段；请合并全部段落，勿单独执行片段。':'下一条是完整代码块；使用代码块复制或长按复制。')+warning,entities:[]});
        messages.push({text,entities:[{type:'pre',offset:0,length:text.length,...(block.language?{language:block.language}:{})}],
          ...(parts.length===1 && text.length<=256?{reply_markup:{inline_keyboard:[[{text:'复制代码',copy_text:{text}}]]}}:{})});
      }
    }
  }
  if(!messages.length) return [{text:'（无文字内容）',entities:[]}];
  // Avoid flooding the chat with hundreds of tiny blocks. Preserve all text.
  if(messages.length>40) return chunks(source).map(text=>({text,entities:[]}));
  return messages;
}
