import {imageMarkdownTokens,type MarkdownImage} from '../core/image-markdown.ts';
import {parseTables} from '../core/table-markdown.ts';
import {serializeBodyObject,type BodyObject} from '../core/body-objects.ts';
import {horizontalRule,tableAlignment} from './markdown-syntax.ts';
export type FlowCaret={offset:number;x:number;y:number;height:number};
type Protected={start:number;end:number;open?:boolean};
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'}),cache=new Map<string,{ranges:Protected[];graphemes:Intl.Segments}>();
function documentBoundaries(text:string){
 const previous=cache.get(text);if(previous)return previous;
 const ranges:Protected[]=[...imageMarkdownTokens(text),...parseTables(text)].map(({start,end})=>({start,end}));
 let fence:{start:number;char:string;length:number}|null=null,offset=0;
 for(const line of text.split('\n')){
  const match=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if(match){if(!fence)fence={start:offset,char:match[1]![0]!,length:match[1]!.length};else if(match[1]![0]===fence.char && match[1]!.length>=fence.length && !match[2]!.trim()){ranges.push({start:fence.start,end:Math.min(text.length,offset+line.length+1)});fence=null;}}
  else if(!fence && /^(?: {4}|\t)/.test(line))ranges.push({start:offset,end:Math.min(text.length,offset+line.length+1)});
  if(!fence && (horizontalRule(line) || tableAlignment(line)))ranges.push({start:offset,end:offset+line.length});
  const prefix=/^(?: {0,3}#{1,6} | {0,3}> |[-*] (?:\[[ xX]\] )?)/.exec(line);if(prefix)ranges.push({start:offset,end:offset+prefix[0].length});
  offset+=line.length+1;
 }
 if(fence)ranges.push({start:fence.start,end:text.length,open:true});
 for(const match of text.matchAll(/\[[^\]\n]*\]\((?:\\.|[^)\n])*\)|\*{1,3}|_{1,3}|~~|\^|\\[\\`*~^_|\[\]]/g))ranges.push({start:match.index,end:match.index+match[0].length});
 for(let i=0;i<text.length;i++)if(text[i]==='`'){
  let end=i+1;while(text[end]==='`')end++;const delimiter=text.slice(i,end);let close=text.indexOf(delimiter,end);
  while(close>=0 && (text[close-1]==='`' || text[close+delimiter.length]==='`'))close=text.indexOf(delimiter,close+delimiter.length);
  if(close>=0){ranges.push({start:i,end:close+delimiter.length});i=close+delimiter.length-1;}else i=end-1;
 }
 const value={ranges,graphemes:segmenter.segment(text)};cache.set(text,value);if(cache.size>2)cache.delete(cache.keys().next().value!);return value;
}
/** Only visible text boundaries can receive an image, never a Markdown delimiter or atomic token. */
export function safeFlowOffset(text:string,offset:number):number{
 const {ranges,graphemes}=documentBoundaries(text);let value=Math.max(0,Math.min(text.length,Number.isFinite(offset)?Math.floor(offset):0));
 for(let attempt=0;attempt<ranges.length+1;attempt++){
  const containing=ranges.filter(range=>value>range.start && (value<range.end || range.open && value===range.end)).sort((a,b)=>(b.end-b.start)-(a.end-a.start))[0];
  if(!containing)break;value=containing.open || value-containing.start<=containing.end-value?containing.start:containing.end;
 }
 const part=graphemes.containing(value);if(!part)return text.length;
 const before=part.index,after=part.index+part.segment.length;return value-before<=after-value?before:after;
}
/** Source reordering is a single edit; a pointer preview never calls this function. */
export function moveFlowImage(text:string,reference:MarkdownImage,target:number):{value:string;start:number}{
 if(reference.start<0 || reference.end>text.length || reference.end<=reference.start)return {value:text,start:reference.start};
 const offset=safeFlowOffset(text,target);if(offset>=reference.start && offset<=reference.end)return {value:text,start:reference.start};
 const token=reference.syntax==='image'?serializeBodyObject(reference as BodyObject,{layout:'inline'}):text.slice(reference.start,reference.end);
 const shortened=text.slice(0,reference.start)+text.slice(reference.end),start=offset>reference.end?offset-(reference.end-reference.start):offset;
 const left=shortened.slice(0,start),right=shortened.slice(start);
 // A block delimiter must stay on its own line when a caret snaps around its hidden markers.
 const before=/^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(left.slice(left.lastIndexOf('\n')+1))?'\n':'';
 const after=(!left || left.endsWith('\n')) && /^(?: {0,3}(?:`{3,}|~{3,}|#{1,6} |>|[-*] |\|)| {4}|\t)/.test(right)?'\n':'';
 return {value:left+before+token+after+right,start:start+before.length};
}
/** Pretext collapses whitespace; each rendered UTF16 boundary still points into original source. */
export function fragmentSourceMap(source:string,visible:string,start:number,from=0):{offsets:number[];next:number}{
 const offsets:number[]=[];let cursor=from;
 for(let i=0;i<visible.length;i++){
  const char=visible[i]!;
  if(/\s/.test(char)){while(cursor<source.length && !/\s/.test(source[cursor]!))cursor++;if(!offsets.length)offsets.push(start+cursor);while(cursor<source.length && /\s/.test(source[cursor]!))cursor++;}
  else {if(source[cursor]!==char){const found=source.indexOf(char,cursor);if(found>=0)cursor=found;}if(!offsets.length)offsets.push(start+cursor);cursor=Math.min(source.length,cursor+1);}
  offsets.push(start+cursor);
 }
 if(!offsets.length)offsets.push(start+cursor);return {offsets,next:cursor};
}
type CaretDocument=Document & {caretPositionFromPoint?:(x:number,y:number)=>{offsetNode:Node;offset:number}|null;caretRangeFromPoint?:(x:number,y:number)=>Range|null};
function sourceOffsets(element:HTMLElement):number[]{
 if(element.dataset.sourceMap){try{const offsets:unknown=JSON.parse(element.dataset.sourceMap);if(Array.isArray(offsets) && offsets.every(value=>Number.isSafeInteger(value)))return offsets;}catch{}}
 const start=Number(element.dataset.sourceStart);return Array.from({length:(element.textContent?.length ?? 0)+1},(_,i)=>start+i);
}
function prefixLength(element:HTMLElement,node:Node,offset:number):number{
 try{const range=element.ownerDocument.createRange();range.setStart(element,0);range.setEnd(node,offset);return range.toString().length;}catch{return 0;}
}
function caretRect(element:HTMLElement,index:number):{x:number;y:number;height:number}{
 const doc=element.ownerDocument,walker=doc.createTreeWalker(element,4);let remaining=index,node:Node|null;
 while((node=walker.nextNode())){const length=node.textContent?.length ?? 0;if(remaining<=length){const range=doc.createRange();range.setStart(node,remaining);range.collapse(true);const rect=range.getBoundingClientRect?.();if(rect && rect.height>0)return {x:rect.left,y:rect.top,height:rect.height};break;}remaining-=length;}
 const rect=element.getBoundingClientRect(),height=rect.height || parseFloat(getComputedStyle(element).lineHeight) || 20.8;
 return {x:rect.left+(rect.width && element.textContent?.length?rect.width*index/element.textContent.length:0),y:rect.top,height};
}
function visualCaret(root:HTMLElement,offset:number,fallback:HTMLElement,index:number):FlowCaret{
 let element=fallback,position=index,distance=Infinity;
 for(const span of root.querySelectorAll<HTMLElement>('[data-source-start]')){
  const start=Number(span.dataset.sourceStart),end=Number(span.dataset.sourceEnd);
  const delta=offset<start?start-offset:offset>end?offset-end:0;if(delta>=distance)continue;
  const offsets=sourceOffsets(span);let low=0,high=offsets.length-1;
  while(low<high){const mid=Math.floor((low+high)/2);if(offsets[mid]!<offset)low=mid+1;else high=mid;}
  const previous=Math.max(0,low-1),at=Math.abs(offsets[previous]!-offset)<=Math.abs(offsets[low]!-offset)?previous:low;
  distance=Math.abs(offsets[at]!-offset);element=span;position=at;if(distance===0)break;
 }
 const rect=caretRect(element,position),box=root.getBoundingClientRect();return {offset,x:rect.x-box.left,y:rect.y-box.top,height:rect.height};
}
/** Use browser caret geometry, with nearest visible text as a fallback for empty space. */
export function flowCaretFromPoint(root:HTMLElement,text:string,x:number,y:number):FlowCaret|null{
 const doc=root.ownerDocument as CaretDocument,caret=doc.caretPositionFromPoint?.(x,y),range=!caret?doc.caretRangeFromPoint?.(x,y):null;
 const node=caret?.offsetNode ?? range?.startContainer,offset=caret?.offset ?? range?.startOffset ?? 0;
 const parent=node?.nodeType===1?node as Element:node?.parentElement;
 let element=parent?.closest<HTMLElement>('[data-source-start]') ?? null,index=0;
 if(element && root.contains(element))index=prefixLength(element,node!,offset);
 else {
  element=null;let distance=Infinity;
  for(const span of root.querySelectorAll<HTMLElement>('[data-source-start]')){
   const rect=span.getBoundingClientRect(),dx=Math.max(rect.left-x,0,x-rect.right),dy=Math.max(rect.top-y,0,y-rect.bottom),value=dy*dy*4+dx*dx;
   if(value<distance){distance=value;element=span;index=x<rect.left+rect.width/2?0:(span.textContent?.length ?? 0);}
  }
  let picture:FlowCaret|null=null;
  for(const frame of root.querySelectorAll<HTMLElement>('.image-placement[data-layout="inline"][data-source-image-start]')){
   const rect=frame.getBoundingClientRect(),dx=Math.max(rect.left-x,0,x-rect.right),dy=Math.max(rect.top-y,0,y-rect.bottom),value=dy*dy*4+dx*dx;
   if(value>=distance)continue;
   const after=y>rect.bottom || (y>=rect.top && x>=rect.left+rect.width/2),box=root.getBoundingClientRect();
   distance=value;picture={offset:safeFlowOffset(text,Number(after?frame.dataset.sourceImageEnd:frame.dataset.sourceImageStart)),x:(after?rect.right:rect.left)-box.left,y:rect.top-box.top,height:rect.height || 20.8};
  }
  if(picture)return picture;
 }
 if(!element)return null;
 const offsets=sourceOffsets(element),mapped=offsets[Math.min(index,offsets.length-1)] ?? Number(element.dataset.sourceEnd);
 const safe=safeFlowOffset(text,mapped);
 if(safe===mapped){const rect=caretRect(element,index),box=root.getBoundingClientRect();return {offset:safe,x:rect.x-box.left,y:rect.y-box.top,height:rect.height};}
 return visualCaret(root,safe,element,index);
}
