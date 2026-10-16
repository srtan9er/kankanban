import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {PrototypeNote} from '../src/webview/PrototypeNote.tsx';
import {openSession,createCard} from '../src/core/workspace.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {executeAction} from '../src/core/actions.ts';
import {emptyTableMarkup} from '../src/core/table-markdown.ts';
import {parseCardImages} from '../src/core/image-markdown.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(s:string)=>({width:s.length*8})};}},requestAnimationFrame:(f:(t:number)=>void)=>setTimeout(()=>f(0),0),cancelAnimationFrame:clearTimeout});
const computedStyle=getComputedStyle,bodyStyle=document.createElement('div').style;bodyStyle.fontSize='13px';bodyStyle.lineHeight='20.8px';bodyStyle.fontFamily='sans-serif';
// JSDOM does no layout; avoid its expensive inherited-style traversal through
// nested table previews. Geometry/position mapping has separate focused tests.
Object.assign(globalThis,{getComputedStyle:(element:Element)=>element.closest('.rich-image-body')?bodyStyle:computedStyle(element)});

test('body opens as formatted editing and source toggles preserve unchanged Markdown without writes',async()=>{
 const source='# Heading\nA **bold** word.\n\n- [ ] Task\n\n```txt\nraw <tag>\n```\n';
 const session=openSession('/body-edit',{ops:createMemoryFs().ops}),id=createCard(session,{parentId:null,title:'Card',content:source}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);let writes=0;
 const render=()=>root.render(createElement(PrototypeNote,{card:session.state.cards.get(id)!,add:()=>{},children:null,breadcrumb:null,send:async request=>{if(request.kind==='edit'){writes++;executeAction(session,request);render();}return {};}}));
 try{
  await act(async()=>render());await act(async()=>host.querySelector('.preview')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  const visual=host.querySelector('[data-visual-editor]');assert.ok(visual,'default body editing should be visual');assert.equal(visual.querySelector('h1')?.textContent,'Heading');assert.equal(visual.querySelector('strong')?.textContent,'bold');
  const sourceButton=()=>document.querySelector<HTMLButtonElement>('[aria-label="切换到 Markdown 源码"]');assert.ok(sourceButton());
  await act(async()=>sourceButton()!.click());assert.ok(host.querySelector('[data-markdown-editor]:not([data-visual-editor])'));
  const preview=host.querySelector('.preview');assert.ok(preview,'both editor modes reuse the same scroll viewport');
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="切换到排版编辑"]')!.click());assert.ok(host.querySelector('[data-visual-editor]'));
  await act(async()=>host.querySelector('.note-title-row')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0})));
  assert.ok(host.querySelector('[data-visual-editor]'),'formatted layout remains mounted after leaving text input');assert.notEqual(host.querySelector('[data-visual-editor]')?.getAttribute('contenteditable'),'true');assert.equal(session.state.cards.get(id)!.content,source);assert.equal(writes,0);
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('a table cell in formatted editing opens in place without replacing the body layout',async()=>{
 const session=openSession('/visual-table',{ops:createMemoryFs().ops}),id=createCard(session,{parentId:null,content:'Text\n\n'+emptyTableMarkup('')}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 const render=()=>root.render(createElement(PrototypeNote,{card:session.state.cards.get(id)!,add:()=>{},children:null,breadcrumb:null,send:async()=>({})}));
 try{
  await act(async()=>render());await act(async()=>host.querySelector('.preview')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  const flow=host.querySelector('.rich-image-flow'),cell=host.querySelector('[data-visual-editor] [data-table-cell="0:1"]');assert.ok(cell);
  await act(async()=>{for(const type of ['pointerdown','pointerup','click']){const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type==='pointerdown'?1:0,clientX:50,clientY:40,detail:type==='click'?1:0});Object.defineProperty(event,'pointerId',{value:1});cell.dispatchEvent(event);}});
  assert.ok(host.querySelector('.rich-image-flow')===flow,'cell editing uses the same body renderer');
  assert.ok(host.querySelector('[data-table-cell="0:1"] .table-cell-editor'),'one press should open the same existing table cell');
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('dragging an image while editing text keeps its existing frame and saves the whole gesture',async()=>{
 const raw=`<image src="../assets/images/${'b'.repeat(64)}.png" name="image_0" layout="overlay" x="20" y="30" width="80" height="80">Picture</image>`;
 const session=openSession('/visual-image',{ops:createMemoryFs().ops}),id=createCard(session,{parentId:null,content:'Text\n\n'+raw}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);let writes=0;
 const bounds=HTMLElement.prototype.getBoundingClientRect;HTMLElement.prototype.getBoundingClientRect=function(){return this.matches('.image-placement,[data-visual-object]')?new window.DOMRect(parseFloat(this.style.left)||0,parseFloat(this.style.top)||0,parseFloat(this.style.width)||80,parseFloat(this.style.height)||80):bounds.call(this);};
 const render=()=>root.render(createElement(PrototypeNote,{card:session.state.cards.get(id)!,add:()=>{},children:null,breadcrumb:null,send:async request=>{if(request.kind==='edit'){writes++;executeAction(session,request);render();}return {};}}));
 const pointer=(target:EventTarget,type:string,x:number,y:number,buttons:number)=>{const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons,clientX:x,clientY:y,screenX:x,screenY:y});Object.defineProperty(event,'pointerId',{value:7});target.dispatchEvent(event);};
 try{
  await act(async()=>render());await act(async()=>host.querySelector('.preview')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));const image=host.querySelector('[data-visual-editor] .image-placement[data-object-name="image_0"]');assert.ok(image);
  await act(async()=>{pointer(image,'pointerdown',50,60,1);pointer(document,'pointermove',80,80,1);pointer(document,'pointerup',80,80,0);});
  assert.ok(host.querySelector('.image-placement[data-object-name="image_0"]')===image,'the image frame is never replaced for text input');assert.equal(writes,1);
  const imageState=parseCardImages(session.state.cards.get(id)!.content)[0]!;assert.equal(imageState.layout,'overlay');assert.equal(imageState.x,50);assert.equal(imageState.y,50);
 }finally{await act(async()=>root.unmount());host.remove();HTMLElement.prototype.getBoundingClientRect=bounds;}
});
