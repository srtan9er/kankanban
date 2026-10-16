import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {PrototypeNote} from '../src/webview/PrototypeNote.tsx';
import {openSession,createCard} from '../src/core/workspace.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {executeAction} from '../src/core/actions.ts';
import {uiText} from '../src/i18n/text.ts';
import {setMarkdownEditorSelection,readMarkdownEditor} from '../src/webview/markdown-editor-model.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});

async function fixture(beforeEdit?:()=>Promise<void>){
 const session=openSession('/body-mode',{ops:createMemoryFs().ops}),id=createCard(session,{parentId:null,title:'Title',content:'# Heading\n\n**Bold** text'}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 const render=()=>root.render(createElement(PrototypeNote,{card:session.state.cards.get(id)!,add:()=>{},children:null,breadcrumb:null,send:async request=>{if(request.kind==='edit'){await beforeEdit?.();executeAction(session,request);render();}return {};}}));
 await act(async()=>render());return {host,session,id,close:async()=>{await act(async()=>root.unmount());host.remove();}};
}
const modeButton=()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!;

for(const mode of ['visual','source'] as const)test(`right press saves and ends ${mode} input without changing its body surface or starting a window gesture`,async()=>{
 const f=await fixture(),pane=f.host.querySelector<HTMLElement>('.card-body-editor')!;try{
  if(mode==='source')await act(async()=>modeButton().click());else await act(async()=>f.host.querySelector('strong')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  const editor=f.host.querySelector<HTMLElement>('[data-markdown-editor]')!;assert.equal(pane.dataset.bodyEditing,'true');
  const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> ' appended'}});await act(async()=>editor.dispatchEvent(paste));
  const before=f.session.state.cards.get(f.id)!.content;let leaked=0;const leak=()=>leaked++;editor.addEventListener('pointerdown',leak);
  const right=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:2,buttons:2});await act(async()=>editor.dispatchEvent(right));
  assert.equal(pane.dataset.bodyEditing,'false');assert.equal(pane.dataset.editorMode,mode);assert.ok(f.host.querySelector('[data-markdown-editor]')===editor);assert.equal(right.defaultPrevented,true);assert.equal(leaked,0);
  assert.ok(f.session.state.cards.get(f.id)!.content.includes(' appended'));assert.notEqual(f.session.state.cards.get(f.id)!.content,before);
 }finally{await f.close();}
});

test('right press saves and ends title input even when the press is inside the title',async()=>{
 const f=await fixture();try{
  const title=f.host.querySelector<HTMLInputElement>('.title')!;await act(async()=>title.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.equal(title.readOnly,false);await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(title,'New title');title.dispatchEvent(new Event('input',{bubbles:true}));});
  const right=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:2,buttons:2});await act(async()=>title.dispatchEvent(right));
  assert.equal(title.readOnly,true);assert.equal(right.defaultPrevented,true);assert.equal(f.session.state.cards.get(f.id)!.title,'New title');
 }finally{await f.close();}
});

test('right exit during a field-switch save cancels the pending input activation',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),f=await fixture(()=>gate);try{
  const title=f.host.querySelector<HTMLInputElement>('.title')!;await act(async()=>title.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(title,'Saved title');title.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>modeButton().click());assert.equal(title.disabled,true);
  await act(async()=>title.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:2,buttons:2})));
  release();await act(async()=>gate);assert.equal(f.session.state.cards.get(f.id)!.title,'Saved title');assert.equal(f.host.querySelector<HTMLElement>('.card-body-editor')!.dataset.bodyEditing,'false');assert.equal(title.readOnly,true);assert.equal(modeButton().getAttribute('aria-pressed'),'true');
 }finally{release();await f.close();}
});

test('formatted body retains the exact reading layout DOM when editing starts and stops',async()=>{
 const f=await fixture();try{
  const flow=f.host.querySelector('.rich-image-flow'),heading=f.host.querySelector('h1'),strong=f.host.querySelector('strong');assert.ok(flow);assert.ok(heading);assert.ok(strong);
  await act(async()=>strong.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.ok(f.host.querySelector('[data-visual-editor]'));assert.ok(f.host.querySelector('.rich-image-flow')===flow,'text editing must reuse the reading renderer');assert.ok(f.host.querySelector('h1')===heading);assert.ok(f.host.querySelector('strong')===strong);
  await act(async()=>f.host.querySelector('.note-title-row')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0})));
  assert.ok(f.host.querySelector('.rich-image-flow')===flow,'leaving text input must not replace the formatted body');assert.ok(f.host.querySelector('h1')===heading);
 }finally{await f.close();}
});

test('source mode survives outside presses and window blur until its own button switches it',async()=>{
 const f=await fixture();try{
  await act(async()=>modeButton().click());const source=f.host.querySelector('[data-markdown-editor]:not([data-visual-editor])');assert.ok(source);
  await act(async()=>f.host.querySelector('.note-title-row')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0})));
  assert.ok(f.host.querySelector('[data-markdown-editor]:not([data-visual-editor])')===source,'pressing elsewhere must retain the source surface');
  assert.equal(modeButton().getAttribute('aria-label'),uiText('bodyEditor.visual'));assert.equal(modeButton().getAttribute('aria-pressed'),'true');
  await act(async()=>window.dispatchEvent(new Event('blur')));assert.ok(f.host.querySelector('[data-markdown-editor]:not([data-visual-editor])')===source);
  await act(async()=>modeButton().click());assert.equal(f.host.querySelector('[data-markdown-editor]:not([data-visual-editor])'),null);assert.ok(f.host.querySelector('.rich-image-flow'));assert.equal(modeButton().getAttribute('aria-pressed'),'false');
 }finally{await f.close();}
});

test('the first source keystroke after leaving input is saved and an immediate later Backspace removes that character',async()=>{
 const f=await fixture(),original=f.session.state.cards.get(f.id)!.content;try{
  await act(async()=>modeButton().click());const editor=f.host.querySelector<HTMLElement>('[data-markdown-editor]:not([data-visual-editor])')!;
  setMarkdownEditorSelection(editor,original.length);
  const outside=()=>f.host.querySelector('.note-title-row')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0}));
  await act(async()=>outside());assert.equal(editor.getAttribute('contenteditable'),'false');
  await act(async()=>editor.dispatchEvent(new KeyboardEvent('keydown',{key:'x',bubbles:true,cancelable:true})));
  assert.equal(readMarkdownEditor(editor),original+'x');await act(async()=>outside());assert.equal(f.session.state.cards.get(f.id)!.content,original+'x');
  await act(async()=>editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true})));
  assert.equal(readMarkdownEditor(editor),original);await act(async()=>outside());assert.equal(f.session.state.cards.get(f.id)!.content,original);assert.equal(modeButton().getAttribute('aria-pressed'),'true');
 }finally{await f.close();}
});
