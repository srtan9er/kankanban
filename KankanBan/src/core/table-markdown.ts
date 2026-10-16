import type {ImageLayout,ImagePlacement} from './image-markdown.ts';
import {tableCells,tableAlignment} from './markdown-syntax.ts';
import {uiText} from '../i18n/text.ts';
// Fixed user-configured minimum track dimensions; cell text wraps within them.
export const TABLE_CELL_FONT_SIZE=13;
export const TABLE_MIN_COLUMN_WIDTH=80;
export const TABLE_MIN_ROW_HEIGHT=40;
export const minimumTableTracks=(data:TableData):TableData=>({...data,columns:data.columns.map(v=>Math.max(TABLE_MIN_COLUMN_WIDTH,v)),rows:data.rows.map(v=>Math.max(TABLE_MIN_ROW_HEIGHT,v))});
export function resizeTableTracks(data:TableData,width?:number,height?:number):TableData{
 const resize=(tracks:number[],target:number|undefined,minimum:number)=>{
  const total=tracks.reduce((a,b)=>a+b,0);
  return target===undefined || target===total?tracks:tracks.map(value=>Math.max(minimum,value*target/total));
 };
 return {...data,columns:resize(data.columns,width,TABLE_MIN_COLUMN_WIDTH),rows:resize(data.rows,height,TABLE_MIN_ROW_HEIGHT)};
}
export type TableCell={row:number;col:number;rowSpan:number;colSpan:number;text:string};
export type TableData={columns:number[];rows:number[];alignment:('left'|'right'|'center')[];cells:TableCell[]};
export type BodyTable=ImagePlacement & {start:number;end:number;name:string;data:TableData;collapsed?:boolean;syntax:'table'|'markdown-table'};
/** New tables use the same persisted object format as imported Markdown tables. */
export function emptyTableMarkup(content:string):string{
 const used=new Set(parseTables(content).map(table=>table.name));let next=0;while(used.has(`table_${next}`))next++;
 return serializeTable({start:0,end:0,syntax:'table',name:`table_${next}`,layout:'inline',data:{columns:[TABLE_MIN_COLUMN_WIDTH,TABLE_MIN_COLUMN_WIDTH],rows:[TABLE_MIN_ROW_HEIGHT,TABLE_MIN_ROW_HEIGHT],alignment:['left','left'],cells:Array.from({length:4},(_,index)=>({row:Math.floor(index/2),col:index%2,rowSpan:1,colSpan:1,text:''}))}});
}
const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/<(\/?)(cell|table)(?=[\s>])/g,'&lt;$1$2');
const decode=(value:string)=>value.replace(/&lt;(\/?)(cell|table)(?=[\s>])/g,'<$1$2').replace(/&amp;/g,'&');
const invalid=()=>{throw new Error(uiText('tables.invalid'));};
const nameValid=(name:string)=>/^table_(0|[1-9]\d*)$/.test(name) && Number.isSafeInteger(Number(name.slice(6)));
export function validTable(data:TableData):boolean{
 if(!data || !Array.isArray(data.rows) || !Array.isArray(data.columns) || !data.rows.length || !data.columns.length || data.rows.length>32 || data.columns.length>32 || data.rows.some(v=>!Number.isFinite(v) || v<24 || v>4096) || data.columns.some(v=>!Number.isFinite(v) || v<32 || v>4096) || !Array.isArray(data.alignment) || data.alignment.length!==data.columns.length || data.alignment.some(v=>!['left','right','center'].includes(v)) || !Array.isArray(data.cells) || data.cells.length>1024)return false;
 const used=new Set<number>();let length=0;
 for(const cell of data.cells){if(!cell || ![cell.row,cell.col,cell.rowSpan,cell.colSpan].every(Number.isSafeInteger) || cell.row<0 || cell.col<0 || cell.rowSpan<1 || cell.colSpan<1 || cell.row+cell.rowSpan>data.rows.length || cell.col+cell.colSpan>data.columns.length || typeof cell.text!=='string' || cell.text.includes('\0') || cell.text.length>65536)return false;
  length+=cell.text.length;for(let r=cell.row;r<cell.row+cell.rowSpan;r++)for(let c=cell.col;c<cell.col+cell.colSpan;c++){const index=r*data.columns.length+c;if(used.has(index))return false;used.add(index);}
 }
 return length<=262144 && used.size===data.rows.length*data.columns.length;
}
function attributes(raw:string,allowed:string[]):Record<string,string>|null{
 const attrs:Record<string,string>={};let from=0;
 const pattern=/\s+([a-z]+)="([^"<>]*)"/gy;
 while(from<raw.length){pattern.lastIndex=from;const match=pattern.exec(raw);if(!match)return raw.slice(from).trim()?null:attrs;const key=match[1]!;if(!allowed.includes(key) || Object.hasOwn(attrs,key))return null;attrs[key]=match[2]!;from=pattern.lastIndex;}
 return attrs;
}
function controlled(text:string,start:number):BodyTable|null{
 const open=/^<table\b([^>]*)>/.exec(text.slice(start));if(!open)return null;const end=text.indexOf('</table>',start+open[0].length);if(end<0 || end-start>1048576)return null;
 const attrs=attributes(open[1]!,['name','layout','columns','rows','align','x','y','layer','collapsed']);if(!attrs || !nameValid(attrs.name ?? '') || attrs.collapsed!==undefined && !['true','false'].includes(attrs.collapsed))return null;
 const columns=(attrs.columns ?? '').split(',').map(Number),rows=(attrs.rows ?? '').split(',').map(Number),alignment=(attrs.align ?? columns.map(()=>'left').join(',')).split(',') as TableData['alignment'];
 const cells:TableCell[]=[],inner=text.slice(start+open[0].length,end);let pos=0;
 const pattern=/\s*<cell\b([^>]*)>([\s\S]*?)<\/cell>/gy;
 while(pos<inner.length){pattern.lastIndex=pos;const match=pattern.exec(inner);if(!match){if(inner.slice(pos).trim())return null;break;}const a=attributes(match[1]!,['row','col','rowspan','colspan']);if(!a)return null;
  cells.push({row:Number(a.row),col:Number(a.col),rowSpan:Number(a.rowspan ?? 1),colSpan:Number(a.colspan ?? 1),text:decode(match[2]!)});pos=pattern.lastIndex;
 }
 const data={columns,rows,alignment,cells},layout=(attrs.layout ?? 'inline') as ImageLayout;if(!validTable(data) || !['inline','float'].includes(layout))return null;
 const placement:ImagePlacement={layout};for(const key of ['x','y','layer'] as const)if(attrs[key]!==undefined){const value=Number(attrs[key]);if(!Number.isFinite(value) || Math.abs(value)>(key==='layer'?1000000:10000000) || key==='layer' && !Number.isSafeInteger(value))return null;placement[key]=value;}
 return {start,end:end+8,name:attrs.name!,data:minimumTableTracks(data),syntax:'table',...placement,...(attrs.collapsed==='true'?{collapsed:true}:{})};
}
/** Read without modifying storage. Code and escaped markers are excluded. */
export function parseTables(text:string):BodyTable[]{
 const found:BodyTable[]=[];let fence:{char:string;length:number}|null=null;
 for(let i=0;i<text.length;){
  if(i===0 || text[i-1]==='\n'){
   const next=text.indexOf('\n',i),line=text.slice(i,next<0?text.length:next),match=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
   if(fence){if(match && match[1]![0]===fence.char && match[1]!.length>=fence.length && !match[2]!.trim())fence=null;i=next<0?text.length:next+1;continue;}
   if(match){fence={char:match[1]![0]!,length:match[1]!.length};i=next<0?text.length:next+1;continue;}
   if(/^(?: {4}|\t)/.test(line)){i=next<0?text.length:next+1;continue;}
   const header=tableCells(line),dividerEnd=next<0?-1:text.indexOf('\n',next+1),alignment=next<0?null:tableAlignment(text.slice(next+1,dividerEnd<0?text.length:dividerEnd));
   if(header && alignment?.length===header.length && header.length<=32){
    const tableRows=[header];let end=dividerEnd<0?text.length:dividerEnd,cursor=end<text.length?end+1:end;
    while(cursor<text.length && tableRows.length<32){const e=text.indexOf('\n',cursor),raw=text.slice(cursor,e<0?text.length:e),row=tableCells(raw);if(!row || /^ {0,3}(`{3,}|~{3,})/.test(raw))break;tableRows.push(row);end=e<0?text.length:e;cursor=end<text.length?end+1:end;}
    const data:TableData={columns:header.map(()=>TABLE_MIN_COLUMN_WIDTH),rows:tableRows.map(()=>TABLE_MIN_ROW_HEIGHT),alignment,cells:tableRows.flatMap((row,r)=>header.map((_,c)=>({row:r,col:c,rowSpan:1,colSpan:1,text:row[c]?.text ?? ''})))};
    found.push({start:i,end,name:'',data,syntax:'markdown-table',layout:'inline'});i=end;continue;
   }
  }
  if(text[i]==='\\'){i+=2;continue;}
  if(text[i]==='`'){const run=/^`+/.exec(text.slice(i))![0];let close=text.indexOf(run,i+run.length);while(close>=0 && (text[close-1]==='`' || text[close+run.length]==='`'))close=text.indexOf(run,close+run.length);i=close>=0?close+run.length:i+run.length;continue;}
  if(text.startsWith('<table',i)){const table=controlled(text,i);if(table){found.push(table);i=table.end;continue;}}
  i++;
 }
 const used=new Set(found.flatMap(t=>t.name?[t.name]:[]));let next=0;
 for(const table of found){if(!table.name){while(used.has(`table_${next}`))next++;table.name=`table_${next++}`;used.add(table.name);}}
 return found;
}
export function serializeTable(table:BodyTable,changes:Partial<ImagePlacement>&{data?:TableData;name?:string;collapsed?:boolean}={}):string{
 let data=changes.data ?? table.data;const name=changes.name ?? table.name,layout=changes.layout ?? table.layout;
 if(changes.width!==undefined || changes.height!==undefined)data=resizeTableTracks(data,changes.width,changes.height);
 if(!nameValid(name) || !validTable(data) || !['inline','float'].includes(layout))invalid();
 data=minimumTableTracks(data);
 const attrs=[`name="${name}"`,`layout="${layout}"`,`columns="${data.columns.join(',')}"`,`rows="${data.rows.join(',')}"`,`align="${data.alignment.join(',')}"`];
 const collapsed=changes.collapsed ?? table.collapsed;if(collapsed!==undefined && typeof collapsed!=='boolean')invalid();if(collapsed)attrs.push('collapsed="true"');
 for(const key of ['x','y','layer'] as const){const value=changes[key] ?? table[key];if(value!==undefined){if(!Number.isFinite(value) || Math.abs(value)>(key==='layer'?1000000:10000000) || key==='layer' && !Number.isSafeInteger(value))invalid();attrs.push(`${key}="${value}"`);}}
 return `<table ${attrs.join(' ')}>\n${data.cells.map(cell=>`<cell row="${cell.row}" col="${cell.col}" rowspan="${cell.rowSpan}" colspan="${cell.colSpan}">${escape(cell.text)}</cell>`).join('\n')}\n</table>`;
}
export function ensureTables(text:string):string{
 const tables=parseTables(text),used=new Set<string>();let from=0,result='',next=0;
 for(const table of tables){let name=table.name;if(used.has(name)){while(used.has(`table_${next}`) || tables.some(t=>t.name===`table_${next}`))next++;name=`table_${next++}`;}used.add(name);result+=text.slice(from,table.start)+serializeTable(table,{name});from=table.end;}
 return result+text.slice(from);
}
/** A merge may only consume complete cells that tile the selected rectangle. */
export function mergeTable(data:TableData,a:{row:number;col:number},b:{row:number;col:number}):TableData{
 const top=Math.min(a.row,b.row),left=Math.min(a.col,b.col),bottom=Math.max(a.row,b.row)+1,right=Math.max(a.col,b.col)+1;
 const selected=data.cells.filter(cell=>cell.row<bottom && cell.row+cell.rowSpan>top && cell.col<right && cell.col+cell.colSpan>left);
 if(selected.length<2 || selected.some(cell=>cell.row<top || cell.col<left || cell.row+cell.rowSpan>bottom || cell.col+cell.colSpan>right))throw new Error(uiText('tables.rectangle'));
 const merged={row:top,col:left,rowSpan:bottom-top,colSpan:right-left,text:selected.sort((x,y)=>x.row-y.row || x.col-y.col).map(cell=>cell.text).filter(Boolean).join('\n')},result={...data,cells:[...data.cells.filter(cell=>!selected.includes(cell)),merged].sort((x,y)=>x.row-y.row || x.col-y.col)};
 if(!validTable(result))invalid();return result;
}
export function splitTable(data:TableData,cell:TableCell):TableData{
 if(cell.rowSpan===1 && cell.colSpan===1)return data;const cells=data.cells.filter(c=>c!==cell);
 for(let r=cell.row;r<cell.row+cell.rowSpan;r++)for(let c=cell.col;c<cell.col+cell.colSpan;c++)cells.push({row:r,col:c,rowSpan:1,colSpan:1,text:r===cell.row && c===cell.col?cell.text:''});
 return {...data,cells:cells.sort((a,b)=>a.row-b.row || a.col-b.col)};
}

/** Cells clear in place; full empty tracks may be removed while preserving crossing merges. */
export function deleteTableSelection(data:TableData,a:{row:number;col:number},b:{row:number;col:number},axis?:'rows'|'columns'):TableData{
 if(!validTable(data) || [a,b].some(point=>![point.row,point.col].every(Number.isSafeInteger) || point.row<0 || point.col<0 || point.row>=data.rows.length || point.col>=data.columns.length))invalid();
 const top=axis==='columns'?0:Math.min(a.row,b.row),bottom=axis==='columns'?data.rows.length:Math.max(a.row,b.row)+1;
 const left=axis==='rows'?0:Math.min(a.col,b.col),right=axis==='rows'?data.columns.length:Math.max(a.col,b.col)+1;
 const affected=data.cells.filter(cell=>cell.row<bottom && cell.row+cell.rowSpan>top && cell.col<right && cell.col+cell.colSpan>left);
 if(!axis || affected.some(cell=>cell.text.trim().length>0)){
  if(affected.every(cell=>cell.text===''))return data;
  return {...data,cells:data.cells.map(cell=>affected.includes(cell)?{...cell,text:''}:cell)};
 }
 const position=axis==='rows'?'row':'col',span=axis==='rows'?'rowSpan':'colSpan',start=axis==='rows'?top:left;
 const count=Math.min((axis==='rows'?bottom:right)-start,data[axis].length-1);if(!count)return data;const end=start+count;
 const cells=data.cells.flatMap(cell=>{
  const overlap=Math.max(0,Math.min(end,cell[position]+cell[span])-Math.max(start,cell[position]));
  if(overlap===cell[span])return [];
  return [{...cell,[position]:cell[position]-Math.min(count,Math.max(0,cell[position]-start)),[span]:cell[span]-overlap}];
 });
 const tracks=[...data[axis]];tracks.splice(start,count);const alignment=[...data.alignment];if(axis==='columns')alignment.splice(start,count);
 const result={...data,[axis]:tracks,alignment,cells:cells.sort((a,b)=>a.row-b.row || a.col-b.col)};if(!validTable(result))invalid();return result;
}

/** Insert after the selected cell's full span; crossing merges grow without losing text. */
export function insertTableTrack(data:TableData,axis:'rows'|'columns',selected:{row:number;col:number}):TableData{
 if(!validTable(data))invalid();
 if(data[axis].length>=32)throw new Error(uiText('tables.limit'));
 const anchor=data.cells.find(cell=>cell.row===selected.row && cell.col===selected.col);
 if(!anchor)throw new Error(uiText('tables.cellChanged'));
 const position=axis==='rows'?'row':'col',span=axis==='rows'?'rowSpan':'colSpan',at=anchor[position]+anchor[span];
 const cells=data.cells.map(cell=>cell[position]>=at?{...cell,[position]:cell[position]+1}:cell[position]+cell[span]>at?{...cell,[span]:cell[span]+1}:{...cell});
 const across=axis==='rows'?data.columns.length:data.rows.length;
 for(let i=0;i<across;i++){
  const row=axis==='rows'?at:i,col=axis==='columns'?at:i;
  if(!cells.some(cell=>cell.row<=row && row<cell.row+cell.rowSpan && cell.col<=col && col<cell.col+cell.colSpan))cells.push({row,col,rowSpan:1,colSpan:1,text:''});
 }
 const tracks=[...data[axis]];tracks.splice(at,0,axis==='rows'?TABLE_MIN_ROW_HEIGHT:TABLE_MIN_COLUMN_WIDTH);
 const alignment=[...data.alignment];if(axis==='columns')alignment.splice(at,0,data.alignment[anchor.col]!);
 const result={...data,[axis]:tracks,alignment,cells:cells.sort((a,b)=>a.row-b.row || a.col-b.col)};
 if(!validTable(result))invalid();return result;
}

/** Copy gets a new per-card table name; a cut/move retains an unused name. */
export function nameInsertedTables(inserted:string,surrounding:string):string{
 const tables=parseTables(inserted),used=new Set(parseTables(surrounding).map(table=>table.name));let next=Math.max(-1,...[...used,...tables.map(table=>table.name)].map(name=>Number(name.slice(6))))+1,from=0,value='';
 for(const table of tables){let name=table.name;if(used.has(name)){while(used.has(`table_${next}`))next++;name=`table_${next++}`;}used.add(name);value+=inserted.slice(from,table.start)+serializeTable(table,{name});from=table.end;}
 return value+inserted.slice(from);
}
