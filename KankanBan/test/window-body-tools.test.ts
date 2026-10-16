import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {DrawingBody} from '../src/webview/DrawingBody.tsx';
import {CanvasViewport} from '../src/webview/CanvasViewport.tsx';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(s:string)=>({width:s.length*8})};}}});
const rect=(width:number,height:number)=>({x:10,y:20,left:10,top:20,right:10+width,bottom:20+height,width,height,toJSON(){}} as DOMRect);

test('body tools use three separate right-aligned rows with the source switch first',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{
  await act(async()=>root.render(createElement(DrawingBody,{id:'card',content:'text',extraTools:createElement('button',{'data-source-mode':true},'source'),send:async()=>{}})));
  const stack=document.querySelector<HTMLElement>('.body-create-tools')!;assert.equal(stack.style.flexDirection,'column');assert.equal(stack.style.alignItems,'flex-end');assert.equal(stack.style.gap,'6px');
  const rows=[...stack.children];assert.equal(rows.length,3);assert.ok(rows[0]!.querySelector('[data-source-mode]'));assert.ok(rows[1]!.querySelector('.image-create-button'));assert.ok(rows[1]!.querySelector('.table-create-button'));assert.equal(rows[2]!.querySelectorAll('button[aria-pressed]').length,2);
  assert.ok(!host.contains(stack),'floating tool rows must not occupy the document layout');
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('tool anchors track body border-box resize while ignoring scrollbar width and scrolling',async()=>{
 const host=document.createElement('div'),root=createRoot(host);host.className='preview';host.getBoundingClientRect=()=>rect(300,200);document.body.append(host);
 Object.defineProperty(host,'clientWidth',{value:300,configurable:true});
 try{
  await act(async()=>root.render(createElement(DrawingBody,{id:'card',content:'text',send:async()=>{}})));const tools=document.querySelector<HTMLElement>('.viewport-ink-toolbar')!;
  const anchored=(width=300,height=200)=>{assert.equal(tools.style.position,'fixed');assert.equal(tools.style.left,`${10+width-24}px`);assert.equal(tools.style.top,`${20+height-24}px`);assert.equal(tools.style.transform,'translate(-100%, -100%)');assert.equal(tools.style.maxWidth,`${width-32}px`);assert.equal(tools.style.maxHeight,`${height-32}px`);assert.equal(tools.style.overflow,'hidden');};anchored();
  Object.defineProperty(host,'clientWidth',{value:283,configurable:true});host.scrollTop=800;host.scrollLeft=90;host.style.transform='translate(80px,120px) scale(2)';
  await act(async()=>{host.dispatchEvent(new Event('scroll'));window.dispatchEvent(new Event('resize'));});anchored();
  host.getBoundingClientRect=()=>rect(600,400);Object.defineProperty(host,'clientWidth',{value:600,configurable:true});await act(async()=>window.dispatchEvent(new Event('resize')));anchored(600,400);
  assert.equal(document.querySelector('.body-create-tools')!.children.length,2,'body tools omit only the unavailable source row');
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('canvas ink-only tools use their body border-box and clip inside very small body areas',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{
  await act(async()=>root.render(createElement(CanvasViewport,{parent:'card',entries:[],visibleIds:new Set<string>(),renderCard:()=>null,onCommit:async()=>{},onCreate:()=>{},onRebase:async()=>{},nativeDrag:false,dragBindings:{left:'pan',right:'window-desktop',combined:'window-fixed'},drawing:{version:1,id:'ink',width:300,height:200,strokes:[]},onDrawing:async()=>{}})));
  const pane=host.querySelector<HTMLElement>('.canvas-viewport')!,tools=document.querySelector<HTMLElement>('.viewport-ink-toolbar')!;pane.getBoundingClientRect=()=>rect(300,200);await act(async()=>window.dispatchEvent(new Event('resize')));assert.equal(tools.style.left,'286px');assert.equal(tools.style.top,'196px');assert.equal(tools.querySelectorAll('.ink-pill').length,1);assert.ok(!pane.contains(tools));
  pane.getBoundingClientRect=()=>rect(60,50);await act(async()=>window.dispatchEvent(new Event('resize')));assert.equal(tools.style.maxWidth,'28px');assert.equal(tools.style.maxHeight,'18px');assert.equal(tools.style.overflow,'hidden');
  pane.getBoundingClientRect=()=>rect(60,24);await act(async()=>window.dispatchEvent(new Event('resize')));assert.equal(tools.style.visibility,'hidden');assert.equal(tools.style.maxHeight,'0px');
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('a long document never anchors its tools in the separate child-card region',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{
  await act(async()=>root.render(createElement('div',{},createElement('div',{className:'card-body-region'},createElement('div',{className:'preview'},createElement(DrawingBody,{id:'card',content:'text',send:async()=>{}}))),createElement('div',{className:'child-region'},'children'))));
  const body=host.querySelector<HTMLElement>('.card-body-region')!,preview=host.querySelector<HTMLElement>('.preview')!,tools=document.querySelector<HTMLElement>('.viewport-ink-toolbar')!;body.getBoundingClientRect=()=>rect(300,160);preview.getBoundingClientRect=()=>rect(300,800);
  await act(async()=>window.dispatchEvent(new Event('resize')));assert.equal(tools.style.top,'156px');assert.equal(tools.style.maxHeight,'128px');
  body.getBoundingClientRect=()=>rect(300,80);await act(async()=>window.dispatchEvent(new Event('resize')));assert.equal(tools.style.top,'76px');assert.equal(tools.style.maxHeight,'48px');assert.equal(tools.style.overflow,'hidden');
 }finally{await act(async()=>root.unmount());host.remove();}
});
