import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceApp} from '../src/webview/WorkspaceApp.tsx';
import {WorkspaceController} from '../src/webview/controller.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {emptyViewState} from '../src/core/view-state.ts';
import {prepareEditors} from '../src/webview/drafts.ts';
import {getVisualEditorSelection} from '../src/webview/VisualBodyEditor.tsx';
import {setMarkdownEditorSelection,readMarkdownEditor} from '../src/webview/markdown-editor-model.ts';
import {parseCardImages} from '../src/core/image-markdown.ts';
import {uiText} from '../src/i18n/text.ts';

Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(s:string)=>({width:s.length*8})};}},requestAnimationFrame:(fn:(t:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:clearTimeout});
async function fixture(content:string){
 const buffer=createBufferedFs(),session=openSession('/manager-body',{ops:buffer.ops}),id=createCard(session,{parentId:null,title:'Current card',content}),controller=new WorkspaceController(session,emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 const original=controller.execute.bind(controller);controller.execute=(request,...args)=>request.kind==='tutorial'?Promise.resolve({createdId:id}):original(request,...args);
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 await act(async()=>root.render(createElement(WorkspaceApp,{controller})));
 await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.manager-tabs button')].find(button=>button.textContent===uiText('webview/WorkspaceApp.text024'))!.click());
 await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.settings-card button')].find(button=>button.textContent===uiText('webview/WorkspaceApp.reviewTutorial'))!.click());
 assert.ok(host.querySelector('.ordinary-content'));
 return {host,session,id,controller,close:async()=>{await act(async()=>root.unmount());host.remove();}};
}
const clickBody=async(host:HTMLElement)=>act(async()=>host.querySelector('.ordinary-content')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));

test('manager right press saves the current title and closes its editor',async()=>{
 const f=await fixture('Initial');try{
  await act(async()=>f.host.querySelector('.editable-title')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  const title=f.host.querySelector<HTMLInputElement>('.modal-backdrop input')!;assert.ok(title);
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(title,'Right click title');title.dispatchEvent(new Event('input',{bubbles:true}));});
  const right=new MouseEvent('pointerdown',{button:2,buttons:2,bubbles:true,cancelable:true});await act(async()=>title.dispatchEvent(right));
  assert.equal(right.defaultPrevented,true);assert.equal(f.session.state.cards.get(f.id)!.title,'Right click title');assert.ok(!f.host.querySelector('.modal-backdrop'));
 }finally{await f.close();}
});

test('manager body edits inline in formatted mode and switches source without a modal or unchanged writes',async()=>{
 const source='# Heading\nA **bold** word.',f=await fixture(source),before=f.session.events.length;
 try{
  const initialVisual=f.host.querySelector<HTMLElement>('[data-visual-editor]')!;assert.ok(initialVisual);assert.equal(initialVisual.getAttribute('data-visual-active'),'false');
  await clickBody(f.host);assert.equal(f.host.querySelector('.ordinary-content [data-visual-editor]'),initialVisual,'manager activates the existing formatted surface');assert.equal(initialVisual.getAttribute('data-visual-active'),'true');assert.equal(initialVisual.getAttribute('contenteditable'),'true');assert.equal(f.host.querySelector('.modal-backdrop'),null);
  assert.equal(f.host.querySelector('[data-visual-editor] strong')?.textContent,'bold');
  await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());assert.ok(f.host.querySelector('.ordinary-content [data-markdown-editor]:not([data-visual-editor])'));
  await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const visual=f.host.querySelector<HTMLElement>('[data-visual-editor]')!;assert.ok(visual);
  await act(async()=>f.host.querySelector('.page-heading')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0})));assert.equal(f.host.querySelector('[data-visual-editor]'),visual);assert.equal(visual.getAttribute('data-visual-active'),'false');assert.equal(visual.getAttribute('contenteditable'),null);
  await act(async()=>f.host.querySelector<HTMLButtonElement>('.document-tools .text-button')!.click());await clickBody(f.host);assert.equal(f.host.querySelector('[data-visual-editor]'),visual);assert.equal(visual.getAttribute('data-visual-active'),'false');assert.equal(visual.getAttribute('contenteditable'),null);assert.equal(f.host.querySelector<HTMLElement>('.card-body-editor')!.dataset.editorMode,'visual');assert.equal(document.querySelector('.body-mode-toggle'),null);assert.equal(f.session.state.cards.get(f.id)!.content,source);assert.equal(f.session.events.length,before);
 }finally{await f.close();}
});

test('manager saves source edits without unmounting during prepare and exits when the user presses elsewhere',async()=>{
 const f=await fixture('Initial');
 try{
  await clickBody(f.host);await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());
  const editor=f.host.querySelector<HTMLDivElement>('[data-markdown-editor]:not([data-visual-editor])')!;assert.ok(editor);setMarkdownEditorSelection(editor,7);
  const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> ' updated'}});await act(async()=>editor.dispatchEvent(paste));
  await act(async()=>prepareEditors());assert.equal(f.session.state.cards.get(f.id)!.content,'Initial updated');assert.equal(f.host.querySelector('[data-markdown-editor]:not([data-visual-editor])'),editor,'image insertion preparation must retain the editor and selection');
  await act(async()=>f.host.querySelector('.page-heading')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0})));assert.equal(f.host.querySelector('[data-markdown-editor]'),editor);assert.equal(f.host.querySelector<HTMLElement>('.card-body-editor')!.dataset.editorMode,'source');assert.equal(f.host.querySelector<HTMLElement>('.card-body-editor')!.dataset.bodyEditing,'false');
  await act(async()=>f.host.querySelector<HTMLButtonElement>('.document-tools .text-button')!.click());await clickBody(f.host);assert.equal(f.host.querySelector('[data-markdown-editor]'),editor);assert.equal(editor.getAttribute('contenteditable'),'false');assert.equal(f.host.querySelector<HTMLElement>('.card-body-editor')!.dataset.bodyEditing,'false');assert.equal(document.querySelector('.body-mode-toggle'),null);
 }finally{await f.close();}
});

for(const leave of ['outside','blur','escape','right'] as const)test(`manager ${leave} ends source input while later typing reactivates the same source surface`,async()=>{
 const f=await fixture('Initial');
 try{
  await clickBody(f.host);await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const editor=f.host.querySelector<HTMLDivElement>('[data-markdown-editor]:not([data-visual-editor])')!,pane=f.host.querySelector<HTMLElement>('.card-body-editor')!;setMarkdownEditorSelection(editor,7);
  await act(async()=>{if(leave==='blur')window.dispatchEvent(new Event('blur'));else if(leave==='escape')editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));else if(leave==='right'){const right=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:2,buttons:2});editor.dispatchEvent(right);assert.equal(right.defaultPrevented,true);}else f.host.querySelector('.page-heading')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0}));});
  assert.equal(pane.dataset.bodyEditing,'false');assert.equal(pane.dataset.editorMode,'source');assert.equal(f.host.querySelector('[data-markdown-editor]'),editor);
  const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> ' resumed'}});await act(async()=>editor.dispatchEvent(paste));assert.equal(pane.dataset.bodyEditing,'true');await act(async()=>prepareEditors());
  assert.equal(f.session.state.cards.get(f.id)!.content,'Initial resumed');assert.equal(readMarkdownEditor(editor),'Initial resumed');assert.equal(f.host.querySelector('[data-markdown-editor]'),editor);assert.equal(pane.dataset.editorMode,'source');assert.equal(f.host.querySelector('[role=alert]'),null);
  await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());assert.equal(pane.dataset.editorMode,'visual');assert.ok(f.host.querySelector('[data-visual-editor]'));assert.equal(f.host.querySelector('[data-markdown-editor]:not([data-visual-editor])'),null);
 }finally{await f.close();}
});

test('manager uses the initial pointer location for the formatted editor caret',async()=>{
 const source='First line. Target word.',f=await fixture(source);const previous=Object.getOwnPropertyDescriptor(document,'caretRangeFromPoint');
 try{
  const fragment=f.host.querySelector<HTMLElement>('.ordinary-content [data-source-start]')!,node=fragment.firstChild!,range=document.createRange();range.setStart(node,15);range.collapse(true);
  Object.defineProperty(document,'caretRangeFromPoint',{value:()=>range,configurable:true});
  await act(async()=>{fragment.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,clientX:90,clientY:80}));fragment.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,clientX:90,clientY:80,detail:1}));});
  const editor=f.host.querySelector<HTMLElement>('[data-visual-editor]');assert.ok(editor);assert.equal(getVisualEditorSelection(editor).offset,15);
 }finally{if(previous)Object.defineProperty(document,'caretRangeFromPoint',previous);else Reflect.deleteProperty(document,'caretRangeFromPoint');await f.close();}
});

test('manager autosave keeps source editable and drains typing received while a save is in flight',{timeout:5000},async()=>{
 const f=await fixture('Initial');let start!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{start=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),original=f.controller.execute.bind(f.controller);let blocked=false;
 f.controller.execute=async(request,...args)=>{if(request.kind==='edit' && request.field==='content' && !blocked){blocked=true;start();await gate;}return original(request,...args);};
 try{
  await clickBody(f.host);await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const editor=f.host.querySelector<HTMLDivElement>('[data-markdown-editor]:not([data-visual-editor])')!;setMarkdownEditorSelection(editor,7);
  const paste=(text:string)=>{const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:()=>text}});editor.dispatchEvent(event);};
  await act(async()=>{paste(' first');await started;});assert.equal(editor.getAttribute('contenteditable'),'true');
  await act(async()=>paste(' second'));release();await act(async()=>prepareEditors());
  assert.equal(f.session.state.cards.get(f.id)!.content,'Initial first second');assert.equal(f.host.querySelector('[data-markdown-editor]:not([data-visual-editor])'),editor);assert.equal(f.host.querySelector('[role=alert]'),null);
 }finally{release();await f.close();}
});

test('successful manager image import refreshes the clean inline draft and its next save baseline',async()=>{
 const f=await fixture('Initial');
 try{
  await clickBody(f.host);await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const editor=f.host.querySelector<HTMLDivElement>('[data-markdown-editor]:not([data-visual-editor])')!;
  await act(async()=>f.controller.execute({kind:'images-import',id:f.id,inputs:[{name:'photo.png',base64:'aW1hZ2U='}]},undefined,async()=>[{assetId:'a'.repeat(64)+'.png',name:'photo.png',mime:'image/png',width:80,height:40}]));
  const imported=f.session.state.cards.get(f.id)!.content;assert.equal(parseCardImages(imported).length,1);assert.equal(readMarkdownEditor(editor),imported,'successful import must become visible while the existing editor remains open');
  setMarkdownEditorSelection(editor,imported.length);const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> ' after image'}});await act(async()=>editor.dispatchEvent(paste));await act(async()=>prepareEditors());
  assert.equal(f.session.state.cards.get(f.id)!.content,imported+' after image');assert.equal(f.host.querySelector('[role=alert]'),null);
 }finally{await f.close();}
});

test('an external change does not overwrite a dirty manager draft and the save conflict stays visible',async()=>{
 const f=await fixture('Initial');
 try{
  await clickBody(f.host);await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const editor=f.host.querySelector<HTMLDivElement>('[data-markdown-editor]:not([data-visual-editor])')!;setMarkdownEditorSelection(editor,7);
  const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> ' local'}});await act(async()=>editor.dispatchEvent(paste));
  await act(async()=>f.controller.execute({kind:'edit',id:f.id,field:'content',before:'Initial',value:'Remote change'}));assert.equal(readMarkdownEditor(editor),'Initial local');
  await act(async()=>assert.rejects(prepareEditors()));assert.equal(readMarkdownEditor(editor),'Initial local');assert.equal(f.session.state.cards.get(f.id)!.content,'Remote change');assert.ok(f.host.querySelector('[role=alert]'));
 }finally{await f.close();}
});

test('changing manager fields waits for successful persistence and retains the body draft when saving fails',async()=>{
 const f=await fixture('Initial'),original=f.controller.execute.bind(f.controller);let fail=true;
 f.controller.execute=(request,...args)=>request.kind==='edit' && request.field==='content' && fail?Promise.reject(new Error('save failed')):original(request,...args);
 try{
  await clickBody(f.host);await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const editor=f.host.querySelector<HTMLDivElement>('[data-markdown-editor]:not([data-visual-editor])')!;setMarkdownEditorSelection(editor,7);
  const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> ' dirty'}});await act(async()=>editor.dispatchEvent(paste));
  const pressTitle=()=>{const title=f.host.querySelector('.editable-title')!;title.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0}));title.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:1}));};
  await act(async()=>pressTitle());assert.ok(!f.host.querySelector('.modal-backdrop'),'failed body persistence must not switch to title editing');assert.ok(f.host.querySelector('[data-markdown-editor]:not([data-visual-editor])')===editor);assert.equal(readMarkdownEditor(editor),'Initial dirty');assert.match(f.host.querySelector('[role=alert]')!.textContent!,/save failed/);assert.equal(f.session.state.cards.get(f.id)!.content,'Initial');
  fail=false;await act(async()=>pressTitle());assert.equal(f.session.state.cards.get(f.id)!.content,'Initial dirty');assert.ok(f.host.querySelector('.modal-backdrop input'),'the queued title editor opens after a successful retry');
 }finally{await f.close();}
});
for(const retry of ['pointer','paste'] as const)test(`a failed title save keeps source read-only and ${retry} can retry without losing either field`,async()=>{
 const f=await fixture('Initial'),original=f.controller.execute.bind(f.controller);let fail=true;
 f.controller.execute=(request,...args)=>request.kind==='edit' && request.field==='title' && fail?Promise.reject(new Error('title save failed')):original(request,...args);
 try{
  await act(async()=>{const title=f.host.querySelector('.editable-title')!;title.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0}));title.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:1}));});
  const titleInput=f.host.querySelector<HTMLInputElement>('.modal-backdrop input')!;assert.ok(titleInput);await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(titleInput,'Changed title');titleInput.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const editor=f.host.querySelector<HTMLDivElement>('[data-markdown-editor]:not([data-visual-editor])')!,pane=f.host.querySelector<HTMLElement>('.card-body-editor')!;
  assert.ok(editor);assert.equal(pane.dataset.editorMode,'source');assert.equal(pane.dataset.bodyEditing,'false');assert.match(f.host.querySelector('[role=alert]')!.textContent!,/title save failed/);assert.equal(titleInput.value,'Changed title');assert.equal(f.session.state.cards.get(f.id)!.title,'Current card');assert.equal(readMarkdownEditor(editor),'Initial');assert.equal(editor.getAttribute('contenteditable'),'false','body source must not accept input while the dirty title cannot be saved');assert.equal(editor.getAttribute('aria-disabled'),'false','idle source is read-only rather than disabled');
  fail=false;setMarkdownEditorSelection(editor,7);
  if(retry==='pointer')await act(async()=>editor.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,clientX:80,clientY:60})));
  const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> ' resumed'}});await act(async()=>editor.dispatchEvent(paste));await act(async()=>prepareEditors());
  assert.equal(pane.dataset.bodyEditing,'true');assert.equal(pane.dataset.editorMode,'source');assert.equal(f.host.querySelector('[data-markdown-editor]:not([data-visual-editor])'),editor);assert.equal(editor.getAttribute('contenteditable'),'true');assert.equal(readMarkdownEditor(editor),'Initial resumed');assert.equal(f.session.state.cards.get(f.id)!.title,'Changed title');assert.equal(f.session.state.cards.get(f.id)!.content,'Initial resumed');assert.equal(f.host.querySelector('.modal-backdrop'),null);assert.equal(f.host.querySelector('[role=alert]'),null);
 }finally{await f.close();}
});
test('manager body scrollbar keeps editing active while a normal blank-area press still exits',async()=>{
 const f=await fixture('Scrollable body');
 try{
  await clickBody(f.host);await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const pane=f.host.querySelector<HTMLElement>('.card-body-editor')!;
  pane.style.overflowY='auto';pane.getBoundingClientRect=()=>({left:0,top:0,right:416,bottom:200,width:416,height:200,x:0,y:0,toJSON(){}});Object.defineProperties(pane,{clientWidth:{value:400},clientHeight:{value:200},offsetWidth:{value:416},offsetHeight:{value:200},scrollHeight:{value:2000}});
  const editor=f.host.querySelector('[data-markdown-editor]');assert.equal(pane.dataset.bodyEditing,'true');await act(async()=>pane.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,clientX:410,clientY:100})));assert.equal(f.host.querySelector('[data-markdown-editor]'),editor);assert.equal(pane.dataset.bodyEditing,'true');
  await act(async()=>pane.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,clientX:100,clientY:100})));assert.equal(f.host.querySelector('[data-markdown-editor]'),editor);assert.equal(pane.dataset.editorMode,'source');assert.equal(pane.dataset.bodyEditing,'false');
 }finally{await f.close();}
});
