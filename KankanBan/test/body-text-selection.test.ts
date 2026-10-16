import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {PrototypeNote} from '../src/webview/PrototypeNote.tsx';
import {openSession,createCard} from '../src/core/workspace.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {executeAction} from '../src/core/actions.ts';
import {setVisualEditorSelection} from '../src/webview/VisualBodyEditor.tsx';
import {getMarkdownEditorRange} from '../src/webview/markdown-editor-model.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});

test('idle text drags move the window while a classified click enters the same selectable body',async()=>{
 const session=openSession('/body-select',{ops:createMemoryFs().ops}),id=createCard(session,{parentId:null,content:'Select this text'}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);let drags=0;
 const render=()=>root.render(createElement(PrototypeNote,{card:session.state.cards.get(id)!,startDrag:()=>{drags++;},add:()=>{},children:null,breadcrumb:null,send:async request=>{if(request.kind==='edit'){executeAction(session,request);render();}return {};}}));
 try{
  await act(async()=>render());const flow=host.querySelector('.rich-image-flow'),text=host.querySelector('.rich-image-text')!;
  const press=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1,clientX:20,clientY:30});
  await act(async()=>text.dispatchEvent(press));assert.equal(drags,1,'idle body text belongs to the window mover');assert.equal(press.defaultPrevented,true,'idle text must not start native selection');
  const editor=host.querySelector<HTMLElement>('[data-visual-editor]')!;assert.equal(editor.getAttribute('contenteditable'),null,'a press must wait for click-versus-drag classification');
  await act(async()=>{text.dispatchEvent(new MouseEvent('pointermove',{bubbles:true,button:0,buttons:1,clientX:40,clientY:30}));text.dispatchEvent(new MouseEvent('pointerup',{bubbles:true,button:0,buttons:0,clientX:40,clientY:30}));text.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:1,clientX:40,clientY:30}));});assert.equal(editor.getAttribute('contenteditable'),null,'the click emitted after dragging must not enter editing');
  await act(async()=>{text.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1,clientX:20,clientY:30}));text.dispatchEvent(new MouseEvent('pointerup',{bubbles:true,button:0,buttons:0,clientX:20,clientY:30}));text.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:1,clientX:20,clientY:30}));});
  assert.equal(editor.getAttribute('contenteditable'),'true','a click enables native text selection');assert.ok(host.querySelector('.rich-image-flow')===flow);assert.equal(drags,2);
  const selectionPress=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1});await act(async()=>text.dispatchEvent(selectionPress));assert.equal(drags,2,'active text selection stays inside the editor');assert.equal(selectionPress.defaultPrevented,false);
  setVisualEditorSelection(editor,0,6);await act(async()=>editor.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true,cancelable:true})));
  assert.equal(host.querySelector('strong')?.textContent,'Select');
  await act(async()=>host.querySelector('.note-title-row')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,buttons:1})));
  assert.equal(drags,3,'the title remains available for moving the window');assert.equal(session.state.cards.get(id)!.content,'**Select** this text');
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('idle source dragging keeps its window gesture and a later click reactivates the same source at the press caret',async()=>{
 const session=openSession('/source-select',{ops:createMemoryFs().ops}),id=createCard(session,{parentId:null,content:'Source text here'}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);let drags=0;
 const previous=Object.getOwnPropertyDescriptor(document,'caretRangeFromPoint');
 const pointer=(target:EventTarget,type:string,x=20)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:30}));
 try{
  await act(async()=>root.render(createElement(PrototypeNote,{card:session.state.cards.get(id)!,startDrag:()=>{drags++;},add:()=>{},children:null,breadcrumb:null,send:async()=>({})})));
  await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const pane=host.querySelector<HTMLElement>('.card-body-editor')!,source=host.querySelector<HTMLElement>('[data-markdown-editor]:not([data-visual-editor])')!;
  Object.defineProperty(document,'caretRangeFromPoint',{configurable:true,value:(x:number)=>{const range=document.createRange();range.setStart(source.firstChild!,x<=20?3:9);range.collapse(true);return range;}});
  await act(async()=>source.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:2,buttons:2})));assert.equal(pane.dataset.bodyEditing,'false');assert.equal(source.getAttribute('contenteditable'),'false');const afterRight=drags;
  await act(async()=>pointer(source,'pointerdown'));assert.equal(pane.dataset.bodyEditing,'false');assert.equal(drags,afterRight+1,'idle source text passes its press to the window mover');
  await act(async()=>{pointer(document,'pointermove',40);pointer(source,'pointerup',40);source.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:1,clientX:40,clientY:30}));});assert.equal(pane.dataset.bodyEditing,'false');assert.ok(host.querySelector('[data-markdown-editor]')===source);
  await act(async()=>{pointer(source,'pointerdown');pointer(source,'pointerup',22);source.dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:1,clientX:22,clientY:30}));});
  assert.equal(pane.dataset.bodyEditing,'true');assert.equal(source.getAttribute('contenteditable'),'true');assert.ok(host.querySelector('[data-markdown-editor]')===source);assert.equal(getMarkdownEditorRange(source).start,3,'source reactivation uses the original press position rather than the release position');assert.equal(drags,afterRight+2);
 }finally{if(previous)Object.defineProperty(document,'caretRangeFromPoint',previous);else Reflect.deleteProperty(document,'caretRangeFromPoint');await act(async()=>root.unmount());host.remove();}
});
