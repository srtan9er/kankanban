import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {Markdown} from '../src/webview/Markdown.tsx';
import {parseTables,serializeTable} from '../src/core/table-markdown.ts';
import type {Request} from '../src/webview/controller.ts';

Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:(time:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id),OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
const image=`<image src="../assets/images/${'a'.repeat(64)}.png" name="image_0" layout="float" width="160" height="80" x="20" y="30">picture</image>`,table='| A | B |\n| --- | --- |\n| C | D |';
function pointer(target:EventTarget,type:string,button=0,x=40,y=40){const event=new MouseEvent(type,{bubbles:true,cancelable:true,button,buttons:type==='pointerup'?0:button===2?2:1,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);return event;}
async function fixture(text:string,run:(f:{host:HTMLElement;pane:HTMLElement;content:()=>string;requests:Request[];rightDrags:()=>number;rightMoves:()=>number;fail:(value:boolean)=>void})=>Promise<void>){
 const host=document.createElement('div'),root=createRoot(host),requests:Request[]=[];document.body.append(host);let content=text,drags=0,moves=0,failing=false;
 const render=()=>root.render(createElement('div',{className:'preview',onPointerDownCapture:(event:{button:number})=>{if(event.button===2)drags++;},onPointerMoveCapture:(event:{buttons:number})=>{if(drags && event.buttons===2)moves++;}},createElement(Markdown,{text:content,images:[],id:'card',send:async(request:Request)=>{requests.push(request);if(failing)throw new Error('cell save failed');if(request.kind==='edit'){content=request.value;render();}}})));
 try{await act(async()=>render());await run({host,pane:host.querySelector<HTMLElement>('.preview')!,content:()=>content,requests,rightDrags:()=>drags,rightMoves:()=>moves,fail:value=>{failing=value;}});}finally{await act(async()=>root.unmount());host.remove();}
}
const selectImage=async(host:HTMLElement)=>act(async()=>host.querySelector<HTMLElement>('.image-placement')!.click());
const editCell=async(host:HTMLElement)=>act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());
const changeCell=async(host:HTMLElement,value:string)=>act(async()=>{const editor=host.querySelector<HTMLTextAreaElement>('.table-cell-editor')!;Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(editor,value);editor.dispatchEvent(new Event('input',{bubbles:true}));});

for(const location of ['object','blank'] as const)test(`right press on ${location} exits image editing and immediately reaches the window drag capture`,()=>fixture(image,async f=>{
 await selectImage(f.host);assert.ok(f.host.querySelector('.image-layout-toolbar'));let event!:MouseEvent;
 await act(async()=>{event=pointer(location==='object'?f.host.querySelector('.image-placement')!:f.pane,'pointerdown',2);});
 assert.ok(!f.host.querySelector('.image-layout-toolbar'));assert.equal(f.host.querySelector<HTMLElement>('.image-placement')!.dataset.selected,'false');assert.equal(event.defaultPrevented,true);assert.equal(f.rightDrags(),1);await act(async()=>pointer(f.pane,'pointermove',2,90,100));assert.equal(f.rightMoves(),1,'the same right gesture continues after object editing ends');assert.equal(f.requests.length,0);assert.equal(f.content(),image);
}));
for(const resize of [false,true])test(`right press cancels an active image ${resize?'resize':'move'} without a later pointer-up save`,()=>fixture(image,async f=>{
 await selectImage(f.host);const frame=f.host.querySelector<HTMLElement>('.image-placement')!,target=resize?f.host.querySelector('.image-resize-grip')!:frame;
 await act(async()=>{pointer(target,'pointerdown',0,40,40);pointer(window,'pointermove',0,100,110);});assert.equal(f.requests.length,0);assert.ok(f.host.querySelector('[data-object-drag-paper]'));
 await act(async()=>pointer(f.pane,'pointerdown',2,100,110));assert.ok(!f.host.querySelector('.image-layout-toolbar'));assert.ok(!f.host.querySelector('.image-resizing'));assert.ok(!f.host.querySelector('[data-object-drag-paper]'));assert.equal(frame.dataset.dragging,'false');
 await act(async()=>{pointer(window,'pointermove',0,180,190);pointer(window,'pointerup',0,180,190);frame.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0,detail:1}));});assert.ok(!f.host.querySelector('.image-layout-toolbar'),'the interrupted left release cannot re-enter object editing');assert.equal(f.requests.length,0);assert.equal(f.content(),image);assert.equal(f.rightDrags(),1);
}));
test('right press saves a dirty table cell, blurs it and closes all object tools',()=>fixture(table,async f=>{
 await editCell(f.host);await changeCell(f.host,'Saved cell');const editor=f.host.querySelector<HTMLTextAreaElement>('.table-cell-editor')!;editor.focus();let event!:MouseEvent;
 await act(async()=>{event=pointer(editor,'pointerdown',2);});assert.ok(!f.host.querySelector('.table-cell-editor'));assert.ok(!f.host.querySelector('.table-tools,.image-layout-toolbar'));assert.ok(document.activeElement!==editor);assert.equal(parseTables(f.content())[0]!.data.cells[0]!.text,'Saved cell');assert.equal(f.requests.length,1);assert.equal(event.defaultPrevented,true);assert.equal(f.rightDrags(),1);
}));
test('a failed cell save retains the dirty editor and can retry with another right press',()=>fixture(table,async f=>{
 await editCell(f.host);await changeCell(f.host,'Keep my draft');f.fail(true);const editor=f.host.querySelector<HTMLTextAreaElement>('.table-cell-editor')!;
 await act(async()=>pointer(editor,'pointerdown',2));assert.ok(f.host.querySelector('.table-cell-editor')===editor);assert.equal(editor.value,'Keep my draft');assert.equal(f.host.querySelector<HTMLElement>('.image-placement')!.dataset.selected,'true');assert.ok(f.host.querySelector('[role=alert]')?.textContent?.includes('cell save failed'));assert.equal(f.content(),table);assert.equal(f.rightDrags(),1);
 f.fail(false);await act(async()=>pointer(editor,'pointerdown',2));assert.ok(!f.host.querySelector('.table-cell-editor'));assert.ok(!f.host.querySelector('.table-tools'));assert.equal(parseTables(f.content())[0]!.data.cells[0]!.text,'Keep my draft');assert.equal(f.rightDrags(),2);
}));
test('right press cancels a table track resize and preserves its saved dimensions',()=>fixture(table,async f=>{
 await editCell(f.host);const grip=f.host.querySelector('.table-column-grip')!;await act(async()=>{pointer(grip,'pointerdown',0,80,20);pointer(window,'pointermove',0,130,20);});assert.equal(f.requests.length,0);
 await act(async()=>pointer(f.pane,'pointerdown',2));assert.ok(!f.host.querySelector('.table-tools'));assert.ok(!f.host.querySelector('[data-object-drag-paper]'));
 await act(async()=>pointer(window,'pointerup',0,130,20));assert.equal(f.requests.length,0);assert.deepEqual(parseTables(f.content())[0]!.data.columns,[80,80]);assert.equal(f.rightDrags(),1);
}));
test('right press after a saved object edit preserves that saved content',()=>fixture(image,async f=>{
 await selectImage(f.host);await act(async()=>{pointer(f.host.querySelector('.image-resize-grip')!,'pointerdown',0,160,80);pointer(window,'pointermove',0,190,110);pointer(window,'pointerup',0,190,110);});assert.equal(f.requests.length,1);const saved=f.content();assert.notEqual(saved,image);
 await act(async()=>pointer(f.pane,'pointerdown',2));assert.ok(!f.host.querySelector('.image-layout-toolbar'));assert.equal(f.requests.length,1);assert.equal(f.content(),saved);
}));
for(const kind of ['image','table'] as const)for(const layout of ['inline','float'] as const)test(`${kind} in ${layout} keeps its anchor when right press on ${layout==='inline'?'title':'children'} exits`,()=>{
 const content=kind==='image'?image.replace('layout="float"',`layout="${layout}"`):serializeTable(parseTables(table)[0]!,{layout,x:20,y:30});
 return fixture(content,async f=>{
  if(kind==='image')await selectImage(f.host);else await editCell(f.host);const frame=f.host.querySelector<HTMLElement>('.image-placement')!,parent=frame.parentElement!,before=[frame.style.left,frame.style.top,frame.style.width,frame.style.getPropertyValue('--image-height')];
  const outside=document.createElement('div');outside.className=layout==='inline'?'note-title-row':'note-children';let outsideActions=0;outside.addEventListener('pointerdown',()=>outsideActions++);f.host.append(outside);let event!:MouseEvent;
  await act(async()=>{event=pointer(outside,'pointerdown',2);});assert.equal(event.defaultPrevented,true);assert.equal(outsideActions,1);assert.ok(!f.host.querySelector('.image-layout-toolbar,.table-tools,.table-cell-editor'));assert.equal(frame.dataset.selected,'false');assert.ok(frame.parentElement===parent);assert.deepEqual([frame.style.left,frame.style.top,frame.style.width,frame.style.getPropertyValue('--image-height')],before);assert.equal(f.content(),content);assert.equal(f.requests.length,0);
 });
});
test('an unselected object does not consume an unrelated right drag on blank space',()=>fixture(image,async f=>{
 let event!:MouseEvent;await act(async()=>{event=pointer(f.pane,'pointerdown',2);});assert.equal(event.defaultPrevented,false);assert.equal(f.rightDrags(),1);assert.equal(f.requests.length,0);
}));
