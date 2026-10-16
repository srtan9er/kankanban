import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {PrototypeNote} from '../src/webview/PrototypeNote.tsx';
import {openSession,createCard} from '../src/core/workspace.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {executeAction} from '../src/core/actions.ts';
import {readMarkdownEditor,setMarkdownEditorSelection} from '../src/webview/markdown-editor-model.ts';
import type {CanvasDragBindings} from '../src/core/canvas-drag.ts';

Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
function pointer(target:EventTarget,type:string,button=2,buttons=2){const event=new MouseEvent(type,{bubbles:true,cancelable:true,button,buttons,clientX:20,clientY:30});Object.defineProperty(event,'pointerId',{value:17});target.dispatchEvent(event);return event;}
async function fixture(bindings?:CanvasDragBindings){
 const session=openSession('/right-window',{ops:createMemoryFs().ops}),id=createCard(session,{parentId:null,title:'Title',content:'Body text'}),host=document.createElement('div'),root=createRoot(host),drags:{button:number;mode:string|undefined}[]=[];document.body.append(host);
 const render=()=>root.render(createElement(PrototypeNote,{card:session.state.cards.get(id)!,canvas:!!bindings,...(bindings?{dragBindings:bindings}:{}),send:async request=>{if(request.kind==='edit'){executeAction(session,request);render();}return {};},children:createElement('div',{'data-card-id':'child'},'Child'),breadcrumb:null,add:()=>{},startDrag:(_id,event,mode)=>{drags.push({button:event.button,mode});}}));
 await act(async()=>render());return {host,drags,session,id,close:async()=>{await act(async()=>root.unmount());host.remove();}};
}

for(const area of ['title','source','child','tool'] as const)test(`right press on ${area} starts the ordinary window gesture and ends input without changing source mode`,async()=>{
 const f=await fixture();try{
  if(area==='title')await act(async()=>f.host.querySelector<HTMLInputElement>('.title')!.click());
  else if(area==='source'){
   await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const editor=f.host.querySelector<HTMLElement>('[data-markdown-editor]')!;setMarkdownEditorSelection(editor,9);
   const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> ' saved'}});await act(async()=>editor.dispatchEvent(paste));
  }
  const target=area==='title'?f.host.querySelector('.title')!:area==='source'?f.host.querySelector('[data-markdown-editor]')!:area==='child'?f.host.querySelector('[data-card-id]')!:document.querySelector('.body-mode-toggle')!;
  await act(async()=>pointer(target,'pointerdown'));
  assert.deepEqual(f.drags,[{button:2,mode:'window-desktop'}]);assert.equal(f.host.querySelector<HTMLInputElement>('.title')!.readOnly,true);assert.equal(f.host.querySelector<HTMLElement>('.card-body-editor')!.dataset.bodyEditing,'false');
  if(area==='source'){assert.equal(f.host.querySelector<HTMLElement>('.card-body-editor')!.dataset.editorMode,'source');assert.equal(readMarkdownEditor(f.host.querySelector('[data-markdown-editor]')!),'Body text saved');assert.equal(f.session.state.cards.get(f.id)!.content,'Body text saved');}
 }finally{await f.close();}
});

test('right press exits pencil input and reaches the same window gesture from its drawing surface',async()=>{
 const f=await fixture();try{
  await act(async()=>document.querySelectorAll<HTMLButtonElement>('.ink-pill button[aria-pressed]')[0]!.click());const surface=f.host.querySelector('.doodle-layer')!;
  await act(async()=>pointer(surface,'pointerdown'));assert.equal(surface.getAttribute('data-active'),'false');assert.deepEqual(f.drags,[{button:2,mode:'window-desktop'}]);
 }finally{await f.close();}
});

test('adding the right button during a held left press can start the window gesture exactly once',async()=>{
 const f=await fixture();try{
  const surface=f.host.querySelector('.doodle-layer')!;await act(async()=>document.querySelectorAll<HTMLButtonElement>('.ink-pill button[aria-pressed]')[0]!.click());
  await act(async()=>{pointer(surface,'pointermove',2,3);pointer(surface,'pointermove',-1,3);});assert.equal(surface.getAttribute('data-active'),'false');assert.deepEqual(f.drags,[{button:2,mode:'window-desktop'}]);
 }finally{await f.close();}
});

test('canvas right gesture retains its configured action even when it starts in the active title editor',async()=>{
 const f=await fixture({left:'pan',right:'window-fixed',combined:'window-desktop'});try{
  await act(async()=>f.host.querySelector<HTMLInputElement>('.title')!.click());await act(async()=>pointer(f.host.querySelector('.title')!,'pointerdown'));assert.deepEqual(f.drags,[{button:2,mode:'window-fixed'}]);assert.equal(f.host.querySelector<HTMLInputElement>('.title')!.readOnly,true);
 }finally{await f.close();}
});
