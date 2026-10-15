import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceApp} from '../src/webview/WorkspaceApp.tsx';
import {WorkspaceController} from '../src/webview/controller.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession} from '../src/core/workspace.ts';
import {emptyViewState} from '../src/core/view-state.ts';
import {uiText} from '../src/i18n/text.ts';
import {ExtensionManager} from '../src/webview/ExtensionManager.tsx';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:(time:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id)});
test('Enter in extension configuration or controls does not open a window',async()=>{
 const buffer=createBufferedFs(),c=new WorkspaceController(openSession('/ext-keys',{ops:buffer.ops}),emptyViewState(),buffer,toAsync(createMemoryFs().ops)),host=document.createElement('div'),root=createRoot(host);let opened=0;
 try{await act(async()=>root.render(createElement(ExtensionManager,{controller:c,send:async()=>{},open:()=>{opened++;}})));const buttons=[...host.querySelectorAll('button')];await act(async()=>buttons.find(b=>b.textContent===uiText('extensions.configure'))!.click());
 for(const element of [host.querySelector('textarea')!,buttons[0]!])await act(async()=>{element.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
 assert.equal(opened,0);await act(async()=>{host.querySelector('article')!.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});assert.equal(opened,1);
 }finally{await act(async()=>root.unmount());}
});
test('extensions tab replaces Git navigation and double clicks create separate extension windows',async()=>{
 const buffer=createBufferedFs(),session=openSession('/ext-ui',{ops:buffer.ops}),c=new WorkspaceController(session,emptyViewState(),buffer,toAsync(createMemoryFs().ops)),host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{await act(async()=>root.render(createElement(WorkspaceApp,{controller:c})));const tabs=[...host.querySelectorAll<HTMLButtonElement>('.manager-tabs button')];assert.ok(!tabs.some(b=>b.textContent==='Git'));await act(async()=>tabs.find(b=>b.textContent===uiText('extensions.tab'))!.click());const entry=host.querySelector('.extension-list .task-card')!;assert.ok(entry.textContent?.includes('Git'));await act(async()=>{entry.dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true}));});await act(async()=>{entry.dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true}));});assert.equal(c.view.openWindows.filter(id=>id.startsWith('ext-git__')).length,2);assert.ok(!session.state.cards.has('ext-git'));}finally{await act(async()=>root.unmount());host.remove();}
});
