import {EditMode} from './edit-mode.ts';
import {useContext} from 'react';
import {passedDragThreshold,swallowDragClick} from './pointer-gesture.ts';
import {objectDragPaper} from './object-drag-paper.ts';
import {objectToolPlacement} from './object-tool-placement.ts';
import {createPortal} from 'react-dom';
import {useEffect,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {prepareWithSegments,measureNaturalWidth,layoutNextLine,type PreparedTextWithSegments,type LayoutCursor} from '@chenglou/pretext';
import {prepareRichInline,type PreparedRichInline,type RichInlineItem} from '@chenglou/pretext/rich-inline';
import {type ImageLayout,type ImagePlacement} from '../core/image-markdown.ts';
import {parseBodyObjects as parseCardImages,serializeBodyObject as serializeImage,shiftBodyLayer as shiftImageLayer,type BodyObject} from '../core/body-objects.ts';
import {serializeTable,resizeTableTracks,type TableData} from '../core/table-markdown.ts';
import {TableObject,type TableHandle} from './TableObject.tsx';
import {mapMarkdownEditorOffset} from './markdown-editor-model.ts';
import type {CardImage} from '../core/types.ts';
import {uiText} from '../i18n/text.ts';
import {ImageGallery} from './ImageGallery.tsx';
import {ImageHoverHint,type ImageHoverPoint} from './ImageHoverHint.tsx';
import {imageStack,imageLayerActions} from '../core/image-layers.ts';
import {imageBounds,bodyViewport} from './image-bounds.ts';
import {ImageToolbar} from './ImageToolbar.tsx';
import {flowImageText,imageTextSlots,type ImageExclusion,type ImageTextLine} from './image-layout.ts';
import type {Request} from './controller.ts';
import {openLink} from './native.ts';
import {flowCaretFromPoint,fragmentSourceMap,moveFlowImage,type FlowCaret} from './flow-image-drag.ts';
import {inlineText,horizontalRule,tableCells,tableAlignment,type InlineText} from './markdown-syntax.ts';
import './image-layout.css';
import './flow-image-drag.css';

type Atom={kind:'text';text:string;start:number}|{kind:'image';index:number};
type Segment=Omit<InlineText,'kind'|'start'|'end'> & {kind:InlineText['kind']|'task';start?:number;end?:number;sourceMap?:number[];task?:Paragraph['task'];label?:string}|{kind:'image';index:number;text:string};
type Paragraph={kind:'paragraph';tag:'p'|'h1'|'h2'|'h3'|'blockquote'|'pre';segments:Segment[];size:number;lineHeight:number;prefix?:string;task?:{offset:number;checked:boolean}};
type Block=Paragraph|{kind:'object';index:number}|{kind:'gap';start:number;end:number}|{kind:'rule';start:number;end:number}|{kind:'table';rows:Segment[][][];alignment:('left'|'right'|'center')[]};
type ObjectPlacement=ImagePlacement & {data?:TableData};
type Geometry={layout:ImageLayout;x:number;y:number;width:number;height:number};
function resizeDimensions(start:Geometry,dx:number,dy:number,proportional:boolean,aspectRatio:number,limits={width:16384,height:16384}):{width:number;height:number}{
 const bound=(value:number)=>Math.max(8,Math.min(16384,value));
 if(!proportional)return {width:Math.min(limits.width,bound(start.width+dx)),height:Math.min(limits.height,bound(start.height+dy))};
 // Extremely thin images cannot fit both limits; object-fit still preserves the image itself.
 const ratio=Math.max(8/limits.height,Math.min(limits.width/8,aspectRatio)),minimum=Math.max(8,8/ratio),maximum=Math.min(limits.height,limits.width/ratio);
 const baseHeight=Math.max(start.height,start.width/ratio),factor=Math.max((start.width+dx)/(baseHeight*ratio),(start.height+dy)/baseHeight),height=Math.max(minimum,Math.min(maximum,baseHeight*factor));
 return {width:bound(ratio*height),height:bound(height)};
}
const floating=(layout:ImageLayout)=>layout==='float' || layout==='overlay' || layout==='underlay';
const font=(paragraph:Paragraph,segment:Segment,family:string)=>`${segment.kind!=='image' && segment.italic?'italic ':''}${paragraph.tag==='h1' || paragraph.tag==='h2' || paragraph.tag==='h3' || segment.kind!=='image' && segment.strong?'600':'400'} ${paragraph.size*(segment.kind!=='image' && segment.script ? .75 : 1)}px ${paragraph.tag==='pre' || segment.kind==='code'?'Consolas, monospace':family}`;
function segments(atoms:Atom[]):Segment[]{
 let value='';const offsets:number[]=[],pictures=new Map<number,number>();
 for(const atom of atoms){if(atom.kind==='image'){pictures.set(value.length,atom.index);value+='\uFFFC';offsets.push(-1);}else{for(let i=0;i<atom.text.length;i++)offsets.push(atom.start+i);value+=atom.text;}}
 offsets.push(atoms.at(-1)?.kind==='text'?(atoms.at(-1) as Extract<Atom,{kind:'text'}>).start+(atoms.at(-1) as Extract<Atom,{kind:'text'}>).text.length:0);
 const result:Segment[]=[];
 for(const token of inlineText(value)){
  let from=0;
  const append=(to:number)=>{if(to<=from)return;const start=token.start+from,end=token.start+to;const map=offsets.slice(start,end);map.push((offsets[end-1] ?? 0)+1);result.push({...token,text:token.text.slice(from,to),start:map[0]!,end:map.at(-1)!,...(map.every((offset,i)=>offset===map[0]!+i)?{}:{sourceMap:map})});};
  // Images remain atomic even inside formatted text.
  for(let i=0;i<token.text.length;i++)if(pictures.has(token.start+i)){append(i);result.push({kind:'image',index:pictures.get(token.start+i)!,text:'\uFFFC'});from=i+1;}
  append(token.text.length);
 }
 return result;
}
/** One sequence owns all body text; free images are removed exactly once, not rendered as text. */
function bodyBlocks(text:string,references:BodyObject[],geometry:Geometry[]):Block[]{
 const rows:{atoms:Atom[];start:number;end:number}[]=[],row:Atom[]=[];let rowStart=0;
 const finish=(end:number)=>{rows.push({atoms:row.splice(0),start:rowStart,end});rowStart=end+1;};
 const append=(value:string,start:number)=>{let offset=start;value.split('\n').forEach((line,index)=>{if(index){finish(offset-1);}if(line){const last=row.at(-1);if(last?.kind==='text' && last.start+last.text.length===offset)last.text+=line;else row.push({kind:'text',text:line,start:offset});}offset+=line.length+1;});};
 let cursor=0;
 references.forEach((reference,index)=>{append(text.slice(cursor,reference.start),cursor);if(geometry[index]!.layout==='inline')row.push({kind:'image',index});cursor=reference.end;});
 append(text.slice(cursor),cursor);if(row.length)finish(text.length);
 // Tables occupy a block at their source position; their size cannot move them to another text line.
 const separated=rows.flatMap(source=>{
  if(!source.atoms.some(atom=>atom.kind==='image' && references[atom.index]?.table))return [source];
  const parts:typeof rows=[],pending:Atom[]=[];
  const emit=()=>{if(!pending.length)return;const first=pending[0]!,last=pending.at(-1)!;parts.push({atoms:pending.splice(0),start:first.kind==='text'?first.start:references[first.index]!.start,end:last.kind==='text'?last.start+last.text.length:references[last.index]!.end});};
  for(const atom of source.atoms){if(atom.kind==='image' && references[atom.index]?.table){emit();parts.push({atoms:[atom],start:references[atom.index]!.start,end:references[atom.index]!.end});}else pending.push(atom);}emit();return parts;
 });
 rows.splice(0,rows.length,...separated);
 const blocks:Block[]=[],code:{text:string;start:number;end:number}[]=[];let fenced:{char:string;length:number}|null=null;
 const codeBlock=()=>{if(code.length)blocks.push({kind:'paragraph',tag:'pre',segments:[{kind:'text',text:code.map(row=>row.text).join('\n'),start:code[0]!.start,end:code.at(-1)!.end}],size:12,lineHeight:20.8});code.length=0;};
 for(let rowIndex=0;rowIndex<rows.length;rowIndex++){const source=rows[rowIndex]!,row=source.atoms;
  if(row.length===1 && row[0]!.kind==='image' && references[row[0]!.index]?.table){blocks.push({kind:'object',index:row[0]!.index});continue;}
  const raw=row.map(atom=>atom.kind==='text'?atom.text:'').join('');
  const fence=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
  if(fence){if(!fenced){fenced={char:fence[1]![0]!,length:fence[1]!.length};continue;}if(fence[1]![0]===fenced.char && fence[1]!.length>=fenced.length && !fence[2]!.trim()){codeBlock();fenced=null;continue;}}
  if(fenced){code.push({text:raw,start:source.start,end:source.end});continue;}
  if(!row.some(atom=>atom.kind==='image') && horizontalRule(raw)){blocks.push({kind:'rule',start:source.start,end:source.end});continue;}
  const align=rows[rowIndex+1]?tableAlignment(text.slice(rows[rowIndex+1]!.start,rows[rowIndex+1]!.end)):null;
  const header=tableCells(text.slice(source.start,source.end),source.start);
  if(align && header?.length===align.length){
   const tableRows:Segment[][][]=[];
   const cells=(r:typeof source)=>tableCells(text.slice(r.start,r.end),r.start);
   const add=(r:typeof source)=>{const parts=cells(r)!;tableRows.push(align.map((_,index)=>{const cell=parts[index];if(!cell)return [];const atoms:Atom[]=[];for(const atom of r.atoms){if(atom.kind==='image'){const ref=references[atom.index]!;if(ref.start>=cell.start && ref.end<=cell.end)atoms.push(atom);}else{const start=Math.max(cell.start,atom.start),end=Math.min(cell.end,atom.start+atom.text.length);if(end>start)atoms.push({kind:'text',text:text.slice(start,end),start});}}return segments(atoms);}));};
   add(source);rowIndex++;
   while(rows[rowIndex+1] && cells(rows[rowIndex+1]!) && text.slice(rows[rowIndex+1]!.start,rows[rowIndex+1]!.end).trim()){add(rows[++rowIndex]!);}
   blocks.push({kind:'table',rows:tableRows,alignment:align});continue;
  }
  if(!raw.trim() && !row.some(atom=>atom.kind==='image')){blocks.push({kind:'gap',start:source.start,end:source.end});continue;}
  let tag:Paragraph['tag']='p',size=13,lineHeight=20.8,prefix:string|undefined,task:Paragraph['task'];
  const first=row[0]?.kind==='text'?row[0]:undefined,heading=/^(#{1,3}) /.exec(first?.text ?? '');
  const trim=(count:number)=>{first!.text=first!.text.slice(count);first!.start+=count;};
  if(heading){tag=heading[1]!.length===1?'h1':heading[1]!.length===2?'h2':'h3';size=tag==='h1'?23:tag==='h2'?19:16;lineHeight=size*1.6;trim(heading[0].length);}
  else if(first?.text.startsWith('> ')){tag='blockquote';trim(2);}
  else if(first && /^[-*] \[[ xX]\] /.test(first.text)){task={offset:first.start+3,checked:first.text[3]?.toLowerCase()==='x'};trim(6);}
  else if(first && /^[-*] /.test(first.text)){prefix='•';trim(2);}
  blocks.push({kind:'paragraph',tag,segments:segments(row),size,lineHeight,...(prefix===undefined?{}:{prefix}),...(task?{task}:{})});
 }
 if(fenced)codeBlock();
 return blocks;
}
function fallbackImage(reference:BodyObject,index:number):CardImage{return reference.image?{...reference.image,name:reference.alt || reference.image.name}:{id:`asset-${index}`,assetId:reference.assetId,name:reference.alt,mime:reference.assetId.endsWith('.jpg')?'image/jpeg':reference.assetId.endsWith('.webp')?'image/webp':reference.assetId.endsWith('.gif')?'image/gif':'image/png',width:1,height:1};}
function imageGeometry(reference:BodyObject,width:number,intrinsic?:{width:number;height:number}):Geometry{
 if(reference.table?.collapsed)return {layout:reference.layout,x:reference.x ?? 0,y:reference.y ?? 0,width:Math.max(80,(reference.displayName.length+2)*8+12),height:26};
 const natural=intrinsic ?? reference.image ?? {width:width,height:Math.min(width,240)};
 const w=reference.width ?? Math.min(width,reference.layout==='inline'?120:natural.width),h=reference.height ?? Math.max(8,w*natural.height/Math.max(1,natural.width));
 return {layout:reference.layout,x:reference.x ?? 0,y:reference.y ?? 0,width:Math.max(8,w),height:Math.max(8,h)};
}
type Props={text:string;images:CardImage[];id?:string|undefined;send?:((request:Request)=>Promise<unknown>)|undefined;prepare?:(()=>Promise<unknown>)|undefined;compact?:boolean};
type Gesture={pointerId:number;index:number;before:string;reference:BodyObject;start:Geometry;grabX:number;grabY:number;resize:boolean;clientX:number;clientY:number;moved:boolean;flowTarget:FlowCaret|null;entering:boolean;aspectRatio:number};
function routeCodeLine(prepared:PreparedTextWithSegments,width:number,startY:number,height:number,rectangles:ImageExclusion[]):{lines:ImageTextLine[];height:number}{
 const lines:ImageTextLine[]=[];let y=startY,cursor:LayoutCursor={segmentIndex:0,graphemeIndex:0};
 if(!layoutNextLine(prepared,cursor,width))return {lines,height:y+height};
 while(layoutNextLine(prepared,cursor,width)){
  let moved=false;
  for(const slot of imageTextSlots(width,y,height,rectangles).filter(s=>s.width>=Math.min(width,24))){
   const line=layoutNextLine(prepared,cursor,slot.width);if(!line)break;if(line.width>slot.width+.01)continue;
   lines.push({x:slot.x,y,width:slot.width,height,fragments:[{itemIndex:0,text:line.text,gapBefore:0,occupiedWidth:line.width,start:line.start,end:line.end}]});cursor=line.end;moved=true;
  }
  if(moved)y+=height;
  else{const bottoms=rectangles.filter(r=>r.y+r.height+8>y).map(r=>r.y+r.height+8);if(bottoms.length)y=Math.max(y+height,Math.min(...bottoms));else{const line=layoutNextLine(prepared,cursor,width)!;lines.push({x:0,y,width,height,fragments:[{itemIndex:0,text:line.text,gapBefore:0,occupiedWidth:line.width,start:line.start,end:line.end}]});cursor=line.end;y+=height;}}
 }
 return {lines,height:y};
}

export function RichImageBody({text,images,id,send:write,prepare,compact=false}:Props){
 const {editable}=useContext(EditMode),send=editable?write:undefined;
 const host=useRef<HTMLDivElement>(null),frames=useRef(new Map<number,HTMLDivElement>()),latest=useRef(text),gesture=useRef<Gesture|null>(null),stopGesture=useRef<(()=>void)|null>(null),clickCleanup=useRef<(()=>void)|null>(null),preparedCache=useRef(new Map<number|string,{key:string;prepared:PreparedRichInline}>());
 const fallbackDock=useRef<HTMLDivElement>(null),[tableDock,setTableDock]=useState<HTMLElement|null>(null);
 const insertionLine=useRef<HTMLSpanElement>(null),tableHandles=useRef(new Map<number,TableHandle>());
 const [objectBoundary,setObjectBoundary]=useState({width:0,height:0});
 const [tableSizes,setTableSizes]=useState<{key:string;heights:Record<number,number>}>({key:'',heights:{}});
 const [hovered,setHovered]=useState<ImageHoverPoint|null>(null);
 const preparedCode=useRef(new Map<string,{key:string;prepared:PreparedTextWithSegments}>());
 const [width,setWidth]=useState(320),[family,setFamily]=useState('Inter,"Segoe UI","Microsoft YaHei",sans-serif'),[selected,setSelected]=useState<number|null>(null),[preview,setPreview]=useState<{index:number;placement:ObjectPlacement}|null>(null),[intrinsic,setIntrinsic]=useState<Record<string,{width:number;height:number}>>({}),[captions,setCaptions]=useState<Record<number,number>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [readOnlyExpanded,setReadOnlyExpanded]=useState<Set<string>>(()=>new Set());
 const foldBusy=useRef(false);
 const parsed=useMemo(()=>parseCardImages(text,images),[text,images]);
 const references=useMemo(()=>parsed.map(reference=>reference.table?.collapsed && readOnlyExpanded.has(reference.displayName)?{...reference,table:{...reference.table,collapsed:false}}:reference),[parsed,readOnlyExpanded]);latest.current=text;
 useEffect(()=>setReadOnlyExpanded(new Set()),[text,id]);
 const names=useMemo(()=>references.map(reference=>reference.displayName),[references]);
 const geometry=references.map((reference,index)=>imageGeometry(preview?.index===index?{...reference,...preview.placement}:reference,width,intrinsic[reference.assetId]));
 const tableKey=JSON.stringify([text,width,geometry.map(g=>[g.width,g.height,g.layout])]);
 const stack=imageStack(references.map((reference,index)=>({...reference,layout:geometry[index]!.layout})));
 const currentGeometry=useRef(geometry);currentGeometry.current=geometry;
 const blocks=useMemo(()=>bodyBlocks(text,references,geometry),[text,references,preview?.placement.layout]);
 const free=geometry.flatMap((rect,index)=>rect.layout==='float'?[{...rect,index}]:[]),wrap=free.length>0;
 useLayoutEffect(()=>{
  const root=host.current;if(!root)return;const origin=root.getBoundingClientRect();let width=0,height=0;
  for(const [index,g] of geometry.entries()){
   const frame=frames.current.get(index)?.getBoundingClientRect(),measured=frame && frame.width>0;
   width=Math.max(width,(measured?frame.left-origin.left:g.x)+(measured?frame.width:g.width)+64);
   height=Math.max(height,(measured?frame.top-origin.top:g.y)+(measured?frame.height:g.height)+64);
  }
  setObjectBoundary(old=>old.width===width && old.height===height?old:{width,height});
 });
 useLayoutEffect(()=>{
  const element=host.current;if(!element)return;
  const measure=()=>{if(element.clientWidth>0)setWidth(element.clientWidth);const actualFamily=getComputedStyle(element.parentElement ?? element).fontFamily;if(actualFamily)setFamily(actualFamily);const changes:Record<number,number>={};for(const [index,frame] of frames.current){const g=currentGeometry.current[index];if(g && !floating(g.layout) && frame.offsetHeight>0)changes[index]=Math.max(0,frame.offsetHeight-g.height);}setCaptions(old=>Object.entries(changes).some(([key,value])=>Math.abs((old[Number(key)] ?? -1)-value)>.5)?{...old,...changes}:old);};
  measure();const observer=new ResizeObserver(measure);observer.observe(element);for(const frame of frames.current.values())observer.observe(frame);return()=>observer.disconnect();
 },[references,preview?.placement.layout]);
 useLayoutEffect(()=>{
  if(!wrap || !host.current)return;const root=host.current;
  const measure=()=>{const heights:Record<number,number>={};for(const table of root.querySelectorAll<HTMLElement>('[data-table-block]'))if(table.offsetHeight>0)heights[Number(table.dataset.tableBlock)]=table.offsetHeight;
   if(Object.keys(heights).length)setTableSizes(old=>old.key===tableKey && JSON.stringify(old.heights)===JSON.stringify(heights)?old:{key:tableKey,heights});};
  const observer=new ResizeObserver(measure);for(const table of root.querySelectorAll('[data-table-block]'))observer.observe(table);measure();return()=>observer.disconnect();
 },[tableKey,wrap]);
 useLayoutEffect(()=>{setTableDock(selected!==null?fallbackDock.current:null);},[selected]);
 useLayoutEffect(()=>{
  const dock=tableDock,frame=selected===null?null:frames.current.get(selected),root=host.current;if(!dock || !frame || !root){return;}
  const measure=()=>{const box=root.getBoundingClientRect(),raw=frame.getBoundingClientRect(),g=currentGeometry.current[selected!]!,clip=bodyViewport(root) ?? {left:box.left,right:box.right || window.innerWidth,top:0,bottom:window.innerHeight};
   dock.style.maxWidth=`${Math.max(0,clip.right-clip.left)}px`;dock.style.maxHeight=`${Math.max(0,clip.bottom-clip.top)}px`;const toolbar=dock.getBoundingClientRect();
   const object=raw.width>0?raw:{left:box.left+g.x,right:box.left+g.x+g.width,top:box.top+g.y,bottom:box.top+g.y+g.height};
   const position=objectToolPlacement(object,toolbar,clip);dock.dataset.toolSide=position.side;dock.style.left=`${position.left-box.left}px`;dock.style.top=`${position.top-box.top}px`;
  };
  measure();const observer=new ResizeObserver(measure);observer.observe(dock);observer.observe(frame);observer.observe(root);window.addEventListener('scroll',measure,true);window.addEventListener('resize',measure);return()=>{observer.disconnect();window.removeEventListener('scroll',measure,true);window.removeEventListener('resize',measure);};
 });
 useEffect(()=>{setPreview(null);setHovered(null);if(selected!==null && selected>=references.length)setSelected(null);},[text]);
 const consumeClick=(press:PointerEvent,onCapture?:()=>void,observeMove=false)=>{
  clickCleanup.current?.();let moved=false;
  const movement=(event:PointerEvent)=>{if(event.pointerId!==press.pointerId)return;if(Math.max(Math.hypot(event.clientX-press.clientX,event.clientY-press.clientY),Math.hypot(event.screenX-press.screenX,event.screenY-press.screenY))>=6)moved=true;};
  const release=(event:PointerEvent)=>{movement(event);if(moved)cleanup();};
  const click=(event:MouseEvent)=>{if(event.button!==press.button || event.detail===0)return;if(!moved){event.preventDefault();event.stopImmediatePropagation();onCapture?.();}cleanup();};
  const nextPress=(event:PointerEvent)=>{if(event!==press)cleanup();};
  const cleanup=()=>{document.removeEventListener('click',click,true);document.removeEventListener('pointerdown',nextPress,true);window.removeEventListener('pointermove',movement,true);window.removeEventListener('pointerup',release,true);window.removeEventListener('pointercancel',cleanup,true);window.removeEventListener('blur',cleanup);if(clickCleanup.current===cleanup)clickCleanup.current=null;};
  document.addEventListener('click',click,true);document.addEventListener('pointerdown',nextPress,true);clickCleanup.current=cleanup;
  if(observeMove){window.addEventListener('pointermove',movement,true);window.addEventListener('pointerup',release,true);window.addEventListener('pointercancel',cleanup,true);window.addEventListener('blur',cleanup);}
 };
 useEffect(()=>{
  if(selected!==null || !id || !send)return;
  const hit=(event:PointerEvent)=>{
   const target=event.target;if(event.button!==0 || !(target instanceof Element) || !host.current?.contains(target) || target.closest('a,button,input,textarea,select,.image-placement,.image-layout-toolbar'))return;
   for(const [index,frame] of [...frames.current].reverse()){
    if(currentGeometry.current[index]?.layout!=='underlay')continue;const rect=frame.getBoundingClientRect();
    if(event.clientX>=rect.left && event.clientX<=rect.right && event.clientY>=rect.top && event.clientY<=rect.bottom){event.preventDefault();event.stopImmediatePropagation();consumeClick(event);move(event,index,false,true);return;}
   }
  };
  document.addEventListener('pointerdown',hit,true);return()=>document.removeEventListener('pointerdown',hit,true);
 },[selected,id,send,references]);
 useEffect(()=>{
  if(selected===null)return;
  const outside=(event:PointerEvent)=>{
   if(event.button!==0)return;const target=event.target;if(target instanceof Element && target.closest('.image-layout-toolbar,.image-remove,.table-tools,.table-collapse,.table-collapsed-label,.table-axis-select,.table-track-grip,.table-cell-editor,[data-cell-editing=true],.table-size-tool'))return;
   if(gesture.current)return;
   const pane=host.current?.closest<HTMLElement>('.preview,.card-body-region,.document-region') ?? host.current;
   if(target instanceof Node && pane?.contains(target)){
    const frame=frames.current.get(selected),rect=frame?.getBoundingClientRect();
    const separateResize=target instanceof Element && !!target.closest(`.image-edit-controls[data-image-controls="${selected}"] .image-resize-grip`);
    const underlayHit=currentGeometry.current[selected]?.layout==='underlay' && rect && event.clientX>=rect.left && event.clientX<=rect.right && event.clientY>=rect.top && event.clientY<=rect.bottom && !(target instanceof Element && target.closest('a,button,input,textarea,select,.image-layout-toolbar,.image-edit-controls,.image-placement'));
    if(frame?.contains(target) || separateResize || underlayHit){event.preventDefault();event.stopImmediatePropagation();consumeClick(event,()=>{const cell=target instanceof Element?target.closest<HTMLElement>('[data-table-cell]'):null;if(cell && references[selected]?.table)tableHandles.current.get(selected)?.edit(cell.dataset.tableCell!,event.shiftKey);},!!references[selected]?.table);move(event,selected,separateResize || target instanceof Element && !!target.closest('.image-resize-grip'));}
    else consumeClick(event,()=>setSelected(null),true);
   }
   else setSelected(null);
  };
  const escape=(event:KeyboardEvent)=>{if(event.key!=='Escape' || event.isComposing || event.target instanceof Element && event.target.closest('.table-cell-editor'))return;event.preventDefault();event.stopPropagation();stopGesture.current?.();gesture.current=null;previewGesture.current=null;setPreview(null);setSelected(null);};
  document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);
  return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);};
 },[selected,busy,text,width]);
 useEffect(()=>()=>{stopGesture.current?.();clickCleanup.current?.();},[]);
 const actual=(index:number):Geometry=>{const rect=frames.current.get(index)?.getBoundingClientRect(),root=host.current?.getBoundingClientRect(),value=geometry[index]!;return rect && root?{...value,x:rect.left-root.left,y:rect.top-root.top}:value;};
 const commit=async(index:number,placement:ObjectPlacement,before=latest.current,reference=references[index]!)=>{
  if(!id || !send)return;setError('');setBusy(true);setPreview({index,placement});
  try{await prepare?.();if(reference.table && latest.current!==before){before=latest.current;reference=parseCardImages(before,images).find(item=>item.table?.name===reference.table!.name) ?? (()=>{throw new Error(uiText('tables.cellChanged'));})();}const value=before.slice(0,reference.start)+serializeImage(reference,placement)+before.slice(reference.end);await send({kind:'edit',id,field:'content',value,before});}
  catch(error){setError(String(error));setPreview(null);}finally{setBusy(false);}
 };
 const commitFlow=async(drag:Gesture)=>{
  if(!id || !send || !drag.flowTarget)return;setError('');setBusy(true);
  try{await prepare?.();let before=drag.before,reference=drag.reference,target=drag.flowTarget.offset;
   if(reference.table && latest.current!==before){target=mapMarkdownEditorOffset(before,latest.current,target);before=latest.current;reference=parseCardImages(before,images).find(item=>item.table?.name===reference.table!.name) ?? (()=>{throw new Error(uiText('tables.cellChanged'));})();}
   const moved=moveFlowImage(before,reference,target);if(moved.value===before)return;
   await send({kind:'edit',id,field:'content',value:moved.value,before});setSelected(parseCardImages(moved.value,images).findIndex(reference=>reference.start===moved.start));
  }catch(error){setError(String(error));}finally{setBusy(false);}
 };
 const move=(event:PointerEvent,index:number,resize=false,entering=false)=>{
  if(!id || !send || !references[index] || event.button!==0 || busy)return;
  event.preventDefault();event.stopPropagation();setSelected(index);stopGesture.current?.();
  const start=actual(index),root=host.current!.getBoundingClientRect(),reference=references[index]!;
  const natural=intrinsic[reference.assetId] ?? reference.image,aspectRatio=natural && natural.width>0 && natural.height>0?natural.width/natural.height:start.width/start.height;
  if(resize)host.current?.classList.add('image-resizing');
  previewGesture.current=null;gesture.current={pointerId:event.pointerId,index,before:latest.current,reference,start,grabX:event.clientX-root.left-start.x,grabY:event.clientY-root.top-start.y,resize,clientX:event.clientX,clientY:event.clientY,moved:false,flowTarget:null,entering,aspectRatio};
  const rootAtStart=root;
  const pointerId=event.pointerId;let paper:ReturnType<typeof objectDragPaper>|null=null;
  let lastPoint={x:event.clientX,y:event.clientY,shift:event.shiftKey};
  const update=(event:Pick<PointerEvent,'pointerId'|'clientX'|'clientY'|'shiftKey'|'preventDefault'>)=>{
   const drag=gesture.current;if(!drag || event.pointerId!==drag.pointerId)return;
   lastPoint={x:event.clientX,y:event.clientY,shift:event.shiftKey};
   if(!drag.moved){if(!passedDragThreshold(drag,event))return;drag.moved=true;host.current?.setPointerCapture?.(drag.pointerId);paper=objectDragPaper(host.current!,()=>update({pointerId,clientX:lastPoint.x,clientY:lastPoint.y,shiftKey:lastPoint.shift,preventDefault:()=>{}}));}event.preventDefault();const root=host.current!.getBoundingClientRect();
   if(!drag.resize && drag.start.layout==='inline'){
    const bounds=imageBounds(host.current!);const x=bounds?Math.max(root.left+bounds.left,Math.min(root.left+bounds.right,event.clientX)):event.clientX,y=bounds?Math.max(root.top+bounds.top,Math.min(root.top+bounds.bottom,event.clientY)):event.clientY;
    const caret=flowCaretFromPoint(host.current!,drag.before,x,y);drag.flowTarget=caret;
    const line=insertionLine.current;if(line){line.hidden=!caret;if(caret){line.style.left=`${caret.x}px`;line.style.top=`${caret.y}px`;line.style.height=`${caret.height}px`;}}
    paper?.update(event);const frame=frames.current.get(drag.index);if(frame)frame.dataset.dragging='true';return;
   }
   const clamp=(value:number)=>Math.max(-1e7,Math.min(1e7,value));
   const anchor={x:Math.max(0,drag.start.x),y:Math.max(0,drag.start.y)};
   const dx=event.clientX-drag.clientX+(rootAtStart.left-root.left),dy=event.clientY-drag.clientY+(rootAtStart.top-root.top);
   const target={x:Math.max(0,clamp(drag.start.x+dx)),y:Math.max(0,clamp(drag.start.y+dy))};
   const placement:ObjectPlacement=drag.resize?{layout:drag.start.layout,...resizeDimensions(drag.start,dx,dy,event.shiftKey,drag.aspectRatio),...(floating(drag.start.layout)?anchor:{})}:{layout:drag.start.layout,width:drag.start.width,height:drag.start.height,...target};
   if(drag.reference.table && drag.resize){const data=resizeTableTracks(drag.reference.table.data,placement.width,placement.height);placement.data=data;placement.width=data.columns.reduce((a,b)=>a+b,0);placement.height=data.rows.reduce((a,b)=>a+b,0);}
   paper?.update(event,{x:placement.x ?? drag.start.x,y:placement.y ?? drag.start.y,width:placement.width ?? drag.start.width,height:placement.height ?? drag.start.height});
   setPreview({index:drag.index,placement});previewGesture.current=placement;
  };
  const finish=(event:PointerEvent)=>{
   const drag=gesture.current;if(!drag || event.pointerId!==pointerId)return;update(event);const value=previewGesture.current;gesture.current=null;stopGesture.current?.();if(drag.moved)swallowDragClick();
   if(!drag.resize && drag.start.layout==='inline'){if(drag.moved)void commitFlow(drag);else if(!drag.entering && !drag.reference.table)setSelected(null);return;}
   const changed=value && (Math.abs((value.width ?? drag.start.width)-drag.start.width)>.01 || Math.abs((value.height ?? drag.start.height)-drag.start.height)>.01 || Math.abs((value.x ?? drag.start.x)-drag.start.x)>.01 || Math.abs((value.y ?? drag.start.y)-drag.start.y)>.01);
   if(drag.moved && value && changed)void commit(drag.index,value,drag.before,drag.reference);else{setPreview(null);if(!drag.moved && !drag.resize && !drag.entering && !drag.reference.table)setSelected(null);}previewGesture.current=null;
  };
  const cancel=(event:PointerEvent)=>{if(event.pointerId!==pointerId)return;gesture.current=null;stopGesture.current?.();previewGesture.current=null;setPreview(null);clickCleanup.current?.();};
  const modifier=(event:KeyboardEvent)=>{if(event.key!=='Shift' || !gesture.current?.resize)return;update({pointerId,clientX:lastPoint.x,clientY:lastPoint.y,shiftKey:event.type==='keydown' || event.shiftKey,preventDefault:()=>{}});};
  window.addEventListener('pointermove',update,{passive:false});window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',cancel);
  window.addEventListener('keydown',modifier);window.addEventListener('keyup',modifier);
  stopGesture.current=()=>{paper?.stop();window.removeEventListener('pointermove',update);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',cancel);window.removeEventListener('keydown',modifier);window.removeEventListener('keyup',modifier);host.current?.classList.remove('image-resizing');if(host.current?.hasPointerCapture?.(pointerId))host.current.releasePointerCapture(pointerId);if(insertionLine.current)insertionLine.current.hidden=true;const frame=frames.current.get(index);if(frame)frame.dataset.dragging='false';stopGesture.current=null;};
 };
 const previewGesture=useRef<ObjectPlacement|null>(null);
 const toggleTable=async(index:number,collapsed:boolean)=>{
  const name=references[index]?.table?.name;if(!name || foldBusy.current || busy)return;
  if(!id || !send){if(!collapsed)setReadOnlyExpanded(old=>new Set([...old,name]));return;}
  foldBusy.current=true;setBusy(true);setError('');
  try{
   await tableHandles.current.get(index)?.flush();await prepare?.();setBusy(true);
   const before=latest.current,reference=parseCardImages(before,images).find(item=>item.table?.name===name);if(!reference?.table)throw new Error(uiText('tables.cellChanged'));
   const value=before.slice(0,reference.start)+serializeTable(reference.table,{collapsed})+before.slice(reference.end);
   await send({kind:'edit',id,field:'content',before,value});setSelected(collapsed?null:index);
  }catch(error){setError(String(error));}finally{foldBusy.current=false;setBusy(false);}
 };
 const editingControls=(index:number,corner=false):ReactNode=>{
  const reference=references[index]!,rect=geometry[index]!;
  const layerActions=imageLayerActions(references,index);
  const shift=async(direction:'up'|'down')=>{if(!id || !send || busy)return;setBusy(true);setError('');try{await prepare?.();const before=latest.current,current=parseCardImages(before,images).findIndex(item=>item.displayName===reference.displayName),value=shiftImageLayer(before,current,direction);if(value!==before)await send({kind:'edit',id,field:'content',value,before});}catch(error){setError(String(error));}finally{setBusy(false);}};
  const remove=async()=>{if(!id || !send || busy)return;setBusy(true);setError('');try{await prepare?.();const before=latest.current,current=parseCardImages(before,images).find(item=>item.displayName===reference.displayName);if(!current)throw new Error(uiText('tables.cellChanged'));await send({kind:'edit',id,field:'content',value:before.slice(0,current.start)+before.slice(current.end),before});setSelected(null);}catch(error){setError(String(error));}finally{setBusy(false);}};
  return corner?<>{reference.table && <button className="table-collapse" disabled={busy} aria-label={uiText('tables.collapse')} title={uiText('tables.collapse')} onPointerDown={event=>{event.preventDefault();event.stopPropagation();}} onClick={event=>{event.stopPropagation();void toggleTable(index,true);}}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button>}<button className="image-remove" title={uiText(reference.table?'tables.remove':'images.remove')} aria-label={uiText(reference.table?'tables.remove':'images.remove')} disabled={busy} onPointerDown={event=>{event.preventDefault();event.stopPropagation();}} onClick={event=>{event.stopPropagation();void remove();}}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3m-9 0 1 15h10l1-15M10 10v7m4-7v7"/></svg></button><span className="image-resize-grip" role="separator" aria-label={uiText(reference.table?'tables.resize':'images.resize')} title={uiText(reference.table?'tables.resize':'images.resize')} onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();consumeClick(event.nativeEvent);move(event.nativeEvent,index,true);}}/></>:<ImageToolbar {...(reference.table?{modes:['inline','float'] as ImageLayout[],label:uiText('tables.layout')}: {})} layout={rect.layout} busy={busy} canUp={layerActions.up} canDown={layerActions.down} layerUp={()=>void shift('up')} layerDown={()=>void shift('down')} choose={layout=>{const current=actual(index);if(layout!==current.layout)void commit(index,{layout,width:current.width,height:current.height,...(floating(layout)?{x:current.x,y:current.y}:{})});}}/>;
 };
 const saveTable=async(index:number,data:TableData,expected?:TableData):Promise<void>=>{
  if(!id || !send)return;const name=references[index]?.table?.name,before=latest.current,reference=parseCardImages(before,images).find(item=>item.table?.name===name);
  if(!reference?.table || expected && JSON.stringify(reference.table.data)!==JSON.stringify(expected))throw new Error(uiText('tables.cellChanged'));
  setError('');setBusy(true);try{await send({kind:'edit',id,field:'content',before,value:before.slice(0,reference.start)+serializeTable(reference.table,{data})+before.slice(reference.end)});}catch(error){setError(String(error));throw error;}finally{setBusy(false);}
 };
 const gallery=(index:number,absolute?:{x:number;y:number},inline=false):ReactNode=>{
  const reference=references[index]!,rect=geometry[index]!,image=fallbackImage(reference,index),isFree=floating(rect.layout),active=selected===index;
  const position=absolute ?? (isFree?{x:rect.x,y:rect.y}:undefined);
  const style={width:rect.width,...(position?{position:'absolute',left:position.x,top:position.y}:{}),zIndex:stack[index],'--image-height':`${rect.height}px`} as CSSProperties;
  return <div key={`image-${index}`} ref={element=>{if(element)frames.current.set(index,element);else frames.current.delete(index);}} className={`image-placement ${inline?'image-placement-inline':''}`} data-image-index={index} data-object-name={reference.displayName} data-object-type={reference.table?'table':'image'} data-source-image-start={reference.start} data-source-image-end={reference.end} data-layout={rect.layout} data-selected={active} data-dragging={gesture.current?.index===index && gesture.current.moved} data-drawing-surface={id && send?'image-layout':undefined} role={id && send?(reference.table?'group':'button'):undefined} tabIndex={id && send?0:undefined} aria-label={id && send?uiText(reference.table?'tables.editLayout':'images.editLayout'):undefined} style={style} onPointerDown={event=>{if(id && send){if(reference.table?.collapsed)return;if(reference.table && (event.target as Element).closest('[data-cell-editing=true]'))return;event.preventDefault();event.stopPropagation();if(event.button===0 && !busy){consumeClick(event.nativeEvent,()=>{const cell=(event.target as Element).closest<HTMLElement>('[data-table-cell]');if(cell && reference.table)tableHandles.current.get(index)?.edit(cell.dataset.tableCell!,event.shiftKey);},!!reference.table);move(event.nativeEvent,index,false,selected!==index);}}}} onClick={event=>{event.stopPropagation();if(id && send && !busy)setSelected(index);}} onKeyDown={event=>{if(event.target===event.currentTarget && (event.key==='Enter' || event.key===' ') && id && send){event.preventDefault();event.stopPropagation();setSelected(index);}}}>
   {reference.table?.collapsed?<button className="table-collapsed-label" disabled={busy} aria-label={uiText('tables.expand',{arg0:reference.table.name})} title={uiText('tables.expand',{arg0:reference.table.name})} onPointerDown={event=>{event.preventDefault();event.stopPropagation();}} onClick={event=>{event.stopPropagation();void toggleTable(index,false);}}>{uiText('images.editorToken',{arg0:reference.table.name})}</button>:reference.table?<TableObject previewData={preview?.index===index?preview.placement.data:undefined} ref={handle=>{if(handle)tableHandles.current.set(index,handle);else tableHandles.current.delete(index);}} table={reference.table} width={rect.width} height={rect.height} index={index} active={active} toolsHost={active?tableDock:null} editable={!!id && !!send} images={images} activate={()=>setSelected(index)} finishEditing={()=>setSelected(null)} preview={size=>setPreview(size?{index,placement:{layout:rect.layout,...size}}:null)} save={(data,expected)=>saveTable(index,data,expected)}/>:<ImageGallery images={[image]} onIntrinsic={size=>setIntrinsic(old=>old[reference.assetId]?.width===size.width && old[reference.assetId]?.height===size.height?old:{...old,[reference.assetId]:size})}/>}
  </div>;
 };
 const taskSaving=useRef(false);
 const taskCheck=(task:NonNullable<Paragraph['task']>,label:string)=><input type="checkbox" className="markdown-task-check" checked={task.checked} disabled={!id || !send || busy} aria-label={uiText('markdown.task',{arg0:label})} title={uiText('markdown.task',{arg0:label})} data-drawing-surface="task" onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onChange={()=>{
  if(!id || !send || taskSaving.current)return;
  const before=latest.current;if(before[task.offset]!== (task.checked?'x':' ') && !(task.checked && before[task.offset]==='X'))return;
  taskSaving.current=true;setBusy(true);setError('');
  void (async()=>{try{await prepare?.();await send({kind:'edit',id,field:'content',before,value:before.slice(0,task.offset)+(task.checked?' ':'x')+before.slice(task.offset+1)});}catch(error){setError(String(error));}finally{taskSaving.current=false;setBusy(false);}})();
 }}/>;
 const renderSegment=(segment:Segment,index:number,textOverride?:string,map?:number[]):ReactNode=>{
  if(segment.kind==='image')return gallery(segment.index,undefined,true);
  if(segment.kind==='task')return <span key={index} className="rich-image-text">{taskCheck(segment.task!,segment.label ?? '')}</span>;
  const value=textOverride ?? segment.text,offsets=map && segment.sourceMap?map.map(offset=>segment.sourceMap![offset-segment.start!] ?? segment.end!):map ?? segment.sourceMap;
  const source=segment.start===undefined?{className:'rich-image-text'}:{className:'rich-image-text','data-source-start':offsets?.[0] ?? segment.start,'data-source-end':offsets?.at(-1) ?? segment.end,...(offsets?{'data-source-map':JSON.stringify(offsets)}:{})};
  let node:ReactNode=value;
  if(segment.strong)node=<strong>{node}</strong>;if(segment.italic)node=<em>{node}</em>;if(segment.deleted)node=<del>{node}</del>;
  if(segment.script==='sup')node=<sup>{node}</sup>;if(segment.script==='sub')node=<sub>{node}</sub>;
  if(segment.kind==='code')node=<code>{node}</code>;
  if(segment.kind==='link')node=<a href={segment.href} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.preventDefault();event.stopPropagation();void openLink(segment.href!);}}>{node}</a>;
  return <span key={index} {...source}>{node}</span>;
 };
 const insetX=compact?0:16,insetY=compact?0:12,textWidth=Math.max(1,width-insetX*2),textFree=free.map(rect=>({...rect,x:rect.x-insetX}));
 let flowHeight=insetY;
 const rendered:ReactNode[]=blocks.map((block,index)=>{
  if(block.kind==='object'){const rect=geometry[block.index]!,top=flowHeight;if(wrap)flowHeight+=rect.height+4;return <div key={index} className="table-flow-block" style={wrap?{position:'absolute',left:0,top,width:rect.width,height:rect.height}:{width:rect.width}}>{gallery(block.index)}</div>;}
  if(block.kind==='rule'){
   const start=flowHeight;if(wrap)flowHeight+=20;
   return <hr className="markdown-rule" key={index} data-source-start={block.start} data-source-end={block.end} style={wrap?{position:'absolute',left:0,top:start+8,width}:undefined}/>;
  }
  if(block.kind==='table'){
   // A table owns a full-width band. Keep it below intersecting free pictures.
   const cellWidth=Math.max(1,width/block.alignment.length-16),paragraph:Paragraph={kind:'paragraph',tag:'p',segments:[],size:13,lineHeight:20.8};
   const heights=wrap?block.rows.map((row,r)=>Math.max(32,...row.map((cell,c)=>{
    const items=cell.map(segment=>({text:segment.text,font:font(paragraph,segment,family),...(segment.kind==='image'?{break:'never' as const,extraWidth:geometry[segment.index]!.width}: {})}));
    const slot=`table:${index}:${r}:${c}`,key=JSON.stringify(items);let cached=preparedCache.current.get(slot);if(cached?.key!==key){cached={key,prepared:prepareRichInline(items)};preparedCache.current.set(slot,cached);}
    const result=flowImageText(cached.prepared,cellWidth,0,20.8,[],cell.map(segment=>segment.kind==='image'?geometry[segment.index]!.height:20.8));return result.height+12;
   }))):[];
   const height=(tableSizes.key===tableKey?tableSizes.heights[index]:undefined) ?? heights.reduce((sum,h)=>sum+h,0)+2;
   let top=flowHeight;if(wrap){let hit;while((hit=free.find(rect=>rect.x<width && rect.x+rect.width>0 && rect.y<top+height && rect.y+rect.height+8>top)))top=hit.y+hit.height+8;flowHeight=top+height+4;}
   const row=(cells:Segment[][],r:number)=> <tr key={r}>{cells.map((cell,c)=>{const Tag=r===0?'th':'td';return <Tag key={c} style={{textAlign:block.alignment[c]}}>{cell.map((segment,i)=>renderSegment(segment,i))}</Tag>;})}</tr>;
   return <table key={index} data-table-block={index} className="markdown-table" style={wrap?{position:'absolute',left:0,top,width,margin:0}:undefined}><thead>{row(block.rows[0]!,0)}</thead><tbody>{block.rows.slice(1).map((cells,r)=>row(cells,r+1))}</tbody></table>;
  }

  if(!wrap){if(block.kind==='gap')return <div className="paragraph-gap" data-source-start={block.start} data-source-end={block.end} key={index}/>;const Tag=block.tag==='p' && references.length?'div':block.tag;return <Tag className={`rich-text-paragraph ${!block.segments.some(segment=>segment.kind==='image')?'rich-text-inset':''} ${block.task?'md-task':block.prefix?'md-list':''}`} key={index} style={{fontSize:block.size,lineHeight:`${block.lineHeight}px`}}>{block.task && taskCheck(block.task,block.segments.map(segment=>segment.text).join(''))}{block.prefix && <span>{block.prefix} </span>}{block.segments.map((s,i)=>renderSegment(s,i))}</Tag>;}
  if(block.kind==='gap'){const y=flowHeight;flowHeight+=10;return <span key={index} data-source-start={block.start} data-source-end={block.end} style={{position:'absolute',left:0,top:y,height:10,width:1}}/>;}
  if(block.tag==='pre'){
   const start=flowHeight,lines:{line:ImageTextLine;maps:number[][]}[]=[],f=font(block,block.segments[0]!,family);let sourceOffset=block.segments[0]?.kind==='image'?0:block.segments[0]?.start ?? 0;
   block.segments.map(s=>s.text).join('').split('\n').forEach((source,lineIndex)=>{const key=JSON.stringify([source,f]),slot=`${index}:${lineIndex}`;let cached=preparedCode.current.get(slot);if(cached?.key!==key){cached={key,prepared:prepareWithSegments(source,f,{whiteSpace:'pre-wrap'})};preparedCode.current.set(slot,cached);}const result=routeCodeLine(cached.prepared,textWidth,flowHeight,block.lineHeight,textFree);let from=0;for(const line of result.lines){const maps=line.fragments.map(fragment=>{const mapped=fragmentSourceMap(source,fragment.text,sourceOffset,from);from=mapped.next;return mapped.offsets;});lines.push({line,maps});}sourceOffset+=source.length+1;flowHeight=result.height;});
   const end=flowHeight;flowHeight+=4;
   return <pre className="rich-flow-paragraph rich-code-flow" key={index} style={{position:'absolute',left:0,top:start,width,height:end-start,fontSize:block.size,lineHeight:`${block.lineHeight}px`}}>{lines.map(({line,maps},i)=><span className="rich-flow-line" key={i} style={{left:line.x+insetX,top:line.y-start,width:line.width,height:line.height,lineHeight:`${line.height}px`}}>{line.fragments.map((fragment,j)=><span key={j} data-source-start={maps[j]![0]} data-source-end={maps[j]!.at(-1)} data-source-map={JSON.stringify(maps[j])}>{fragment.text}</span>)}</span>)}</pre>;
  }
  const textSegments=block.task?[{kind:'task',text:'\uFFFC',task:block.task,label:block.segments.map(segment=>segment.text).join('')} as Segment,...block.segments]:block.prefix?[{kind:'text',text:block.prefix+' '} as Segment,...block.segments]:block.segments;
  const items:RichInlineItem[]=textSegments.map(segment=>{
   const f=font(block,segment,family);if(segment.kind==='task')return {text:'\uFFFC',font:f,break:'never',extraWidth:20-measureNaturalWidth(prepareWithSegments('\uFFFC',f))};if(segment.kind!=='image')return {text:segment.text,font:f};
   const glyph=measureNaturalWidth(prepareWithSegments('\uFFFC',f));return {text:'\uFFFC',font:f,break:'never',extraWidth:geometry[segment.index]!.width+8-glyph};
  });
  const key=JSON.stringify(items);let cached=preparedCache.current.get(index);if(cached?.key!==key){cached={key,prepared:prepareRichInline(items)};preparedCache.current.set(index,cached);}
  const result=flowImageText(cached.prepared,textWidth,flowHeight,block.lineHeight,textFree as ImageExclusion[],textSegments.map(segment=>segment.kind==='image'?geometry[segment.index]!.height+(captions[segment.index] ?? 0):block.lineHeight)),start=flowHeight;flowHeight=result.height+4;
  const sourceCursors=new Map<number,number>();
  const Tag=block.tag==='p'?'div':block.tag;
  return <Tag className="rich-flow-paragraph" key={index} style={{position:'absolute',left:0,top:start,width,height:result.height-start,fontSize:block.size,lineHeight:`${block.lineHeight}px`}}>{result.lines.map((line:ImageTextLine,lineIndex)=><span className="rich-flow-line" key={lineIndex} style={{left:line.x+insetX,top:line.y-start,width:line.width,height:line.height,lineHeight:`${line.height}px`}}>{line.fragments.map((fragment,i)=>{const segment=textSegments[fragment.itemIndex]!;let map:number[]|undefined;if(segment.kind!=='image' && segment.start!==undefined){const mapped=fragmentSourceMap(segment.text,fragment.text,segment.start,sourceCursors.get(fragment.itemIndex) ?? 0);sourceCursors.set(fragment.itemIndex,mapped.next);map=mapped.offsets;}return <span key={i} style={{marginLeft:fragment.gapBefore}}>{renderSegment(segment,i,fragment.text,map)}</span>;})}</span>)}</Tag>;
 });
 const extent=Math.max(wrap?flowHeight+insetY:0,...geometry.filter(g=>floating(g.layout)).map(g=>g.y+g.height+4));
 const hover=(event:{target:EventTarget;clientX:number;clientY:number})=>{
  if(gesture.current){setHovered(null);return;}
  if(event.target instanceof Element && event.target.closest('button,.image-resize-grip')){setHovered(null);return;}
  const target=event.target instanceof Element?event.target.closest<HTMLElement>('.image-placement'):null;let next=target && host.current?.contains(target)?Number(target.dataset.imageIndex):null;
  if(next===null)for(const [index,frame] of [...frames.current].reverse()){if(geometry[index]?.layout!=='underlay')continue;const rect=frame.getBoundingClientRect();if(event.clientX>=rect.left && event.clientX<=rect.right && event.clientY>=rect.top && event.clientY<=rect.bottom){next=index;break;}}
  setHovered(current=>next===null?null:current?.index===next?current:{index:next,x:event.clientX,y:event.clientY,name:names[next]!});
 };
 return <><div ref={host} className={`${references.length?'markdown-with-images':'markdown'} rich-image-body ${wrap?'has-free-images':''}`} title={hovered?'':undefined} style={{minHeight:Math.max(extent,objectBoundary.height) || undefined,fontFamily:family}} onPointerEnter={hover} onPointerMove={hover} onPointerLeave={()=>setHovered(null)}>
  <div ref={fallbackDock} className="table-floating-dock" data-floating-object-tools="true"/>
  {references.length>0 && <div data-body-object-boundary="true" aria-hidden="true" style={{position:'absolute',left:0,top:0,width:objectBoundary.width,height:objectBoundary.height,pointerEvents:'none'}}/>}
  <div className="rich-image-flow">{rendered}</div>
  {geometry.map((rect,index)=>floating(rect.layout)?gallery(index):null)}
  {selected!==null && geometry[selected] && !references[selected]?.table?.collapsed && <div className={`image-edit-controls ${references[selected]?.table?'table-edit-controls':''}`} data-image-controls={selected} style={{position:'absolute',left:floating(geometry[selected]!.layout)?geometry[selected]!.x:actual(selected).x,top:floating(geometry[selected]!.layout)?geometry[selected]!.y:actual(selected).y,width:geometry[selected]!.width,height:geometry[selected]!.height,zIndex:1000001,pointerEvents:'none','--image-height':`${geometry[selected]!.height}px`} as CSSProperties}>{editingControls(selected,true)}</div>}
  <ImageHoverHint point={hovered}/>
  <span ref={insertionLine} className="flow-image-caret" hidden aria-hidden="true"/>
  {error && <div className="image-layout-error" role="alert">{error}</div>}
 </div>{tableDock && selected!==null && !references[selected]?.table?.collapsed && createPortal(<div className="table-layout-tools">{editingControls(selected)}</div>,tableDock)}</>;
}
