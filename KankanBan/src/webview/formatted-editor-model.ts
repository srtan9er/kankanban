import {EditorState,TextSelection} from 'prosemirror-state';
import {toggleMark} from 'prosemirror-commands';
import {Fragment} from 'prosemirror-model';
import {parseBodyObjects} from '../core/body-objects.ts';
import {parseRichBody,serializeRichBody,richBodySchema,richBodySerializer,sourceToVisualPosition,visualPositionToSource} from './rich-editor-model.ts';

export type FormattedRange={start:number;end:number;backward:boolean;inside:boolean};
export type FormattedPoint={node:Node;offset:number};
export type FormattedSnapshot={anchorNode:Node|null;anchorOffset:number;focusNode:Node|null;focusOffset:number};
export const formattedExcluded='.image-placement,.table-floating-dock,.image-edit-controls,[data-floating-object-tools],button,input,textarea,select,[aria-hidden="true"]';
type Unit={element:HTMLElement;offsets:number[];start:number;end:number;atomic:boolean};
function excluded(element:Element,root:HTMLElement){const match=element.closest(formattedExcluded);return !!match && root.contains(match);}
function units(root:HTMLElement):Unit[]{
 const text=[...root.querySelectorAll<HTMLElement>('[data-source-start]')].filter(element=>!excluded(element,root) && ![...element.querySelectorAll('[data-source-start]')].some(child=>!excluded(child,root))).flatMap(element=>{
  const start=Number(element.dataset.sourceStart),end=Number(element.dataset.sourceEnd ?? start);if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(end))return [];
  let offsets:number[]|undefined;try{const parsed:unknown=JSON.parse(element.dataset.sourceMap ?? 'null');if(Array.isArray(parsed)&&parsed.length===(element.textContent?.length??0)+1&&parsed.every(value=>Number.isSafeInteger(value)&&value>=0))offsets=parsed;}catch{/* Plain fragments use consecutive source offsets. */}
  return [{element,start,end,offsets:offsets??Array.from({length:(element.textContent?.length??0)+1},(_,index)=>Math.min(end,start+index)),atomic:false}];
 });
 const atoms=[...root.querySelectorAll<HTMLElement>('.image-placement[data-source-image-start]')].filter(element=>!element.parentElement?.closest('.image-placement')).map(element=>({element,start:Number(element.dataset.sourceImageStart),end:Number(element.dataset.sourceImageEnd),offsets:[],atomic:true}));
 return [...text,...atoms].sort((a,b)=>a.start-b.start||Number(a.atomic)-Number(b.atomic));
}
function textPoint(element:HTMLElement,index:number):FormattedPoint{
 const walker=element.ownerDocument.createTreeWalker(element,4);let remaining=Math.max(0,index),last:Node|null=null,node:Node|null;
 while((node=walker.nextNode())){last=node;const length=node.textContent?.length??0;if(remaining<=length)return {node,offset:remaining};remaining-=length;}
 return last?{node:last,offset:last.textContent?.length??0}:{node:element,offset:0};
}
function childBoundary(element:HTMLElement,after:boolean):FormattedPoint{const parent=element.parentNode;if(!parent)return {node:element,offset:0};return {node:parent,offset:[...parent.childNodes].indexOf(element)+(after?1:0)};}
export function removeFormattedAnchors(root:HTMLElement):void{for(const anchor of root.querySelectorAll('[data-editor-caret-anchor]'))anchor.remove();}
const cssNumber=(value:string,fallback=0)=>Number.isFinite(parseFloat(value))?parseFloat(value):fallback;
/** An absolute line box provides a native caret without adding a flow element. */
function emptyCaretAnchor(root:HTMLElement,source:string,target:number,all:Unit[],emptyUnit?:Unit):FormattedPoint{
 const body=root.querySelector<HTMLElement>('.rich-image-body')??root,bodyBox=body.getBoundingClientRect(),bodyStyle=getComputedStyle(body),rootBox=root.getBoundingClientRect();
 const blocks=[...root.querySelectorAll<HTMLElement>('[data-md-kind],.paragraph-gap,.body-placeholder')].filter(element=>!excluded(element,root));
 const placeholder=root.querySelector<HTMLElement>('.body-placeholder'),lastLine=source.slice(source.lastIndexOf('\n',Math.max(0,target-1))+1,target),trailingLine=target>0&&source[target-1]==='\n';
 const emptyBlock=!trailingLine?blocks.filter(element=>!element.textContent?.replace(/\u200b/g,'').trim()).at(-1):undefined;
 const explicit=emptyUnit?.element??(source.length===0?placeholder:emptyBlock);
 const insetX=cssNumber(bodyStyle.getPropertyValue('--md-inset-x'),16),insetY=cssNumber(bodyStyle.getPropertyValue('--md-inset-top'),cssNumber(bodyStyle.getPropertyValue('--md-inset-y'),12));
 let font:CSSStyleDeclaration,x=bodyBox.left+insetX,y=bodyBox.top+insetY;
 if(explicit&&!explicit.classList.contains('paragraph-gap')){
  font=getComputedStyle(explicit);const box=explicit.getBoundingClientRect();x=box.left+cssNumber(font.borderLeftWidth)+cssNumber(font.paddingLeft);y=box.top+cssNumber(font.borderTopWidth)+cssNumber(font.paddingTop);
 }else{
  // Read the real theme's normal paragraph typography, including custom p rules.
  // The probe stays outside the text flow and is removed before returning.
  const probe=root.ownerDocument.createElement('p');probe.className='rich-text-paragraph rich-text-inset';probe.dataset.mdKind='p';probe.style.cssText='position:absolute;visibility:hidden;pointer-events:none';body.append(probe);font=getComputedStyle(probe);
  const values={fontFamily:font.fontFamily,fontSize:font.fontSize,fontWeight:font.fontWeight,fontStyle:font.fontStyle,letterSpacing:font.letterSpacing,lineHeight:font.lineHeight,marginTop:font.marginTop,borderTopWidth:font.borderTopWidth,paddingTop:font.paddingTop};probe.remove();
  font=values as CSSStyleDeclaration;
  if(explicit)y=explicit.getBoundingClientRect().top;
  else if(trailingLine||source.slice(0,target).includes('\n')&&lastLine.length){
   const previous=all.filter(unit=>!unit.atomic&&unit.end<=target&&unit.element.textContent?.replace(/\u200b/g,'').length).at(-1),block=previous?.element.closest<HTMLElement>('[data-md-kind]')??previous?.element;
   if(block){const box=block.getBoundingClientRect(),style=getComputedStyle(block),lineHeight=cssNumber(font.lineHeight,cssNumber(font.fontSize,13)*1.6),lines=(source.slice(previous!.end,target).match(/\n/g)??[]).length;y=box.bottom+Math.max(cssNumber(style.marginBottom),cssNumber(font.marginTop))+cssNumber(font.borderTopWidth)+cssNumber(font.paddingTop)+Math.max(0,lines-1)*lineHeight;}
  }
 }
 const height=cssNumber(font.lineHeight,cssNumber(font.fontSize,cssNumber(bodyStyle.fontSize,13))*1.6);
 let anchor=root.querySelector<HTMLElement>('[data-editor-caret-anchor]');if(!anchor){anchor=root.ownerDocument.createElement('span');anchor.dataset.editorCaretAnchor='true';anchor.textContent='\u200b';root.append(anchor);}
 anchor.style.cssText='position:absolute;display:block;width:0;overflow:visible;pointer-events:none;white-space:pre';anchor.style.left=`${x-rootBox.left-root.clientLeft+root.scrollLeft}px`;anchor.style.top=`${y-rootBox.top-root.clientTop+root.scrollTop}px`;anchor.style.height=`${height}px`;anchor.style.lineHeight=`${height}px`;
 for(const key of ['fontFamily','fontSize','fontWeight','fontStyle','letterSpacing'] as const)anchor.style[key]=font[key];
 anchor.dataset.sourceStart=String(target);anchor.dataset.sourceEnd=String(target);return {node:anchor.firstChild!,offset:0};
}
export function formattedPointAtOffset(root:HTMLElement,source:string,offset:number,bias=1):FormattedPoint{
 const target=Math.max(0,Math.min(source.length,offset)),all=units(root).filter(unit=>!unit.element.hasAttribute('data-editor-caret-anchor'));let closest:Unit|undefined,index=0,distance=Infinity;
 for(const unit of all){
  if(unit.atomic){if(target>=unit.start&&target<=unit.end)return childBoundary(unit.element,target===unit.end || target>unit.start&&bias>0);continue;}
  for(let i=0;i<unit.offsets.length;i++){const d=Math.abs(unit.offsets[i]!-target);if(d<distance || d===distance&&bias>0){distance=d;closest=unit;index=i;}if(!d)return unit.element.textContent?.length?textPoint(unit.element,i):emptyCaretAnchor(root,source,target,all,unit);}
 }
 // A source prefix can have no glyphs yet (for example '# ' or '- [ ] ').
 if(!closest || target>Math.max(0,...all.map(unit=>unit.end)) && /\n(?:\s|[#>*+\-\d.[\]xX])*$/u.test(source.slice(0,target)) || !all.length){
  return emptyCaretAnchor(root,source,target,all);
 }
 return textPoint(closest.element,index);
}
export function formattedOffsetAtPoint(root:HTMLElement,node:Node,offset:number,bias=1):number|null{
 const element=node.nodeType===1?node as Element:node.parentElement;if(!element||!root.contains(element)||excluded(element,root))return null;
 const fragment=element.closest<HTMLElement>('[data-source-start]');
 if(fragment&&root.contains(fragment)){const unit=units(root).find(unit=>unit.element===fragment);if(unit){let index=0;try{const range=root.ownerDocument.createRange();range.setStart(fragment,0);range.setEnd(node,offset);index=range.toString().length;}catch{return unit.start;}return unit.offsets[Math.max(0,Math.min(index,unit.offsets.length-1))]??unit.start;}}
 if(node.nodeType===1){const children=node.childNodes,adjacent=bias>0?children[offset]??children[offset-1]:children[offset-1]??children[offset];if(adjacent){const all=units(root).filter(unit=>adjacent===unit.element||adjacent.contains(unit.element));const unit=bias>0?all[0]:all.at(-1);if(unit)return bias>0?unit.start:unit.end;}}
 return null;
}
export function formattedSnapshot(root:HTMLElement):FormattedSnapshot{const selection=root.ownerDocument.getSelection();return {anchorNode:selection?.anchorNode??null,anchorOffset:selection?.anchorOffset??0,focusNode:selection?.focusNode??null,focusOffset:selection?.focusOffset??0};}
export const sameFormattedSnapshot=(a:FormattedSnapshot,b:FormattedSnapshot)=>a.anchorNode===b.anchorNode&&a.anchorOffset===b.anchorOffset&&a.focusNode===b.focusNode&&a.focusOffset===b.focusOffset;
export function formattedDOMRange(root:HTMLElement,fallback:FormattedRange):FormattedRange{
 const selection=root.ownerDocument.getSelection();if(!selection?.rangeCount||!selection.anchorNode||!selection.focusNode||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return {...fallback,inside:false};
 const dom=selection.getRangeAt(0),start=formattedOffsetAtPoint(root,dom.startContainer,dom.startOffset,1),end=formattedOffsetAtPoint(root,dom.endContainer,dom.endOffset,-1);if(start===null||end===null)return {...fallback,inside:false};
 return {start:Math.min(start,end),end:Math.max(start,end),backward:!selection.isCollapsed&&dom.startContainer===selection.focusNode&&dom.startOffset===selection.focusOffset,inside:true};
}
export function setFormattedDOMRange(root:HTMLElement,source:string,range:FormattedRange):FormattedSnapshot{
 const first=formattedPointAtOffset(root,source,range.start,1),last=range.start===range.end?first:formattedPointAtOffset(root,source,range.end,-1),selection=root.ownerDocument.getSelection();if(selection?.setBaseAndExtent){if(range.backward)selection.setBaseAndExtent(last.node,last.offset,first.node,first.offset);else selection.setBaseAndExtent(first.node,first.offset,last.node,last.offset);}else if(selection){const dom=root.ownerDocument.createRange();dom.setStart(first.node,first.offset);dom.setEnd(last.node,last.offset);selection.removeAllRanges();selection.addRange(dom);}return formattedSnapshot(root);
}
export function formattedCaretRect(root:HTMLElement,source:string,offset:number):DOMRect|null{
 const point=formattedPointAtOffset(root,source,offset),range=root.ownerDocument.createRange();try{range.setStart(point.node,point.offset);range.collapse(true);const rect=range.getBoundingClientRect?.();if(rect&&rect.height>0)return rect;const element=point.node.nodeType===1?point.node as Element:point.node.parentElement!,box=element.getBoundingClientRect(),Rect=root.ownerDocument.defaultView!.DOMRect;return new Rect(box.left,box.top,0,box.height||20.8);}catch{return null;}
}
export function replaceFormattedSource(source:string,range:FormattedRange,inserted:string):{value:string;range:FormattedRange}{
 let {start,end}=range;for(const object of parseBodyObjects(source))if(start<object.end&&end>object.start || start===end&&start>object.start&&start<object.end){start=Math.min(start,object.start);end=Math.max(end,object.end);}
 if(!inserted&&start<end){
  const wrappers=['***','**','~~','*','^','_','`'];let changed=true;
  while(changed){changed=false;for(const delimiter of wrappers){const from=start-delimiter.length;if(from<0||source.slice(from,start)!==delimiter||source.slice(end,end+delimiter.length)!==delimiter)continue;let escapes=0;for(let i=from-1;i>=0&&source[i]==='\\';i--)escapes++;if(escapes%2)continue;start=from;end+=delimiter.length;changed=true;break;}}
 }
 const value=source.slice(0,start)+inserted+source.slice(end),offset=start+inserted.length;return {value,range:{start:offset,end:offset,backward:false,inside:true}};
}
/** Delete visible graphemes/objects while leaving hidden Markdown delimiters intact. */
export function deleteFormattedSource(root:HTMLElement,source:string,range:FormattedRange,backward:boolean):{value:string;range:FormattedRange}{
 if(range.start!==range.end)return replaceFormattedSource(source,range,'');
 const at=range.start,spans:{start:number;end:number}[]=[];
 if(backward&&source[at-1]==='\n'){const start=source[at-2]==='\r'?at-2:at-1;return replaceFormattedSource(source,{...range,start},'');}
 if(!backward&&(source[at]==='\n'||source[at]==='\r'&&source[at+1]==='\n'))return replaceFormattedSource(source,{...range,end:at+(source[at]==='\r'?2:1)},'');
 for(const unit of units(root)){
  if(unit.atomic){spans.push({start:unit.start,end:unit.end});continue;}
  if(unit.element.hasAttribute('data-editor-caret-anchor'))continue;
  const text=unit.element.textContent??'';
  for(const part of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)){const start=unit.offsets[part.index],end=unit.offsets[part.index+part.segment.length];if(start!==undefined&&end!==undefined&&end>start)spans.push({start,end});}
 }
 const chosen=backward?spans.filter(span=>span.end<=at).sort((a,b)=>b.end-a.end)[0]:spans.filter(span=>span.start>=at).sort((a,b)=>a.start-b.start)[0];
 if(!chosen)return {value:source,range};
 const result=replaceFormattedSource(source,{...range,...chosen},'');
 // Keep the caret on the same side of a closing marker after a partial deletion.
 if(result.value!==source){let prefix=0;while(prefix<source.length&&prefix<result.value.length&&source[prefix]===result.value[prefix])prefix++;let oldEnd=source.length,newEnd=result.value.length;while(oldEnd>prefix&&newEnd>prefix&&source[oldEnd-1]===result.value[newEnd-1]){oldEnd--;newEnd--;}const offset=at>=oldEnd?at+newEnd-oldEnd:Math.min(at,prefix);result.range={start:offset,end:offset,backward:false,inside:true};}
 return result;
}
export function formatSourceMark(source:string,range:FormattedRange,mark:string):{value:string;range:FormattedRange}{
 let state=EditorState.create({doc:parseRichBody(source)});const from=sourceToVisualPosition(state.doc,range.start),to=sourceToVisualPosition(state.doc,range.end,1);state=state.apply(state.tr.setSelection(TextSelection.between(state.doc.resolve(from),state.doc.resolve(to))));
 toggleMark(richBodySchema.marks[mark]!,undefined,{removeWhenPresent:false})(state,tr=>{state=state.apply(tr);});
 return {value:serializeRichBody(state.doc),range:{...range,start:visualPositionToSource(state.doc,state.selection.from,1),end:visualPositionToSource(state.doc,state.selection.to,-1)}};
}
export function selectedFormattedSource(source:string,range:FormattedRange):string{
 const doc=parseRichBody(source),selection=TextSelection.between(doc.resolve(sourceToVisualPosition(doc,range.start)),doc.resolve(sourceToVisualPosition(doc,range.end,1))),slice=selection.content(),content=slice.content.firstChild?.isInline?Fragment.from(richBodySchema.nodes.paragraph!.create(null,slice.content)):slice.content;return richBodySerializer.serialize(richBodySchema.topNodeType.create(null,content));
}
