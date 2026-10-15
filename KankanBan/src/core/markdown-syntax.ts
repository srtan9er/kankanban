export type InlineText={kind:'text'|'code'|'link';text:string;start:number;end:number;href?:string;strong?:boolean;italic?:boolean;deleted?:boolean;script?:'sup'|'sub'};
type Marks=Pick<InlineText,'strong'|'italic'|'deleted'|'script'>;
const marker=(text:string,index:number)=>['***','**','~~','*','^','_'].find(value=>text.startsWith(value,index));
function closing(text:string,from:number,delimiter:string,depth:number):number{
 if(depth>24)return -1;
 for(let i=from;i<text.length;i++){
  if(text[i]==='\\'){i++;continue;}
  if(text[i]==='`'){const run=/^`+/.exec(text.slice(i))![0];const end=text.indexOf(run,i+run.length);if(end>=0){i=end+run.length-1;continue;}}
  if(text.startsWith(delimiter,i) && i>from && !/\s/.test(text[i-1]!) && (delimiter!=='*' || !text.startsWith('**',i) || text.startsWith('***',i)))return i;
  const nested=marker(text,i);
  if(nested && nested!==delimiter && !/\s/.test(text[i+nested.length] ?? ' ')){const end=closing(text,i+nested.length,nested,depth+1);if(end>=0){i=end+nested.length-1;continue;}}
 }
 return -1;
}
/** Controlled Markdown only. Raw HTML is left as escaped React text. */
export function inlineText(text:string,start=0,marks:Marks={},depth=0):InlineText[]{
 const result:InlineText[]=[];
 const push=(value:string,from:number,to:number,kind:InlineText['kind']='text',href?:string)=>result.push({kind,text:value,start:start+from,end:start+to,...marks,...(href?{href}:{})});
 let plain=0,i=0;
 const flush=()=>{if(i>plain)push(text.slice(plain,i),plain,i);};
 while(i<text.length){
  if(text[i]==='\\' && /[\\`*~^_|\[\]]/.test(text[i+1] ?? '')){flush();push(text[i+1]!,i+1,i+2);i+=2;plain=i;continue;}
  if(text[i]==='`'){
   const run=/^`+/.exec(text.slice(i))![0];let close=text.indexOf(run,i+run.length);
   while(close>=0 && (text[close-1]==='`' || text[close+run.length]==='`'))close=text.indexOf(run,close+run.length);
   if(close>=0){flush();push(text.slice(i+run.length,close),i+run.length,close,'code');i=close+run.length;plain=i;continue;}
  }
  const link=text[i]==='['?/^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.exec(text.slice(i)):null;
  if(link){flush();push(link[1]!,i+1,i+1+link[1]!.length,'link',link[2]!);i+=link[0].length;plain=i;continue;}
  const delimiter=marker(text,i);
  if(delimiter && depth<24 && !/\s/.test(text[i+delimiter.length] ?? ' ')){
   const close=closing(text,i+delimiter.length,delimiter,depth);
   if(close>=0){flush();const inner={...marks};if(delimiter==='***'){inner.strong=true;inner.italic=true;}else if(delimiter==='**')inner.strong=true;else if(delimiter==='*')inner.italic=true;else if(delimiter==='~~')inner.deleted=true;else inner.script=delimiter==='^'?'sup':'sub';
    result.push(...inlineText(text.slice(i+delimiter.length,close),start+i+delimiter.length,inner,depth+1));i=close+delimiter.length;plain=i;continue;}
  }
  i++;
 }
 flush();return result;
}
export const horizontalRule=(text:string)=>/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(text);
export type TableCell={text:string;start:number;end:number};
/** Pipe separators outside escaped text, code and controlled image tags. */
export function tableCells(line:string,start=0):TableCell[]|null{
 const cuts:number[]=[];let code=0;
 for(let i=0;i<line.length;i++){
  if(line[i]==='\\'){i++;continue;}
  if(line[i]==='`'){const run=/^`+/.exec(line.slice(i))![0].length;if(!code)code=run;else if(code===run)code=0;i+=run-1;continue;}
  if(!code && line.startsWith('<image ',i)){const end=line.indexOf('</image>',i);if(end>=0){i=end+7;continue;}}
  if(!code && line[i]==='|')cuts.push(i);
 }
 if(!cuts.length)return null;
 const ranges=[-1,...cuts,line.length],cells:TableCell[]=[];
 for(let i=0;i<ranges.length-1;i++){const from=ranges[i]!+1,to=ranges[i+1]!,value=line.slice(from,to),leading=value.length-value.trimStart().length,trimmed=value.trim();
  if((i===0 || i===ranges.length-2) && !trimmed)continue;
  cells.push({text:trimmed,start:start+from+leading,end:start+from+leading+trimmed.length});
 }
 return cells;
}
export function tableAlignment(line:string):('left'|'right'|'center')[]|null{
 const cells=tableCells(line);if(!cells?.length || cells.some(c=>!/^:?-{3,}:?$/.test(c.text)))return null;
 return cells.map(c=>c.text.endsWith(':')?(c.text.startsWith(':')?'center':'right'):'left');
}
