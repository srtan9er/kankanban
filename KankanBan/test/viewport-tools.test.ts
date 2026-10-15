import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {DrawingBody} from '../src/webview/DrawingBody.tsx';
import {CanvasViewport} from '../src/webview/CanvasViewport.tsx';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:[...text].length*8})};}}});
test('doodle tools stay anchored to the viewport and are outside scrolling document content',async()=>{
 const host=document.createElement('div'),root=createRoot(host);host.className='preview';document.body.append(host);
 const rect=(x:number,y:number,w:number,h:number)=>({x,y,left:x,top:y,right:x+w,bottom:y+h,width:w,height:h,toJSON(){}} as DOMRect);
 host.getBoundingClientRect=()=>rect(10,20,300,200);
 try{
  await act(async()=>root.render(createElement(DrawingBody,{id:'card',content:'text',send:async()=>({})})));
  const pill=document.querySelector('.ink-pill')!;assert.ok(pill);assert.ok(!host.querySelector('.drawing-body')!.contains(pill));
  const toolbar=pill.parentElement!;assert.equal(toolbar.style.position,'fixed');const before={top:toolbar.style.top,left:toolbar.style.left};
  host.scrollLeft=120;host.scrollTop=500;await act(async()=>host.dispatchEvent(new Event('scroll')));
  assert.equal(toolbar.style.top,before.top);assert.equal(toolbar.style.left,before.left);
  host.getBoundingClientRect=()=>rect(10,20,500,300);await act(async()=>window.dispatchEvent(new Event('resize')));
  assert.equal(toolbar.style.top,before.top);assert.equal(Number.parseFloat(toolbar.style.left)-Number.parseFloat(before.left),200);
  await act(async()=>pill.querySelector<HTMLButtonElement>('button')!.click());assert.equal(pill.querySelector('button')!.getAttribute('aria-pressed'),'true');
 }finally{await act(async()=>root.unmount());host.remove();}
 assert.equal(document.querySelector('.viewport-ink-toolbar'),null);
});
test('canvas pen controls stay outside the scaled and translated canvas surface',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{
  await act(async()=>root.render(createElement(CanvasViewport,{parent:'card',entries:[],visibleIds:new Set<string>(),renderCard:()=>null,onCommit:async()=>{},onCreate:()=>{},onRebase:async()=>{},nativeDrag:false,dragBindings:{left:'pan',right:'window-desktop',combined:'window-fixed'},drawing:{version:1,id:'ink',width:300,height:200,strokes:[]},onDrawing:async()=>{}})));
  const viewport=host.querySelector<HTMLElement>('.canvas-viewport')!,surface=host.querySelector<HTMLElement>('.canvas-surface')!,toolbar=document.querySelector<HTMLElement>('.viewport-ink-toolbar')!;
  viewport.getBoundingClientRect=()=>({left:10,top:20,right:310,bottom:220,width:300,height:200,x:10,y:20,toJSON(){}} as DOMRect);
  await act(async()=>window.dispatchEvent(new Event('resize')));const at={left:toolbar.style.left,top:toolbar.style.top};
  assert.ok(!viewport.contains(toolbar));surface.style.transform='translate(800px, 900px) scale(3)';await act(async()=>window.dispatchEvent(new Event('scroll')));
  assert.equal(toolbar.style.left,at.left);assert.equal(toolbar.style.top,at.top);assert.equal(toolbar.style.position,'fixed');
 }finally{await act(async()=>root.unmount());host.remove();}
});
