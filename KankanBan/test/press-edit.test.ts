import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {onScrollbar} from '../src/webview/drag-geometry.ts';
import {PrototypeNote} from '../src/webview/PrototypeNote.tsx';
import {openSession,createCard} from '../src/core/workspace.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {getVisualEditorSelection} from '../src/webview/VisualBodyEditor.tsx';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
function pointer(target:EventTarget,type:string,x=10,y=10){const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y,screenX:x,screenY:y});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);}
test('inline deletion text is not a scrollbar when clientWidth is zero',()=>{
 const text=document.createElement('del');text.textContent='done';document.body.append(text);
 Object.defineProperties(text,{offsetWidth:{value:60},clientWidth:{value:0},offsetHeight:{value:18},clientHeight:{value:0}});
 text.getBoundingClientRect=()=>({left:10,top:10,right:70,bottom:28,width:60,height:18}) as DOMRect;
 try{assert.equal(onScrollbar(text,20,20),false);}finally{text.remove();}
});
test('real scrollbars are excluded while their content remains draggable',()=>{
 const panel=document.createElement('div'),text=document.createElement('del');panel.style.overflowX='auto';panel.style.overflowY='auto';panel.append(text);document.body.append(panel);
 Object.defineProperties(panel,{offsetWidth:{value:100},clientWidth:{value:84},offsetHeight:{value:100},clientHeight:{value:84},scrollHeight:{value:200},scrollWidth:{value:200}});
 panel.getBoundingClientRect=()=>({left:0,top:0,right:100,bottom:100,width:100,height:100}) as DOMRect;
 try{assert.equal(onScrollbar(text,20,20),false);assert.equal(onScrollbar(text,95,20),true);assert.equal(onScrollbar(text,20,95),true);assert.equal(onScrollbar(panel,110,20),false);}finally{panel.remove();}
});
test('idle text drags the window and only a click starts selection at the pressed character',async()=>{
 const s=openSession('/press',{ops:createMemoryFs().ops}),id=createCard(s,{parentId:null,title:'Title',content:'~~Done~~'}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 const drags:string[]=[],render=()=>root.render(createElement(PrototypeNote,{card:s.state.cards.get(id)!,send:async()=>({}),children:null,breadcrumb:null,add:()=>{},startDrag:(_id,_event,mode)=>{drags.push(mode??'reparent');}}));
 const previous=Object.getOwnPropertyDescriptor(document,'caretRangeFromPoint');
 try{
  await act(async()=>render());const preview=host.querySelector<HTMLElement>('.preview')!,text=preview.querySelector('del')!,card=host.querySelector('.card')!,visual=host.querySelector<HTMLElement>('[data-visual-editor]')!;assert.ok(visual);assert.equal(visual.getAttribute('data-visual-active'),'false');
  Object.defineProperty(document,'caretRangeFromPoint',{configurable:true,value:(x:number)=>{const range=document.createRange();range.setStart(text.firstChild!,x<=10?1:3);range.collapse(true);return range;}});
  await act(async()=>{pointer(card,'pointerdown');pointer(preview,'pointerup');preview.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:10,clientY:10}));});assert.equal(preview.dataset.bodyEditing,'false');assert.equal(visual.getAttribute('data-visual-active'),'false');assert.equal(visual.getAttribute('contenteditable'),null);assert.deepEqual(drags,['window-desktop']);drags.length=0;
  await act(async()=>{pointer(text,'pointerdown');});assert.equal(preview.dataset.bodyEditing,'false');assert.equal(visual.getAttribute('data-visual-active'),'false');assert.equal(visual.getAttribute('contenteditable'),null);
  await act(async()=>{pointer(document,'pointermove',30,30);pointer(text,'pointerup',30,30);text.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:30,clientY:30}));});assert.equal(preview.dataset.bodyEditing,'false');assert.deepEqual(drags,['window-desktop'],'idle text uses the window gesture');drags.length=0;
  await act(async()=>{pointer(text,'pointerdown');pointer(text,'pointerup');text.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:30,clientY:30}));});assert.equal(preview.dataset.bodyEditing,'true');assert.equal(visual.getAttribute('contenteditable'),'true');assert.equal(getVisualEditorSelection(visual).offset,3,'click entry uses its press position even if the click reports a different point');assert.deepEqual(drags,['window-desktop'],'an idle press only arms the mover until the movement threshold');drags.length=0;
  await act(async()=>{pointer(text,'pointerdown');pointer(document,'pointermove',30,30);pointer(text,'pointerup',30,30);text.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:30,clientY:30}));});assert.equal(preview.dataset.bodyEditing,'true');assert.deepEqual(drags,[],'active text owns selection instead of moving the window');
  await act(async()=>host.querySelector<HTMLInputElement>('.title')!.click());assert.equal(host.querySelector<HTMLInputElement>('.title')!.readOnly,false);assert.equal(visual.getAttribute('data-visual-active'),'false');assert.equal(visual.getAttribute('contenteditable'),null);assert.ok(host.querySelector('[data-visual-editor]')===visual);
  await act(async()=>{pointer(text,'pointerdown');pointer(document,'pointermove',30,30);pointer(text,'pointerup',30,30);text.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:30,clientY:30}));});assert.equal(preview.dataset.bodyEditing,'false');assert.equal(host.querySelector<HTMLInputElement>('.title')!.readOnly,true);assert.deepEqual(drags,['window-desktop']);drags.length=0;
  await act(async()=>host.querySelector<HTMLInputElement>('.title')!.click());assert.equal(host.querySelector<HTMLInputElement>('.title')!.readOnly,false);
  await act(async()=>{pointer(card,'pointerdown');pointer(text,'pointerup');text.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:10,clientY:10}));});assert.equal(preview.dataset.bodyEditing,'false','releasing on text cannot activate input after a blank press');assert.deepEqual(drags,['window-desktop']);drags.length=0;
  await act(async()=>{pointer(text,'pointerdown');pointer(card,'pointerup');card.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:10,clientY:10}));});assert.equal(preview.dataset.bodyEditing,'true','a click enters the field hit on press even if release occurs on card chrome');assert.equal(visual.getAttribute('data-visual-active'),'true');assert.deepEqual(drags,['window-desktop']);assert.ok(host.querySelector('[data-visual-editor]')===visual);
 }finally{if(previous)Object.defineProperty(document,'caretRangeFromPoint',previous);else Reflect.deleteProperty(document,'caretRangeFromPoint');await act(async()=>root.unmount());host.remove();}
});
