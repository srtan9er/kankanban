import {forwardRef,useContext,useEffect,useImperativeHandle,useLayoutEffect,useRef,useState,type RefObject,type PointerEvent as ReactPointerEvent} from 'react';
import type {CardImage} from '../core/types.ts';
import type {InkDocument} from '../core/drawing.ts';
import {emptyTableMarkup} from '../core/table-markdown.ts';
import type {Request} from './controller.ts';
import type {ImageImportInput} from './image-input.ts';
import {DrawingBody} from './DrawingBody.tsx';
import {MarkdownEditor,insertMarkdownEditorMarkup} from './MarkdownEditor.tsx';
import {getMarkdownEditorRange,getMarkdownEditorAtoms,readMarkdownEditor,setMarkdownEditorSelection} from './markdown-editor-model.ts';
import {VisualBodyEditor,getVisualEditorSelection,setVisualEditorSelection,visualEditorCaretRect,visualEditorCaretFromPoint,insertVisualEditorMarkup,focusVisualEditor} from './VisualBodyEditor.tsx';
import {bodyPreviewCaretFromPoint,captureBodyEditPosition,captureVisibleBodyEditPosition,restoreBodyEditPosition,sourceEditorCaretRect,sourceEditorCaretFromPoint,type BodyEditPoint,type BodyEditPosition} from './body-edit-position.ts';
import {EditMode} from './edit-mode.ts';
import {uiText} from '../i18n/text.ts';
import './card-body-editor.css';

export type CardBodyEditorHandle={captureEntry:(point?:BodyEditPoint)=>void;captureExit:()=>void;focus:()=>void};
type SourceSelection={start:number;end:number;backward:boolean};
type SourceInput={markup:string}|{key:string;ctrl:boolean;meta:boolean;shift:boolean;alt:boolean};
type Props={id:string;content:string;images:CardImage[];doodle?:InkDocument|null|undefined;editing:boolean;disabled?:boolean;editorRef:RefObject<HTMLDivElement|null>;onChange:(value:string)=>void;onBlur:()=>void;onRequestEdit:()=>void;flush:()=>Promise<unknown>;prepare:()=>Promise<unknown>;send:(request:Request)=>Promise<unknown>};

/** Input focus and presentation mode are separate: only the mode button changes the latter. */
export const CardBodyEditor=forwardRef<CardBodyEditorHandle,Props>(function CardBodyEditor({id,content,images,doodle,editing,disabled=false,editorRef,onChange,onBlur,onRequestEdit,flush,prepare,send},ref){
 const {editable,busy:modeBusy}=useContext(EditMode),viewport=useRef<HTMLDivElement>(null),blocked=disabled||modeBusy;
 const [mode,setMode]=useState<'visual'|'source'>('visual');
 const pending=useRef<BodyEditPosition|null>(null),pendingRange=useRef<SourceSelection|null>(null),lastSelection=useRef<SourceSelection>({start:0,end:0,backward:false}),imagePosition=useRef<{beforeContent:string;offset:number}|null>(null);
 const skipEntry=useRef(false),activating=useRef(false),previousStage=useRef(`${mode}:${editing}`);
 const queuedSourceInput=useRef<SourceInput[]>([]);
 const sourceSelection=():SourceSelection=>{
  const element=editorRef.current;if(!element)return lastSelection.current;
  if(element.hasAttribute('data-visual-editor')){const range=getVisualEditorSelection(element);return lastSelection.current={start:range.offset,end:range.end,backward:range.backward};}
  const range=getMarkdownEditorRange(element);if(range.inside)lastSelection.current={start:range.start,end:range.end,backward:range.backward};return lastSelection.current;
 };
 const caretRect=(offset:number)=>{const element=editorRef.current;return element?(element.hasAttribute('data-visual-editor')?visualEditorCaretRect(element,offset):sourceEditorCaretRect(element,offset)):null;};
 const remember=()=>{
  const pane=viewport.current,element=editorRef.current;if(!pane||!element)return;
  const range=sourceSelection(),rect=caretRect(range.start);pendingRange.current=range;
  pending.current=captureVisibleBodyEditPosition(pane,rect?{offset:range.start,rect}:null,point=>element.hasAttribute('data-visual-editor')?visualEditorCaretFromPoint(element,point.clientX,point.clientY):sourceEditorCaretFromPoint(element,point));
  pane.dataset.bodyPositionManaged='true';
 };
 const captureEntry=(point?:BodyEditPoint)=>{
  if(skipEntry.current){skipEntry.current=false;return;}
  const pane=viewport.current;if(!pane)return;
  if(mode==='source'&&editorRef.current){
   const caret=point?sourceEditorCaretFromPoint(editorRef.current,point):null;
   if(caret){pendingRange.current={start:caret.offset,end:caret.offset,backward:false};pending.current=captureBodyEditPosition(pane,caret.offset,caret.rect);}
   else remember();
  }else{
   const box=pane.getBoundingClientRect(),caret=bodyPreviewCaretFromPoint(pane,content,point??{clientX:box.left+18,clientY:box.top+18});
   if(caret){pending.current=captureBodyEditPosition(pane,caret.offset,caret.rect);pendingRange.current={start:caret.offset,end:caret.offset,backward:false};}
   else{pending.current={offset:0,viewportX:16,viewportY:12};pendingRange.current={start:0,end:0,backward:false};}
  }
  pane.dataset.bodyPositionManaged='true';
 };
 const focus=()=>{const element=editorRef.current;if(!element)return;if(element.hasAttribute('data-visual-editor'))focusVisualEditor(element);else element.focus({preventScroll:true});};
 useImperativeHandle(ref,()=>({captureEntry,captureExit:remember,focus}));
 useEffect(()=>{const selection=()=>{if(editing)sourceSelection();};document.addEventListener('selectionchange',selection);return()=>document.removeEventListener('selectionchange',selection);});
 useEffect(()=>{if(!blocked&&!editing){activating.current=false;skipEntry.current=false;queuedSourceInput.current=[];}},[blocked,editing]);
 useLayoutEffect(()=>{
  if(editing)activating.current=false;
  const pane=viewport.current,stage=`${mode}:${editing}`;if(!pane||previousStage.current===stage)return;previousStage.current=stage;
  const position=pending.current,range=pendingRange.current;pane.dataset.bodyPositionManaged='true';
  if(editing&&editorRef.current){focus();if(range){if(mode==='visual')setVisualEditorSelection(editorRef.current,range.start,range.end,range.backward);else setMarkdownEditorSelection(editorRef.current,range.start,range.end,range.backward);}}
  const restore=()=>{if(position)restoreBodyEditPosition(pane,position,caretRect);};restore();
  const complete=()=>{restore();if(pending.current===position)pending.current=null;if(pendingRange.current===range)pendingRange.current=null;delete pane.dataset.bodyPositionManaged;pane.dispatchEvent(new Event('scroll'));
   if(editing&&mode==='source'&&editorRef.current){for(const input of queuedSourceInput.current.splice(0)){
    if('markup'in input)insertMarkdownEditorMarkup(editorRef.current,input.markup);
    else if((input.ctrl||input.meta)&&input.key.toLowerCase()==='a')setMarkdownEditorSelection(editorRef.current,0,content.length);
    else if(input.key==='Backspace'||input.key==='Delete'){
     const element=editorRef.current,range=getMarkdownEditorRange(element),source=readMarkdownEditor(element);
     if(range.start===range.end){
      const back=input.key==='Backspace',atom=getMarkdownEditorAtoms(element).find(atom=>back?atom.end===range.start:atom.start===range.end),parts=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(source)];
      if(atom){range.start=atom.start;range.end=atom.end;}else if(back)range.start=parts.filter(part=>part.index<range.start).at(-1)?.index??0;else range.end=parts.find(part=>part.index>range.end)?.index??source.length;
     }
     setMarkdownEditorSelection(element,range.start,range.end);insertMarkdownEditorMarkup(element,'');
    }
    else editorRef.current.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:input.key,ctrlKey:input.ctrl,metaKey:input.meta,shiftKey:input.shift,altKey:input.alt}));
   }}
  };
  const frame=window.requestAnimationFrame?.(complete);if(frame===undefined)complete();return()=>{if(frame!==undefined)window.cancelAnimationFrame(frame);delete pane.dataset.bodyPositionManaged;};
 },[mode,editing]);
 const requestSourceEditing=(point?:BodyEditPoint)=>{
  if(editing||activating.current||blocked||!editable)return;
  captureEntry(point);activating.current=true;skipEntry.current=true;onRequestEdit();
 };
 const queueSource=(input:SourceInput)=>{if(blocked||!editable)return;queuedSourceInput.current.push(input);requestSourceEditing();};
 const switchMode=()=>{
  if(blocked||!editable)return;
  remember();queuedSourceInput.current=[];setMode(mode==='visual'?'source':'visual');
  if(!editing){activating.current=true;skipEntry.current=true;onRequestEdit();}
 };
 const insertTable=async()=>{
  if(mode==='source'&&!editing){queueSource({markup:emptyTableMarkup(content)});return;}
  if((editing||mode==='source')&&editorRef.current){const raw=emptyTableMarkup(content);if(mode==='visual')insertVisualEditorMarkup(editorRef.current,raw);else insertMarkdownEditorMarkup(editorRef.current,raw);return;}
  await prepare();await send({kind:'edit',id,field:'content',before:content,value:content+(content&&!content.endsWith('\n')?'\n':'')+emptyTableMarkup(content)});
 };
 const beforeImagePick=()=>{if(editing||mode==='source'){const range=sourceSelection();imagePosition.current={beforeContent:content,offset:range.start};}else imagePosition.current=null;};
 const insertImages=async(inputs:ImageImportInput[])=>{
  let position=imagePosition.current;if(!position&&(editing||mode==='source')){const range=sourceSelection();position={beforeContent:content,offset:range.start};}
  imagePosition.current=null;await flush();await send({kind:'images-import',id,inputs,...(position??{})});
 };
 const textPointerDown=(event:ReactPointerEvent<HTMLDivElement>)=>{if(event.button!==0)return;if(editing)event.stopPropagation();else event.preventDefault();};
 const editor=mode==='visual'?<VisualBodyEditor ref={editorRef} id={id} value={content} images={images} send={send} prepare={async()=>{remember();await prepare();}} active={editing} onChange={onChange} onBlur={onBlur} disabled={blocked} onPointerDown={textPointerDown} aria-label={uiText('bodyEditor.label')} placeholder={uiText('bodyEditor.placeholder')} className="body-visual-surface"/>:<MarkdownEditor ref={editorRef} value={content} onChange={onChange} onBlur={onBlur} disabled={blocked||!editable} readOnly={!editing}
 onPaste={event=>{if(!editing){event.preventDefault();queueSource({markup:event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n')});}}}
 onDrop={event=>{if(!editing&&!event.dataTransfer.files.length){event.preventDefault();queueSource({markup:event.dataTransfer.getData('text/plain')});}}}
 onKeyDown={event=>{
  if(editing)return;
  if(event.nativeEvent.isComposing||event.key==='Process'){requestSourceEditing();return;}
  const command=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
  if(!command&&!event.altKey&&event.key.length===1){event.preventDefault();queueSource({markup:event.key});}
  else if(event.key==='Enter'&&!command){event.preventDefault();queueSource({markup:'\n'});}
  else if(['Backspace','Delete'].includes(event.key)||command&&(['a','b','i','z','y','t'].includes(key)||key==='x'&&event.shiftKey)){event.preventDefault();event.stopPropagation();queueSource({key:event.key,ctrl:event.ctrlKey,meta:event.metaKey,shift:event.shiftKey,alt:event.altKey});}
 }} onPointerDown={textPointerDown} aria-label={uiText('bodyEditor.label')} placeholder={uiText('bodyEditor.placeholder')} className="content"/>;
 const toggle=<button className="body-mode-toggle" type="button" disabled={blocked} aria-label={uiText(mode==='source'?'bodyEditor.visual':'bodyEditor.source')} title={uiText(mode==='source'?'bodyEditor.visual':'bodyEditor.source')} aria-pressed={mode==='source'} onPointerDown={event=>{event.preventDefault();event.stopPropagation();}} onClick={event=>{event.stopPropagation();switchMode();}}><svg viewBox="0 0 20 20" aria-hidden="true">{mode==='source'?<path d="M3 5h14M3 10h11M3 15h14"/>:<path d="m6 5-4 5 4 5m8-10 4 5-4 5M12 3 8 17"/>}</svg></button>;
 return <div ref={viewport} className={`preview card-body-editor ${editing?'body-is-editing':''}`} data-body-editing={editing} data-editor-mode={mode}>
  <DrawingBody id={id} content={content} images={images} doodle={doodle??null} send={send} placeholder={uiText('bodyEditor.placeholder')} prepare={async()=>{remember();await prepare();}} extraTools={toggle} renderBody={editor} onInsertTable={insertTable} onInsertImages={insertImages} beforeImagePick={beforeImagePick}/>
 </div>;
});
