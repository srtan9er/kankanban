import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {PrototypeNote} from '../src/webview/PrototypeNote.tsx';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import type {Request} from '../src/webview/controller.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:(time:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id)});
test('the ordinary card body saves full image tags and exits its atomic editor through the same draft state',async()=>{
 const tag=`<image src="../assets/images/${'a'.repeat(64)}.png" layout="inline" width="160" height="80">photo</image>`,content=`before ${tag} after`;
 const s=openSession('/editor-integration',{ops:createMemoryFs().ops}),id=createCard(s,{parentId:null,title:'Card',content}),card=s.state.cards.get(id)!,requests:Request[]=[],host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{
  await act(async()=>root.render(createElement(PrototypeNote,{card,send:async request=>{requests.push(request);return {};},children:null,breadcrumb:createElement('span',null,'parent'),add:()=>undefined})));
  await act(async()=>host.querySelector<HTMLElement>('.rich-text-paragraph')!.click());
  const editor=host.querySelector<HTMLElement>('[data-markdown-editor]')!;assert.ok(editor);assert.equal(editor.querySelector('[data-markdown-token]')?.textContent,'<image_0>');assert.equal(host.querySelector('textarea.content'),null);
  await act(async()=>{editor.append(document.createTextNode(' updated'));editor.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>host.querySelector('.note-breadcrumb')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0})));
  const edits=requests.filter(request=>request.kind==='edit');assert.equal(edits.length,1);assert.ok(edits[0]?.kind==='edit');assert.equal(edits[0].value,content+' updated');assert.equal(edits[0].before,content);assert.equal(host.querySelector('[data-markdown-editor]'),null);
 }finally{await act(async()=>root.unmount());host.remove();}
});
