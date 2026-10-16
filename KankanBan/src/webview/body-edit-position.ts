import {getMarkdownEditorAtoms,markdownEditorPointAtOffset,markdownEditorOffsetAtPoint,readMarkdownEditor} from './markdown-editor-model.ts';
/** A body position is a source character plus a visible anchor, never a shared scrollTop. */
export type BodyEditPoint={clientX:number;clientY:number;target?:Element};
export type BodyCaretRect={left:number;top:number;height:number;width?:number};
export type BodyCaret={offset:number;rect:BodyCaretRect};
export type BodyEditPosition={offset:number;viewportX:number;viewportY:number};
type CaretDocument=Document & {caretPositionFromPoint?:(x:number,y:number)=>{offsetNode:Node;offset:number}|null;caretRangeFromPoint?:(x:number,y:number)=>Range|null};
type Fragment={element:HTMLElement;offsets:number[]};
const excluded='button,a,input,textarea,select,[contenteditable],.image-placement,.body-images,.editable-table,[data-drawing-surface],[data-card-id]';
const finite=(value:number)=>Number.isFinite(value);

function fragments(root:HTMLElement):Fragment[]{
 const elements=[...(root.hasAttribute('data-source-start')?[root]:[]),...root.querySelectorAll<HTMLElement>('[data-source-start]')];
 return elements.flatMap(element=>{
  const object=element.closest('.image-placement,.editable-table');if(object && root.contains(object))return [];
  const start=Number(element.dataset.sourceStart);if(!Number.isSafeInteger(start) || start<0)return [];
  if(element.dataset.sourceMap)try{const offsets:unknown=JSON.parse(element.dataset.sourceMap);if(Array.isArray(offsets) && offsets.length===(element.textContent?.length ?? 0)+1 && offsets.every(value=>Number.isSafeInteger(value) && value>=0))return [{element,offsets:offsets as number[]}];}catch{/* Older fragments can still use their source start. */}
  return [{element,offsets:Array.from({length:(element.textContent?.length ?? 0)+1},(_,index)=>start+index)}];
 });
}
function visibleIndex(element:HTMLElement,node:Node,offset:number):number{
 try{const range=element.ownerDocument.createRange();range.setStart(element,0);range.setEnd(node,offset);return range.toString().length;}catch{return 0;}
}
function textPoint(element:HTMLElement,index:number):{node:Node;offset:number}|null{
 const walker=element.ownerDocument.createTreeWalker(element,4);let remaining=Math.max(0,index),node:Node|null;
 while((node=walker.nextNode())){const length=node.textContent?.length ?? 0;if(remaining<=length)return {node,offset:remaining};remaining-=length;}
 return null;
}
function rectAt(element:HTMLElement,index:number):BodyCaretRect{
 const point=textPoint(element,index),range=element.ownerDocument.createRange();
 if(point){
  range.setStart(point.node,point.offset);range.collapse(true);
  const collapsed=range.getBoundingClientRect?.();if(collapsed && collapsed.height>0)return collapsed;
  // Some engines return no collapsed box at a line end; use the adjacent character.
  const length=point.node.textContent?.length ?? 0;
  if(length){const after=point.offset<length;range.setStart(point.node,after?point.offset:point.offset-1);range.setEnd(point.node,after?point.offset+1:point.offset);const rect=range.getBoundingClientRect?.();if(rect && rect.height>0)return {left:after?rect.left:rect.right,top:rect.top,width:0,height:rect.height};}
 }
 const box=element.getBoundingClientRect(),length=element.textContent?.length ?? 0,lineHeight=parseFloat(element.ownerDocument.defaultView?.getComputedStyle(element).lineHeight ?? '');
 return {left:box.left+(length?box.width*Math.min(index,length)/length:0),top:box.top,width:0,height:box.height || lineHeight || 20.8};
}
function closestIndex(offsets:number[],offset:number):number{
 let low=0,high=offsets.length-1;while(low<high){const mid=Math.floor((low+high)/2);if(offsets[mid]!<offset)low=mid+1;else high=mid;}
 const previous=Math.max(0,low-1);return Math.abs(offsets[previous]!-offset)<=Math.abs(offsets[low]!-offset)?previous:low;
}
/** Unlike image-drop targets, editing may place the caret inside links, code and formatting. */
export function bodyPreviewCaretFromPoint(root:HTMLElement,source:string,point:BodyEditPoint):BodyCaret|null{
 if(point.target && (!root.contains(point.target) || point.target.closest(excluded)))return null;
 const doc=root.ownerDocument as CaretDocument,caret=doc.caretPositionFromPoint?.(point.clientX,point.clientY),range=caret?null:doc.caretRangeFromPoint?.(point.clientX,point.clientY);
 const node=caret?.offsetNode ?? range?.startContainer,offset=caret?.offset ?? range?.startOffset ?? 0,parent=node?.nodeType===1?node as Element:node?.parentElement;
 const all=fragments(root);let selected:Fragment|undefined,index=0;
 const element=parent?.closest<HTMLElement>('[data-source-start]');
 if(element && root.contains(element)){
  selected=all.find(fragment=>fragment.element===element);if(selected)index=visibleIndex(element,node!,offset);
 }
 if(!selected){
  let distance=Infinity;
  for(const fragment of all){const box=fragment.element.getBoundingClientRect(),dx=Math.max(box.left-point.clientX,0,point.clientX-box.right),dy=Math.max(box.top-point.clientY,0,point.clientY-box.bottom),next=dy*dy*4+dx*dx;if(next<distance){distance=next;selected=fragment;}}
  if(selected){
   const value=selected.element.textContent ?? '',box=selected.element.getBoundingClientRect();
   // Browser caret APIs are preferred. This fallback also works for empty lines and padding.
   index=box.width?Math.round((point.clientX-box.left)/box.width*value.length):point.clientX<=box.left?0:value.length;
   index=Math.max(0,Math.min(value.length,index));
  }
 }
 if(!selected)return null;
 index=Math.max(0,Math.min(index,selected.offsets.length-1));
 return {offset:Math.max(0,Math.min(source.length,selected.offsets[index]!)),rect:rectAt(selected.element,index)};
}
/** Resolve a source offset back to a visible preview fragment after rendering has changed. */
export function bodyPreviewCaretAtOffset(root:HTMLElement,offset:number):BodyCaret|null{
 let selected:Fragment|undefined,index=0,distance=Infinity;const target=Math.max(0,finite(offset)?Math.floor(offset):0);
 let object:BodyCaret|null=null,objectDistance=Infinity;
 for(const frame of root.querySelectorAll<HTMLElement>('.image-placement[data-source-image-start][data-source-image-end]')){
  // A table cell can contain another rendered body with its own local offsets.
  const outer=frame.parentElement?.closest('.image-placement');if(outer && root.contains(outer))continue;
  const start=Number(frame.dataset.sourceImageStart),end=Number(frame.dataset.sourceImageEnd);if(!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || end<start)continue;
  const after=Math.abs(end-target)<Math.abs(start-target),at=after?end:start,next=Math.abs(at-target);if(next>=objectDistance)continue;
  const rect=frame.getBoundingClientRect();object={offset:at,rect:{left:after?rect.right:rect.left,top:rect.top,width:0,height:rect.height || 20.8}};objectDistance=next;
  if(!next)return object;
 }
 for(const fragment of fragments(root)){const at=closestIndex(fragment.offsets,target),next=Math.abs(fragment.offsets[at]!-target);if(next<distance){selected=fragment;index=at;distance=next;if(!next)break;}}
 if(object && objectDistance<distance)return object;
 return selected?{offset:selected.offsets[index]!,rect:rectAt(selected.element,index)}:null;
}
function viewportBox(viewport:HTMLElement){const box=viewport.getBoundingClientRect();return {left:box.left+viewport.clientLeft,top:box.top+viewport.clientTop,width:viewport.clientWidth || box.width,height:viewport.clientHeight || box.height};}
/** Editors supply a source offset and its DOM caret rectangle through their own adapter. */
export function captureBodyEditPosition(viewport:HTMLElement,offset:number,rect:BodyCaretRect):BodyEditPosition{
 const box=viewportBox(viewport),clamp=(value:number,max:number)=>Math.max(0,Math.min(max,finite(value)?value:0));
 return {offset:Math.max(0,finite(offset)?Math.floor(offset):0),viewportX:clamp(rect.left-box.left,box.width),viewportY:clamp(rect.top-box.top,Math.max(0,box.height-rect.height))};
}
/** Preserve the current view when scrolling has moved the editing caret off screen. */
export function captureVisibleBodyEditPosition(viewport:HTMLElement,caret:BodyCaret|null,caretFromPoint:(point:BodyEditPoint)=>BodyCaret|null):BodyEditPosition|null{
 const box=viewportBox(viewport),visible=(value:BodyCaret)=>value.rect.top<box.top+box.height && value.rect.top+value.rect.height>box.top && value.rect.left>=box.left && value.rect.left<=box.left+box.width;
 if(caret && visible(caret))return captureBodyEditPosition(viewport,caret.offset,caret.rect);
 const top=box.top+Math.min(8,box.height/2);
 for(const x of [box.left+Math.min(8,box.width/2),box.left+box.width/2,box.left+Math.max(0,box.width-8)]){
  const current=caretFromPoint({clientX:x,clientY:top});if(current && visible(current))return captureBodyEditPosition(viewport,current.offset,current.rect);
 }
 return null;
}
/** Source editor atoms display short labels but retain their complete Markdown length. */
export function sourceEditorCaretRect(root:HTMLElement,offset:number):BodyCaretRect|null{
 const point=markdownEditorPointAtOffset(root,offset),range=root.ownerDocument.createRange();range.setStart(point.node,point.offset);range.collapse(true);const caret=range.getBoundingClientRect?.();if(caret && caret.height>0)return caret;
 if(point.node.nodeType===3){const parent=point.node.parentElement;if(parent)return rectAtTextPoint(parent,point.node,point.offset);}
 const element=point.node as HTMLElement,after=element.childNodes[point.offset],before=element.childNodes[point.offset-1],adjacent=after ?? before;
 if(adjacent instanceof HTMLElement){const rect=adjacent.getBoundingClientRect();return {left:after?rect.left:rect.right,top:rect.top,width:0,height:rect.height || 20.8};}
 const rect=root.getBoundingClientRect();return {left:rect.left,top:rect.top,width:0,height:parseFloat(root.ownerDocument.defaultView?.getComputedStyle(root).lineHeight ?? '') || 20.8};
}
function rectAtTextPoint(parent:HTMLElement,node:Node,offset:number):BodyCaretRect{
 const range=parent.ownerDocument.createRange(),length=node.textContent?.length ?? 0;
 if(length){const after=offset<length;range.setStart(node,after?offset:Math.max(0,offset-1));range.setEnd(node,after?offset+1:offset);const rect=range.getBoundingClientRect?.();if(rect && rect.height>0)return {left:after?rect.left:rect.right,top:rect.top,width:0,height:rect.height};}
 const rect=parent.getBoundingClientRect();return {left:rect.left+(length?rect.width*offset/length:0),top:rect.top,width:0,height:rect.height || 20.8};
}
/** Read a browser caret without temporarily disturbing the user's source selection. */
export function sourceEditorCaretFromPoint(root:HTMLElement,point:BodyEditPoint):BodyCaret|null{
 const doc=root.ownerDocument as CaretDocument,caret=doc.caretPositionFromPoint?.(point.clientX,point.clientY),range=caret?null:doc.caretRangeFromPoint?.(point.clientX,point.clientY),node=caret?.offsetNode ?? range?.startContainer,offset=caret?.offset ?? range?.startOffset ?? 0;
 if(node && root.contains(node)){
  const element=node.nodeType===1?node as Element:node.parentElement,atom=element?.closest<HTMLElement>('[data-markdown-token]');let source=markdownEditorOffsetAtPoint(root,node,offset);
  if(atom){const bounds=getMarkdownEditorAtoms(root).find(value=>value.node===atom),rect=atom.getBoundingClientRect();if(bounds)source=point.clientX<rect.left+rect.width/2?bounds.start:bounds.end;}
  const rect=sourceEditorCaretRect(root,source);return rect?{offset:source,rect}:null;
 }
 // Native caret APIs can fail on empty editors and on their padding.
 if(!readMarkdownEditor(root)){const rect=sourceEditorCaretRect(root,0);return rect?{offset:0,rect}:null;}
 return null;
}
/** Call after the destination DOM has laid out; the callback can target either editor or preview. */
export function restoreBodyEditPosition(viewport:HTMLElement,position:BodyEditPosition,rectForOffset:(offset:number)=>BodyCaretRect|null):boolean{
 const rect=rectForOffset(position.offset);if(!rect || !finite(rect.left) || !finite(rect.top))return false;
 const box=viewportBox(viewport);viewport.scrollLeft+=rect.left-box.left-position.viewportX;viewport.scrollTop+=rect.top-box.top-position.viewportY;return true;
}
