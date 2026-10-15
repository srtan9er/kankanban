import {nameInsertedTables} from '../core/table-markdown.ts';
import {forwardRef,useImperativeHandle,useLayoutEffect,useRef,type ClipboardEvent,type DragEvent,type FocusEventHandler,type KeyboardEventHandler,type PointerEventHandler,type ClipboardEventHandler,type DragEventHandler} from 'react';
import {getMarkdownEditorAtoms,getMarkdownEditorRange,getMarkdownEditorSelection,mapMarkdownEditorOffset,markdownEditorNeedsRender,normalizeMarkdownEditorSelection,readMarkdownEditor,renderMarkdownEditor,setMarkdownEditorSelection,type MarkdownEditorRange} from './markdown-editor-model.ts';
import './markdown-editor.css';
import {nameInsertedImages} from '../core/image-identity.ts';
export {getMarkdownEditorSelection,readMarkdownEditor} from './markdown-editor-model.ts';
export type MarkdownEditorProps={value:string;onChange:(value:string)=>void;onBlur?:FocusEventHandler<HTMLDivElement>|undefined;onPointerDown?:PointerEventHandler<HTMLDivElement>|undefined;onKeyDown?:KeyboardEventHandler<HTMLDivElement>|undefined;onPaste?:ClipboardEventHandler<HTMLDivElement>|undefined;onDrop?:DragEventHandler<HTMLDivElement>|undefined;disabled?:boolean|undefined;placeholder?:string|undefined;'aria-label'?:string|undefined;className?:string|undefined;autoFocus?:boolean|undefined};
type HistoryEntry={value:string;selection:MarkdownEditorRange};
const initialRange:MarkdownEditorRange={start:0,end:0,backward:false,inside:false};
export const MarkdownEditor=forwardRef<HTMLDivElement,MarkdownEditorProps>(function MarkdownEditor({value,onChange,onBlur,onPointerDown,onKeyDown,onPaste,onDrop,disabled=false,placeholder,className,autoFocus,...aria},ref){
 const host=useRef<HTMLDivElement>(null),composing=useRef(false);
 const history=useRef<{entries:HistoryEntry[];index:number}>({entries:[{value,selection:{...initialRange}}],index:0}),beforeRecorded=useRef(false),emitted=useRef<string|null>(null),nativeHistory=useRef<(redo:boolean)=>void>(()=>undefined);
 useImperativeHandle(ref,()=>host.current!,[]);
 useLayoutEffect(()=>{
  const element=host.current;if(!element || composing.current)return;
  const selection=getMarkdownEditorRange(element),before=readMarkdownEditor(element),local=value===emitted.current || value===history.current.entries[history.current.index]!.value;
  const mapped={...selection,start:mapMarkdownEditorOffset(before,value,selection.start),end:mapMarkdownEditorOffset(before,value,selection.end)};
  if(markdownEditorNeedsRender(element,value)){renderMarkdownEditor(element,value);if(selection.inside)setMarkdownEditorSelection(element,mapped.start,mapped.end,mapped.backward);}
  if(!local){history.current={entries:[{value,selection:mapped}],index:0};beforeRecorded.current=false;emitted.current=null;}
 },[value]);
 useLayoutEffect(()=>{const element=host.current;if(!element)return;if(autoFocus){element.focus();setMarkdownEditorSelection(element,value.length);}const normalize=()=>normalizeMarkdownEditorSelection(element);document.addEventListener('selectionchange',normalize);return()=>document.removeEventListener('selectionchange',normalize);},[]);
 const captureBefore=(source:string,selection:MarkdownEditorRange)=>{
  const current=history.current.entries[history.current.index]!;
  if(current.value===source)current.selection={...selection};beforeRecorded.current=true;
 };
 const record=(next:string,selection:MarkdownEditorRange)=>{
  const state=history.current,current=state.entries[state.index]!;
  if(next!==current.value){
   if(!beforeRecorded.current)current.selection={...selection,start:mapMarkdownEditorOffset(next,current.value,selection.start),end:mapMarkdownEditorOffset(next,current.value,selection.end)};
   state.entries=state.entries.slice(0,state.index+1);state.entries.push({value:next,selection:{...selection}});state.index=state.entries.length-1;
   while(state.entries.length>51 || (state.entries.length>2 && state.entries.reduce((size,entry)=>size+entry.value.length*2,0)>8*1024*1024)){state.entries.shift();state.index--;}
  }else current.selection={...selection};beforeRecorded.current=false;
 };
 const emit=(next:string)=>{emitted.current=next;onChange(next);};
 const restore=(redo:boolean)=>{
  const element=host.current;if(!element || disabled || composing.current)return;const state=history.current,index=state.index+(redo?1:-1);if(index<0 || index>=state.entries.length)return;
  state.entries[state.index]!.selection=getMarkdownEditorRange(element);state.index=index;const entry=state.entries[index]!;renderMarkdownEditor(element,entry.value);setMarkdownEditorSelection(element,entry.selection.start,entry.selection.end,entry.selection.backward);beforeRecorded.current=false;emit(entry.value);
 };
 nativeHistory.current=restore;
 useLayoutEffect(()=>{
  const element=host.current;if(!element)return;
  const before=(event:InputEvent)=>{if(disabled)return;if(event.inputType==='historyUndo' || event.inputType==='historyRedo'){event.preventDefault();event.stopPropagation();nativeHistory.current(event.inputType==='historyRedo');return;}if(!composing.current)captureBefore(readMarkdownEditor(element),getMarkdownEditorRange(element));};
  element.addEventListener('beforeinput',before);return()=>element.removeEventListener('beforeinput',before);
 },[disabled]);
 const publish=()=>{
  if(disabled)return;
  const element=host.current!;const next=readMarkdownEditor(element),selection=getMarkdownEditorRange(element);
  if(!composing.current && markdownEditorNeedsRender(element,next)){renderMarkdownEditor(element,next);if(selection.inside)setMarkdownEditorSelection(element,selection.start,selection.end,selection.backward);}
  if(!composing.current)record(next,selection);element.dataset.empty=next.length===0?'true':'false';emit(next);
 };
 const replaceSelection=(replacement:string,previousSelection?:MarkdownEditorRange)=>{
  const element=host.current!,source=readMarkdownEditor(element),selection=getMarkdownEditorRange(element);
  const surrounding=source.slice(0,selection.start)+source.slice(selection.end);
  if(replacement.includes('<image'))replacement=nameInsertedImages(replacement,surrounding);
  if(replacement.includes('<table') || replacement.includes('|'))replacement=nameInsertedTables(replacement,surrounding);
  const next=source.slice(0,selection.start)+replacement+source.slice(selection.end);
  captureBefore(source,previousSelection ?? selection);renderMarkdownEditor(element,next);setMarkdownEditorSelection(element,selection.start+replacement.length);record(next,getMarkdownEditorRange(element));element.dataset.empty=next.length===0?'true':'false';emit(next);
 };
 const paste=(event:ClipboardEvent<HTMLDivElement>)=>{if(disabled){event.preventDefault();return;}onPaste?.(event);if(event.defaultPrevented)return;event.preventDefault();replaceSelection(event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n'));};
 const drop=(event:DragEvent<HTMLDivElement>)=>{if(disabled){event.preventDefault();return;}onDrop?.(event);if(event.defaultPrevented)return;event.preventDefault();if(!event.dataTransfer.files.length)replaceSelection(event.dataTransfer.getData('text/plain').replace(/\r\n?/g,'\n'));};
 const copy=(event:ClipboardEvent<HTMLDivElement>,cut=false)=>{
  const element=host.current!,range=getMarkdownEditorRange(element);if(!range.inside || range.start===range.end)return;
  event.preventDefault();event.clipboardData.setData('text/plain',readMarkdownEditor(element).slice(range.start,range.end));if(cut && !disabled)replaceSelection('');
 };
 return <div {...aria} ref={host} className={`markdown-editor ${className ?? ''}`} data-markdown-editor="true" data-empty={value.length===0} data-placeholder={placeholder} role="textbox" aria-multiline="true" aria-disabled={disabled} contentEditable={!disabled} suppressContentEditableWarning spellCheck tabIndex={disabled?-1:0} onBlur={onBlur} onPointerDown={event=>{
  onPointerDown?.(event);if(disabled || event.defaultPrevented)return;const element=event.target as Element,atom=element.closest<HTMLElement>('[data-markdown-token]');if(!atom || !host.current?.contains(atom))return;
  event.preventDefault();host.current.focus();const range=document.createRange();range.selectNode(atom);const selection=document.getSelection();selection?.removeAllRanges();selection?.addRange(range);
 }} onInput={publish} onCompositionStart={()=>{if(host.current)captureBefore(readMarkdownEditor(host.current),getMarkdownEditorRange(host.current));composing.current=true;}} onCompositionEnd={()=>{composing.current=false;publish();}} onKeyDown={event=>{
  onKeyDown?.(event);if(event.defaultPrevented || composing.current || event.nativeEvent.isComposing)return;
  if((event.ctrlKey || event.metaKey) && ['z','y'].includes(event.key.toLowerCase())){event.preventDefault();event.stopPropagation();if(!disabled)restore(event.key.toLowerCase()==='y' || event.shiftKey);return;}
  if(disabled)return;
  if(event.key==='Enter' && !event.ctrlKey && !event.metaKey){event.preventDefault();replaceSelection('\n');return;}
  if((event.ctrlKey || event.metaKey) && ['b','i','u'].includes(event.key.toLowerCase())){event.preventDefault();return;}
  if(event.key!=='Backspace' && event.key!=='Delete')return;
  const element=host.current!,range=getMarkdownEditorRange(element),atoms=getMarkdownEditorAtoms(element);if(!range.inside)return;
  if(range.start!==range.end && atoms.some(atom=>document.getSelection()?.getRangeAt(0).intersectsNode(atom.node))){event.preventDefault();replaceSelection('');return;}
  if(range.start!==range.end)return;
  for(const bounds of atoms){if((event.key==='Backspace' && bounds.end===range.start) || (event.key==='Delete' && bounds.start===range.start)){event.preventDefault();setMarkdownEditorSelection(element,bounds.start,bounds.end);replaceSelection('',range);return;}
  }
 }} onPaste={paste} onDrop={drop} onCopy={event=>copy(event)} onCut={event=>copy(event,true)}/>;
});
