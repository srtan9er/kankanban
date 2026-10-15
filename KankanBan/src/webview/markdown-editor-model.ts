import {parseBodyObjects} from '../core/body-objects.ts';
import {uiText} from '../i18n/text.ts';
export type MarkdownEditorPart={text:string;atomic:false}|{text:string;atomic:true;index:number;name:string};
export function markdownEditorParts(value:string):MarkdownEditorPart[]{
 const parts:MarkdownEditorPart[]=[];let start=0;
 const references=parseBodyObjects(value),names=references.map(r=>r.displayName);
 references.forEach((token,index)=>{if(token.syntax!=='image')return;parts.push({text:value.slice(start,token.start),atomic:false},{text:value.slice(token.start,token.end),atomic:true,index,name:names[index]!});start=token.end;});
 parts.push({text:value.slice(start),atomic:false});return parts;
}
type Segment={node:Node;text:string;start:number;end:number;atomic:boolean};
type Bounds={start:number;end:number;children:number[]};
type EditorModel={text:string;segments:Segment[];bounds:Map<Node,Bounds>};
const block=(node:Node)=>node instanceof HTMLElement && ['DIV','P','LI','PRE'].includes(node.tagName);
const token=(node:Node|null,root:HTMLElement):HTMLElement|null=>{
 const element=node instanceof Element?node:node?.parentElement;
 const result=element?.closest<HTMLElement>('[data-markdown-token]');return result && root.contains(result)?result:null;
};
function editorModel(root:HTMLElement):EditorModel{
 const segments:Segment[]=[],bounds=new Map<Node,Bounds>();let text='';
 const append=(node:Node,value:string,atomic=false)=>{const start=text.length;text+=value;segments.push({node,text:value,start,end:text.length,atomic});};
 const walk=(node:Node)=>{
  const start=text.length,children:number[]=[];
  if(node.nodeType===3)append(node,node.textContent ?? '');
  else if(node instanceof HTMLElement && node.hasAttribute('data-markdown-token'))append(node,node.getAttribute('data-markdown-token') ?? '',true);
  else if(node instanceof HTMLElement && node.tagName==='BR')append(node,'\n');
  else for(let index=0;index<node.childNodes.length;index++){
   const child=node.childNodes[index]!;
   if(block(child) && text.length>start && !text.endsWith('\n'))append(child,'\n');
   children[index]=text.length;walk(child);
   if(block(child) && index<node.childNodes.length-1 && !block(node.childNodes[index+1]!) && !text.endsWith('\n'))append(child,'\n');
   children[index+1]=text.length;
  }
  bounds.set(node,{start,end:text.length,children});
 };
 walk(root);return {text,segments,bounds};
}
export function readMarkdownEditor(root:HTMLElement):string{return editorModel(root).text;}
export function getMarkdownEditorAtoms(root:HTMLElement):{node:Node;start:number;end:number}[]{return editorModel(root).segments.filter(segment=>segment.atomic).map(({node,start,end})=>({node,start,end}));}
export function renderMarkdownEditor(root:HTMLElement,value:string):void{
 const fragment=root.ownerDocument.createDocumentFragment();
 for(const part of markdownEditorParts(value)){
  if(!part.atomic){fragment.append(root.ownerDocument.createTextNode(part.text));continue;}
  const atom=root.ownerDocument.createElement('span');atom.className='markdown-image-token';atom.contentEditable='false';atom.setAttribute('contenteditable','false');atom.setAttribute('data-markdown-token',part.text);atom.textContent=uiText('images.editorToken',{arg0:part.name});fragment.append(atom);
 }
 root.replaceChildren(fragment);
 root.dataset.empty=value.length===0?'true':'false';
}
function sourceOffset(model:EditorModel,root:HTMLElement,node:Node|null,offset:number):number{
 if(!node)return model.text.length;
 const atom=token(node,root);if(atom){const range=model.bounds.get(atom)!;return offset===0?range.start:range.end;}
 const range=model.bounds.get(node);if(!range)return model.text.length;
 if(node.nodeType===3)return range.start+Math.max(0,Math.min(offset,range.end-range.start));
 return range.children[offset] ?? (offset===0?range.start:range.end);
}
export type MarkdownEditorRange={start:number;end:number;backward:boolean;inside:boolean};
export function getMarkdownEditorRange(root:HTMLElement):MarkdownEditorRange{
 const model=editorModel(root),selection=root.ownerDocument.getSelection();
 if(!selection?.rangeCount || !selection.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode))return {start:model.text.length,end:model.text.length,backward:false,inside:false};
 const range=selection.getRangeAt(0),anchor=sourceOffset(model,root,selection.anchorNode,selection.anchorOffset),focus=sourceOffset(model,root,selection.focusNode,selection.focusOffset);
 let start=Math.min(anchor,focus),end=Math.max(anchor,focus);
 if(!selection.isCollapsed)for(const segment of model.segments)if(segment.atomic && range.intersectsNode(segment.node)){start=Math.min(start,segment.start);end=Math.max(end,segment.end);}
 return {start,end,backward:!selection.isCollapsed && range.startContainer===selection.focusNode && range.startOffset===selection.focusOffset,inside:true};
}
/** Clipboard image insertion uses source coordinates, not the short numbered label. */
export function getMarkdownEditorSelection(root:HTMLElement):{beforeContent:string;offset:number}{return {beforeContent:readMarkdownEditor(root),offset:getMarkdownEditorRange(root).start};}
/** Keep selections attached to unchanged source after an external edit, including hidden attributes. */
export function mapMarkdownEditorOffset(before:string,after:string,offset:number):number{
 let prefix=0;while(prefix<before.length && prefix<after.length && before[prefix]===after[prefix])prefix++;
 let oldEnd=before.length,newEnd=after.length;while(oldEnd>prefix && newEnd>prefix && before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}
 if(offset<=prefix)return offset;if(offset>=oldEnd)return Math.max(0,Math.min(after.length,offset+newEnd-oldEnd));return prefix+Math.min(offset-prefix,newEnd-prefix);
}
function point(root:HTMLElement,model:EditorModel,offset:number):{node:Node;offset:number}{
 const target=Math.max(0,Math.min(offset,model.text.length));
 for(const segment of model.segments){
  if(target<segment.start || target>segment.end)continue;
  if(segment.node.nodeType===3)return {node:segment.node,offset:target-segment.start};
  const parent=segment.node.parentNode;if(!parent)continue;const index=[...parent.childNodes].indexOf(segment.node as ChildNode);
  return {node:parent,offset:index+(target>=segment.end?1:0)};
 }
 return {node:root,offset:root.childNodes.length};
}
export function setMarkdownEditorSelection(root:HTMLElement,start:number,end=start,backward=false):void{
 const model=editorModel(root),first=point(root,model,start),last=point(root,model,end),selection=root.ownerDocument.getSelection();if(!selection)return;
 if(selection.setBaseAndExtent){if(backward)selection.setBaseAndExtent(last.node,last.offset,first.node,first.offset);else selection.setBaseAndExtent(first.node,first.offset,last.node,last.offset);}
 else{const range=root.ownerDocument.createRange();range.setStart(first.node,first.offset);range.setEnd(last.node,last.offset);selection.removeAllRanges();selection.addRange(range);}
}
/** Selection endpoints may surround an atomic field, never fall inside its label. */
export function normalizeMarkdownEditorSelection(root:HTMLElement):boolean{
 const selection=root.ownerDocument.getSelection();if(!selection?.rangeCount || !selection.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode))return false;
 const original=selection.getRangeAt(0),first=token(original.startContainer,root),last=token(original.endContainer,root);if(!first && !last)return false;
 const backward=!selection.isCollapsed && original.startContainer===selection.focusNode && original.startOffset===selection.focusOffset,range=original.cloneRange();
 if(first)range.setStartBefore(first);if(last)range.setEndAfter(last);
 if(selection.setBaseAndExtent){if(backward)selection.setBaseAndExtent(range.endContainer,range.endOffset,range.startContainer,range.startOffset);else selection.setBaseAndExtent(range.startContainer,range.startOffset,range.endContainer,range.endOffset);}
 else{selection.removeAllRanges();selection.addRange(range);}return true;
}
export function markdownEditorNeedsRender(root:HTMLElement,value:string):boolean{
 const current=editorModel(root);if(current.text!==value)return true;
 const actual=current.segments.filter(segment=>segment.atomic),references=parseBodyObjects(value),names=references.map(r=>r.displayName),wanted=references.map((token,index)=>({...token,name:names[index]!})).filter(token=>token.syntax==='image');
 return actual.length!==wanted.length || actual.some((segment,index)=>segment.start!==wanted[index]!.start || segment.end!==wanted[index]!.end || segment.text!==value.slice(wanted[index]!.start,wanted[index]!.end) || segment.node.textContent!==uiText('images.editorToken',{arg0:wanted[index]!.name}));
}
