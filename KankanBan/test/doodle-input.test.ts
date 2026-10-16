import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {DrawingBody} from '../src/webview/DrawingBody.tsx';
import {CanvasViewport} from '../src/webview/CanvasViewport.tsx';
import {useFixedCanvasDrag} from '../src/webview/useFixedCanvasDrag.ts';
import type {Request} from '../src/webview/controller.ts';
import {emptyInk} from '../src/core/drawing.ts';

Object.assign(globalThis,{CustomEvent:window.CustomEvent,ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(s:string)=>({width:s.length*8})};}},DOMPoint:class{x:number;y:number;constructor(x:number,y:number){this.x=x;this.y=y;}matrixTransform(){return this;}},DOMMatrixReadOnly:class{a=1;m41=0;m42=0;inverse(){return this;}},requestAnimationFrame:(f:(t:number)=>void)=>setTimeout(()=>f(0),0),cancelAnimationFrame:clearTimeout});
const captures=new WeakMap<Element,number>();Object.assign(Element.prototype,{setPointerCapture(this:Element,id:number){captures.set(this,id);},hasPointerCapture(this:Element,id:number){return captures.get(this)===id;},releasePointerCapture(this:Element){captures.delete(this);}});Object.assign(window.SVGElement.prototype,{getScreenCTM(){return {inverse(){return this;}};}});
function pointer(target:EventTarget,type:string,button:number,buttons:number,x=10,y=10){const event=new MouseEvent(type,{bubbles:true,cancelable:true,button,buttons,clientX:x,clientY:y,screenX:x,screenY:y});Object.defineProperty(event,'pointerId',{value:7});target.dispatchEvent(event);return event;}
const pen=()=>document.querySelectorAll<HTMLButtonElement>('.ink-pill button[aria-pressed]')[0]!;
const eraser=()=>document.querySelectorAll<HTMLButtonElement>('.ink-pill button[aria-pressed]')[1]!;
async function body(){const host=document.createElement('div'),root=createRoot(host),requests:Request[]=[];document.body.append(host);await act(async()=>root.render(createElement('div',{className:'workspace-main'},createElement(DrawingBody,{id:'card',content:'Keep text',send:async request=>{requests.push(request);}}))));return {host,requests,close:async()=>{await act(async()=>root.unmount());host.remove();}};}

test('left button paints and erases while right button exits and flushes the active body stroke',async()=>{
 const f=await body();
 try{
  await act(async()=>pen().click());const surface=f.host.querySelector<SVGSVGElement>('.doodle-layer')!;
  await act(async()=>{pointer(surface,'pointerdown',0,1);pointer(surface,'pointermove',-1,1,40,30);pointer(surface,'pointerup',0,0,40,30);});
  assert.equal(pen().getAttribute('aria-pressed'),'true','left drawing must stay in pen mode');assert.equal(surface.querySelectorAll('polyline').length,1);assert.ok(f.requests.some(request=>request.kind==='doodle-update' && request.document.strokes.length===1));
  await act(async()=>eraser().click());await act(async()=>{pointer(surface,'pointerdown',0,1);pointer(surface,'pointerup',0,0);});assert.equal(eraser().getAttribute('aria-pressed'),'true');assert.equal(surface.querySelectorAll('polyline').length,0);
  await act(async()=>pen().click());await act(async()=>{pointer(surface,'pointerdown',0,1,60,60);pointer(surface,'pointermove',-1,1,80,80);const exit=pointer(surface,'pointermove',2,3,80,80);assert.equal(exit.defaultPrevented,true);});
  assert.equal(pen().getAttribute('aria-pressed'),'false');assert.equal(surface.querySelectorAll('polyline').length,1);assert.ok(f.requests.some(request=>request.kind==='doodle-update' && request.document.strokes.length===1));
  await act(async()=>{pointer(document,'pointerup',2,1);pointer(document,'pointerup',0,0);});
 }finally{await f.close();}
});

test('a right-first exit forwards the original press and subsequent chord events to the window',async()=>{
 const f=await body(),target=f.host.querySelector('.drawing-body')!,owner=f.host.querySelector('.workspace-main')!;const received:Event[]=[];const observe=(event:Event)=>received.push(event);for(const type of ['pointerdown','pointermove','pointerup'])owner.addEventListener(type,observe,true);
 try{
  await act(async()=>pen().click());
  const sent:Event[]=[];await act(async()=>{sent.push(pointer(target,'pointerdown',2,2));assert.equal(sent[0]!.defaultPrevented,true);sent.push(pointer(target,'pointerdown',0,3),pointer(target,'pointermove',-1,3,30,30),pointer(target,'pointerup',2,1),pointer(target,'pointermove',-1,1,40,40),pointer(target,'pointerup',0,0));});
  assert.equal(pen().getAttribute('aria-pressed'),'false');assert.deepEqual(received,sent,'the window must receive the same exit press and every remaining drag event');assert.equal(document.documentElement.dataset.doodleExiting,undefined);
 }finally{for(const type of ['pointerdown','pointermove','pointerup'])owner.removeEventListener(type,observe,true);await f.close();}
});

test('canvas left drawing stays local while a right exit reaches parent capture and configured dragging resumes',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);let moves=0,draws=0;const exits:Event[]=[],released:boolean[]=[];
 const bindings={left:'pan',right:'window-desktop',combined:'window-fixed'} as const;
 const Harness=()=>{const drag=useFixedCanvasDrag(true,bindings,()=>moves++);return createElement('div',{className:'workspace-main',...drag,onPointerDownCapture:(event:import('react').PointerEvent)=>{if(event.button===2){exits.push(event.nativeEvent);released.push(!(event.target as Element).hasPointerCapture(event.pointerId));}else drag.onPointerDownCapture(event);},onPointerMoveCapture:(event:import('react').PointerEvent)=>{if((event.buttons&2)!==0){exits.push(event.nativeEvent);released.push(!(event.target as Element).hasPointerCapture(event.pointerId));}else drag.onPointerMoveCapture(event);}},createElement(CanvasViewport,{parent:'card',entries:[],visibleIds:new Set<string>(),renderCard:()=>null,onCommit:async()=>{moves++;},onCreate:()=>{},onRebase:async()=>{},nativeDrag:false,dragBindings:bindings,drawing:emptyInk('ink',300,200),onDrawing:async()=>{draws++;}}));};
 try{
  await act(async()=>root.render(createElement(Harness)));await act(async()=>pen().click());const surface=host.querySelector('[data-drawing-surface]')!;
  await act(async()=>{pointer(surface,'pointerdown',0,1);pointer(surface,'pointermove',-1,1,40,30);pointer(surface,'pointerup',0,0,40,30);});assert.equal(pen().getAttribute('aria-pressed'),'true');assert.equal(draws,1);assert.equal(moves,0);
  await act(async()=>{pointer(surface,'pointerdown',0,1);pointer(surface,'pointermove',-1,1,60,50);});const input=host.querySelector('[data-drawing-surface]')!;assert.equal(input.hasPointerCapture(7),true);
  let exit:Event;await act(async()=>{exit=pointer(input,'pointermove',2,3,80,60);});assert.equal(pen().getAttribute('aria-pressed'),'false');assert.equal(draws,2);assert.equal(exits[0],exit!);assert.deepEqual(released,[true],'active stroke capture is released before window capture handles the same event');assert.equal(document.documentElement.dataset.doodleExiting,undefined);
  const viewport=host.querySelector('.canvas-viewport')!;await act(async()=>{pointer(viewport,'pointerup',2,1);pointer(viewport,'pointerup',0,0);pointer(viewport,'pointerdown',0,1);pointer(viewport,'pointermove',-1,1,100,80);pointer(viewport,'pointerup',0,0);});assert.ok(moves>0,'configured canvas gestures must work immediately after exiting');
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('the right press that exits canvas drawing can immediately start the configured pan',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);const bindings={left:'window-desktop',right:'pan',combined:'window-fixed'} as const;
 try{
  await act(async()=>root.render(createElement('div',{className:'workspace-main'},createElement(CanvasViewport,{parent:'card',entries:[],visibleIds:new Set<string>(),renderCard:()=>null,onCommit:async()=>{},onCreate:()=>{},onRebase:async()=>{},nativeDrag:false,dragBindings:bindings,drawing:emptyInk('ink',300,200),onDrawing:async()=>{}}))));await act(async()=>pen().click());const input=host.querySelector('[data-drawing-surface]')!,viewport=host.querySelector('.canvas-viewport')!;
  await act(async()=>{pointer(input,'pointerdown',2,2);});assert.equal(pen().getAttribute('aria-pressed'),'false');
  await act(async()=>{pointer(viewport,'pointermove',-1,2,80,60);await new Promise(resolve=>setTimeout(resolve,5));});assert.equal(document.documentElement.classList.contains('canvas-panning'),true);assert.equal(viewport.getAttribute('data-canvas-pan-x'),'70');assert.equal(viewport.getAttribute('data-canvas-pan-y'),'50');
  await act(async()=>pointer(viewport,'pointerup',2,0,80,60));assert.equal(document.documentElement.classList.contains('canvas-panning'),false);
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('Escape and pressing the selected tool again still exit drawing mode',async()=>{
 const f=await body();try{await act(async()=>pen().click());await act(async()=>pen().click());assert.equal(pen().getAttribute('aria-pressed'),'false');await act(async()=>eraser().click());await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));assert.equal(eraser().getAttribute('aria-pressed'),'false');}finally{await f.close();}
});
