import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {DrawingBody} from '../src/webview/DrawingBody.tsx';
import {EditMode} from '../src/webview/edit-mode.ts';
import type {Request} from '../src/webview/controller.ts';

Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},FileReader:window.FileReader,OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:[...text].length*8})};}}});
const rect=(x:number,y:number,width:number,height:number)=>({x,y,left:x,top:y,right:x+width,bottom:y+height,width,height,toJSON(){}} as DOMRect);

test('image and table insertion share one capsule and use the existing image import request',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);const requests:Request[]=[];
 try{
  await act(async()=>root.render(createElement(DrawingBody,{id:'card',content:'Keep my text',send:async request=>{requests.push(request);}})));
  const image=document.querySelector<HTMLButtonElement>('.image-create-button');assert.ok(image,'image insertion must be available beside table creation');
  assert.equal(image.parentElement,document.querySelector('.table-create-button')!.parentElement);
  const input=document.querySelector<HTMLInputElement>('.body-image-file-input')!;assert.ok(input);assert.equal(input.type,'file');assert.equal(input.multiple,true);assert.match(input.accept,/\.png/);assert.equal(input.hidden,true);
  let chooserOpened=false;input.click=()=>{chooserOpened=true;};await act(async()=>image.click());assert.equal(chooserOpened,true);
  Object.defineProperty(input,'files',{value:[new window.File(['image-data'],'first.png',{type:'image/png'}),new window.File(['more-data'],'second.webp',{type:'image/webp'})],configurable:true});
  await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,40));});
  assert.deepEqual(requests,[{kind:'images-import',id:'card',inputs:[{name:'first.png',base64:'aW1hZ2UtZGF0YQ=='},{name:'second.webp',base64:'bW9yZS1kYXRh'}]}]);
  assert.equal(input.value,'');
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('insertion tools disappear in browsing mode and invalid files never reach the writer',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);let editable=true;const requests:Request[]=[];
 const render=()=>root.render(createElement(EditMode.Provider,{value:{editable,busy:false}},createElement(DrawingBody,{id:'card',content:'text',send:async request=>{requests.push(request);}})));
 try{
  await act(async()=>render());const input=document.querySelector<HTMLInputElement>('.body-image-file-input');assert.ok(input,'file input must be provided');
  Object.defineProperty(input,'files',{value:[new window.File(['text'],'secret.txt',{type:'text/plain'})],configurable:true});
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));assert.equal(requests.length,0);assert.match(host.querySelector('[role=alert]')!.textContent!,/PNG/);
  editable=false;await act(async()=>render());assert.equal(document.querySelector('.image-create-button'),null);assert.equal(document.querySelector('.table-create-button'),null);assert.equal(document.querySelector('.ink-pill'),null);
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('floating body tools stay inside the body border box and reserve the resize square',async()=>{
 const host=document.createElement('div'),root=createRoot(host);host.className='preview';host.getBoundingClientRect=()=>rect(10,20,300,200);document.body.append(host);
 try{
  await act(async()=>root.render(createElement(DrawingBody,{id:'card',content:'text',send:async()=>{}})));
  const toolbar=document.querySelector<HTMLElement>('.viewport-ink-toolbar')!;
  await act(async()=>window.dispatchEvent(new Event('resize')));
  assert.equal(toolbar.style.position,'fixed');assert.equal(toolbar.style.left,'286px');assert.equal(toolbar.style.top,'196px');
  const before={left:toolbar.style.left,top:toolbar.style.top};host.scrollTop=500;host.scrollLeft=250;await act(async()=>host.dispatchEvent(new Event('scroll')));assert.deepEqual({left:toolbar.style.left,top:toolbar.style.top},before);
  host.getBoundingClientRect=()=>rect(10,20,500,300);await act(async()=>window.dispatchEvent(new Event('resize')));
  assert.equal(toolbar.style.left,'486px');assert.equal(toolbar.style.top,'296px');
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('the body shell can host an editor while insertion actions keep its own selection logic',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);let tableCalls=0,prepareCalls=0;const images:unknown[]=[];
 try{
  await act(async()=>root.render(createElement(DrawingBody,{id:'card',content:'stored source',renderBody:createElement('div',{'data-test-editor':true},'Editing here'),extraTools:createElement('button',{'data-test-mode':true},'mode'),onInsertTable:()=>{tableCalls++;},onInsertImages:inputs=>{images.push(...inputs);},prepare:async()=>{prepareCalls++;},send:async()=>{throw new Error('overridden insertion must not append to stored source');}})));
  assert.equal(host.querySelector('[data-test-editor]')?.textContent,'Editing here');assert.ok(!host.textContent?.includes('stored source'));assert.ok(document.querySelector('.viewport-ink-toolbar [data-test-mode]'));
  await act(async()=>document.querySelector<HTMLButtonElement>('.table-create-button')!.click());assert.equal(tableCalls,1);assert.equal(prepareCalls,0,'the editor owns its insertion and caret preparation');
  const input=document.querySelector<HTMLInputElement>('.body-image-file-input')!;Object.defineProperty(input,'files',{value:[new window.File(['bytes'],'photo.png',{type:'image/png'})],configurable:true});
  await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,40));});assert.deepEqual(images,[{name:'photo.png',base64:'Ynl0ZXM='}]);assert.equal(prepareCalls,0);
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('the file picker captures selection before opening and keeps the editor protected until cancel or file change',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);const calls:string[]=[];let imported=0;
 try{
  await act(async()=>root.render(createElement(DrawingBody,{id:'card',content:'text',beforeImagePick:()=>{calls.push('capture');},onInsertImages:()=>{imported++;},send:async()=>{}})));
  const input=document.querySelector<HTMLInputElement>('.body-image-file-input')!,button=document.querySelector<HTMLButtonElement>('.image-create-button')!;
  input.click=()=>{calls.push('open');assert.ok(document.documentElement.dataset.bodyFileDialog,'the blur guard must be installed before the system dialog opens');window.dispatchEvent(new Event('blur'));};
  await act(async()=>button.click());assert.deepEqual(calls,['capture','open']);assert.ok(document.documentElement.dataset.bodyFileDialog);
  await act(async()=>input.dispatchEvent(new Event('cancel')));assert.equal(document.documentElement.dataset.bodyFileDialog,undefined);assert.equal(imported,0);
  await act(async()=>button.click());Object.defineProperty(input,'files',{value:[new window.File(['bytes'],'photo.png',{type:'image/png'})],configurable:true});
  await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,40));});assert.equal(document.documentElement.dataset.bodyFileDialog,undefined);assert.equal(imported,1);
 }finally{await act(async()=>root.unmount());host.remove();delete document.documentElement.dataset.bodyFileDialog;}
});

test('picker protection clears on returning focus or unmount without swallowing the selected files',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);let imported=0;
 try{
  await act(async()=>root.render(createElement(DrawingBody,{id:'card',content:'text',onInsertImages:()=>{imported++;},send:async()=>{}})));
  const input=document.querySelector<HTMLInputElement>('.body-image-file-input')!,button=document.querySelector<HTMLButtonElement>('.image-create-button')!;input.click=()=>undefined;
  await act(async()=>button.click());assert.ok(document.documentElement.dataset.bodyFileDialog);
  await act(async()=>{window.dispatchEvent(new Event('focus'));assert.ok(document.documentElement.dataset.bodyFileDialog,'focus must not synchronously clear the flag before a change event');await new Promise(resolve=>setTimeout(resolve,140));});assert.equal(document.documentElement.dataset.bodyFileDialog,undefined);
  Object.defineProperty(input,'files',{value:[new window.File(['bytes'],'photo.png',{type:'image/png'})],configurable:true});
  await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,40));});assert.equal(imported,1,'a late change still inserts files after the focus cleanup');
  await act(async()=>button.click());assert.ok(document.documentElement.dataset.bodyFileDialog);await act(async()=>root.unmount());assert.equal(document.documentElement.dataset.bodyFileDialog,undefined);
 }finally{await act(async()=>root.unmount());host.remove();delete document.documentElement.dataset.bodyFileDialog;}
});
