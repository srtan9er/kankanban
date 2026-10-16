import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CardBodyEditor} from '../src/webview/CardBodyEditor.tsx';
import {getVisualEditorSelection,setVisualEditorSelection} from '../src/webview/VisualBodyEditor.tsx';
import {getMarkdownEditorRange} from '../src/webview/markdown-editor-model.ts';
import type {Request} from '../src/webview/controller.ts';
import type {CardImage} from '../src/core/types.ts';
import {useImageInput,type ImageInsertion} from '../src/webview/useImageInput.ts';

Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},FileReader:window.FileReader,OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
// JSDOM has no Range geometry; pixel positions have separate focused tests.
Object.defineProperties(window.Range.prototype,{getClientRects:{configurable:true,value:()=>[]},getBoundingClientRect:{configurable:true,value:()=>new window.DOMRect()}});
const images:CardImage[]=[];

test('rich formatting, source toggles and insertion retain the actual source selection',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);let value='Before **middle** after';
 function Harness(){const [text,setText]=useState(value),editor=useRef<HTMLDivElement>(null);return createElement(CardBodyEditor,{id:'card',content:text,images,editing:true,editorRef:editor,onChange:next=>{value=next;setText(next);},onBlur:()=>{},onRequestEdit:()=>{},flush:async()=>{},prepare:async()=>{},send:async()=>{}});}
 try{
  await act(async()=>root.render(createElement(Harness)));let visual=host.querySelector<HTMLElement>('[data-visual-editor]')!;
  const start=value.indexOf('middle'),end=start+6;setVisualEditorSelection(visual,start,end);
  await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());
  const source=host.querySelector<HTMLElement>('[data-markdown-editor]')!;assert.deepEqual(getMarkdownEditorRange(source),{start,end,backward:false,inside:true});
  await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());visual=host.querySelector<HTMLElement>('[data-visual-editor]')!;
  assert.equal(getVisualEditorSelection(visual).offset,start);assert.equal(getVisualEditorSelection(visual).end,end);
  await act(async()=>visual.dispatchEvent(new KeyboardEvent('keydown',{key:'i',ctrlKey:true,bubbles:true,cancelable:true})));
  assert.equal(visual.querySelector('strong em,em strong')?.textContent,'middle');assert.ok(value.includes('***middle***'));
  setVisualEditorSelection(visual,value.length);
  await act(async()=>document.querySelector<HTMLButtonElement>('.table-create-button')!.click());
  assert.ok(value.startsWith('Before ***middle*** after'));assert.ok(value.includes('name="table_0"'));assert.equal(host.querySelectorAll('[data-visual-editor] [data-table-cell]').length,4);
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('choosing an image from disk inserts at the rich editor caret after source formatting',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);const value='Before **middle** after',requests:Request[]=[];let flushes=0;
 function Harness(){const editor=useRef<HTMLDivElement>(null);return createElement(CardBodyEditor,{id:'card',content:value,images,editing:true,editorRef:editor,onChange:()=>{},onBlur:()=>{},onRequestEdit:()=>{},flush:async()=>{flushes++;},prepare:async()=>{},send:async request=>{requests.push(request);}});}
 try{
  await act(async()=>root.render(createElement(Harness)));const visual=host.querySelector<HTMLElement>('[data-visual-editor]')!,offset=value.indexOf('middle')+3;setVisualEditorSelection(visual,offset);
  const input=document.querySelector<HTMLInputElement>('.body-image-file-input')!;input.click=()=>{};
  await act(async()=>document.querySelector<HTMLButtonElement>('.image-create-button')!.click());
  setVisualEditorSelection(visual,0); // Native chooser focus changes must not replace the captured insertion point.
  Object.defineProperty(input,'files',{value:[new window.File(['image-bytes'],'test.png',{type:'image/png'})],configurable:true});
  await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,40));});
  assert.equal(flushes,1);assert.deepEqual(requests,[{kind:'images-import',id:'card',inputs:[{name:'test.png',base64:'aW1hZ2UtYnl0ZXM='}],beforeContent:value,offset}]);
  assert.ok(host.querySelector('[data-visual-editor]'),'the file chooser must retain text editing');
 }finally{await act(async()=>root.unmount());host.remove();}
});

test('pasting a screenshot in formatted text uses the canonical Markdown caret and import payload',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);const value='**Bold** text';let position:ImageInsertion|undefined,changes=0;
 function Harness(){const editor=useRef<HTMLDivElement>(null);useImageInput(true,async(_inputs,at)=>{position=at;},error=>{throw new Error(error);});return createElement(CardBodyEditor,{id:'card',content:value,images,editing:true,editorRef:editor,onChange:()=>{changes++;},onBlur:()=>{},onRequestEdit:()=>{},flush:async()=>{},prepare:async()=>{},send:async()=>{}});}
 try{
  await act(async()=>root.render(createElement(Harness)));const visual=host.querySelector<HTMLElement>('[data-visual-editor]')!,offset=value.indexOf('text')+2;setVisualEditorSelection(visual,offset);
  const paste=new Event('paste',{bubbles:true,cancelable:true}),file=new window.File(['bytes'],'screenshot.png',{type:'image/png'});
  Object.defineProperty(paste,'clipboardData',{value:{items:[{kind:'file',type:'image/png',getAsFile:()=>file}],getData:()=>''}});
  await act(async()=>{visual.dispatchEvent(paste);await new Promise(resolve=>setTimeout(resolve,40));});
  assert.deepEqual(position,{beforeContent:value,offset});assert.equal(changes,0);assert.equal(paste.defaultPrevented,true);
 }finally{await act(async()=>root.unmount());host.remove();}
});
