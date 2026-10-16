import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {readFileSync} from 'node:fs';
import {WorkspaceApp} from '../src/webview/WorkspaceApp.tsx';
import {WorkspaceController} from '../src/webview/controller.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {emptyViewState} from '../src/core/view-state.ts';
import {setMarkdownEditorSelection,readMarkdownEditor} from '../src/webview/markdown-editor-model.ts';
import {uiText} from '../src/i18n/text.ts';
import {registerEditor} from '../src/webview/drafts.ts';

Object.assign(globalThis,{MutationObserver:window.MutationObserver,CustomEvent:window.CustomEvent,requestAnimationFrame:(callback:FrameRequestCallback)=>setTimeout(()=>callback(0),0),cancelAnimationFrame:clearTimeout,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
type NativeCall={command:string;args:Record<string,unknown>};
async function fixture(native=false,initialCollapsed=false,preferenceHeight=660){
 const globalRecord=globalThis as unknown as Record<string,unknown>,windowRecord=window as unknown as Record<string,unknown>,previousGlobal=globalRecord.__TAURI_INTERNALS__,previousWindow=windowRecord.__TAURI_INTERNALS__,previousEvents=windowRecord.__TAURI_EVENT_PLUGIN_INTERNALS__;
 const calls:NativeCall[]=[],callbacks=new Map<number,(event:unknown)=>void>(),eventHandlers=new Map<string,number>();let callbackId=0,preferences={collapsed:initialCollapsed,pinned:false,height:preferenceHeight},failMode=false,initialPreferences:((value:typeof preferences)=>void)|undefined;
 if(native){const bridge={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:(callback:(event:unknown)=>void)=>{callbacks.set(++callbackId,callback);return callbackId;},invoke:async(command:string,args:Record<string,unknown>={})=>{calls.push({command,args});if(command==='window_preferences'){if(initialCollapsed&&!initialPreferences)return new Promise<typeof preferences>(resolve=>{initialPreferences=resolve;});return {...preferences};}if(command==='set_note_mode'){if(failMode)throw new Error('native collapse failed');preferences={...preferences,collapsed:!!args.collapsed};}if(command==='plugin:event|listen'){eventHandlers.set(String(args.event),Number(args.handler));return Number(args.handler);}return null;}};globalRecord.__TAURI_INTERNALS__=bridge;windowRecord.__TAURI_INTERNALS__=bridge;windowRecord.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};}
 const buffer=createBufferedFs(),session=openSession('/manager-controls',{ops:buffer.ops}),id=createCard(session,{parentId:null,title:'Current card',content:'Initial'}),controller=new WorkspaceController(session,emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 const execute=controller.execute.bind(controller);controller.execute=(request,...args)=>request.kind==='tutorial'?Promise.resolve({createdId:id}):execute(request,...args);
 const host=document.createElement('div'),root=createRoot(host);host.id='root';document.body.append(host);let closes=0;
 await act(async()=>root.render(createElement(WorkspaceApp,{controller,close:()=>{closes++;}})));
 if(initialPreferences){host.querySelector<HTMLElement>('main')!.getBoundingClientRect=()=>new window.DOMRect(0,0,600,38);await act(async()=>initialPreferences!({...preferences}));}
 const openBody=async()=>{await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.manager-tabs button')].find(button=>button.textContent===uiText('webview/WorkspaceApp.text024'))!.click());await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.settings-card button')].find(button=>button.textContent===uiText('webview/WorkspaceApp.reviewTutorial'))!.click());};
 const click=async(selector:string)=>act(async()=>{const button=host.querySelector<HTMLButtonElement>(selector);assert.ok(button,`${selector} is present`);button.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1}));button.click();});
 return {host,controller,session,id,calls,get closes(){return closes;},openBody,click,setPreferences:(collapsed:boolean)=>{preferences={...preferences,collapsed};},failMode:()=>{failMode=true;},activate:async()=>act(async()=>callbacks.get(eventHandlers.get('kkb:window-activated')!)?.({payload:{label:'main'}})),close:async()=>{await act(async()=>root.unmount());host.remove();for(const [record,key,value] of [[globalRecord,'__TAURI_INTERNALS__',previousGlobal],[windowRecord,'__TAURI_INTERNALS__',previousWindow],[windowRecord,'__TAURI_EVENT_PLUGIN_INTERNALS__',previousEvents]] as const){if(value===undefined)delete record[key];else record[key]=value;}}};
}
async function editSource(f:Awaited<ReturnType<typeof fixture>>){await f.openBody();await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const editor=f.host.querySelector<HTMLDivElement>('[data-markdown-editor]:not([data-visual-editor])')!;setMarkdownEditorSelection(editor,7);const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> ' dirty'}});await act(async()=>editor.dispatchEvent(paste));return editor;}

test('manager browser fallback collapses only after saving and keeps source DOM, input state and scroll positions',async()=>{
 const f=await fixture();try{
  const editor=await editSource(f),pane=f.host.querySelector<HTMLElement>('.card-body-editor')!,main=f.host.querySelector<HTMLElement>('main')!;pane.scrollTop=91;pane.scrollLeft=17;main.getBoundingClientRect=()=>new window.DOMRect(0,0,600,480);const beforeTree=JSON.stringify([...f.session.state.children]);
  await f.click('.manager-collapse');const shell=f.host.querySelector<HTMLElement>('.manager-shell')!;assert.equal(shell.dataset.managerCollapsed,'true');assert.equal(f.session.state.cards.get(f.id)!.content,'Initial dirty');assert.ok(f.host.querySelector('[data-markdown-editor]')===editor);assert.equal(editor.getAttribute('contenteditable'),'true');assert.equal(pane.scrollTop,91);assert.equal(pane.scrollLeft,17);assert.equal(main.style.getPropertyValue('--manager-expanded-height'),'480px');assert.equal(JSON.stringify([...f.session.state.children]),beforeTree);assert.equal(f.closes,0);
  await f.click('.manager-collapse');assert.equal(shell.dataset.managerCollapsed,'false');assert.ok(f.host.querySelector('[data-markdown-editor]')===editor);assert.equal(readMarkdownEditor(editor),'Initial dirty');assert.equal(pane.scrollTop,91);assert.equal(editor.getAttribute('contenteditable'),'true');
  assert.equal(f.host.querySelector('.manager-window-controls')!.querySelectorAll('button').length,3);await f.click('.manager-minimize');assert.equal(f.closes,0);await f.click('.manager-close');assert.equal(f.closes,1);
 }finally{await f.close();}
});

test('failed editor persistence leaves the manager expanded with its recoverable source draft',async()=>{
 const f=await fixture();try{
  const execute=f.controller.execute.bind(f.controller);f.controller.execute=(request,...args)=>request.kind==='edit'?Promise.reject(new Error('save failed')):execute(request,...args);const editor=await editSource(f);await f.click('.manager-collapse');assert.equal(f.host.querySelector<HTMLElement>('.manager-shell')!.dataset.managerCollapsed,'false');assert.equal(readMarkdownEditor(editor),'Initial dirty');assert.equal(editor.getAttribute('contenteditable'),'true');assert.equal(f.session.state.cards.get(f.id)!.content,'Initial');assert.match(f.host.querySelector('[role=alert]')!.textContent!,/save failed/);
 }finally{await f.close();}
});

test('native minimization waits for editor preparation and flush, never calling the main close callback',async()=>{
 const f=await fixture(true),order:string[]=[],prepare=(event:Event)=>registerEditor(event,Promise.resolve().then(()=>{order.push('prepared');}));document.addEventListener('kkb:prepare-close',prepare);try{
  const flush=f.controller.flush.bind(f.controller);f.controller.flush=async()=>{order.push('flush');await flush();};await f.click('.manager-minimize');assert.deepEqual(order,['prepared','flush']);assert.equal(f.calls.filter(call=>call.command==='minimize_note').length,1);assert.equal(f.calls.filter(call=>call.command==='set_note_mode').length,0);assert.equal(f.closes,0);
 }finally{document.removeEventListener('kkb:prepare-close',prepare);await f.close();}
});

test('manager native collapse and activation synchronize preferences and surface native failure',async()=>{
 const f=await fixture(true);try{
  const shell=f.host.querySelector<HTMLElement>('.manager-shell')!;assert.equal(shell.dataset.managerCollapsed,'false');await f.click('.manager-collapse');assert.equal(shell.dataset.managerCollapsed,'true');assert.deepEqual(f.calls.filter(call=>call.command==='set_note_mode').map(call=>call.args),[{collapsed:true}]);f.setPreferences(false);await f.activate();assert.equal(shell.dataset.managerCollapsed,'false');f.failMode();await f.click('.manager-collapse');assert.equal(shell.dataset.managerCollapsed,'false');assert.match(f.host.querySelector('[role=alert]')!.textContent!,/native collapse failed/);
 }finally{await f.close();}
});

test('initial native collapsed preferences are honored and focus resynchronizes an external expansion',async()=>{
 const f=await fixture(true,true);try{
  const shell=f.host.querySelector<HTMLElement>('.manager-shell')!,content=f.host.querySelector('.manager-home');assert.equal(shell.dataset.managerCollapsed,'true');assert.ok(content);assert.equal(f.host.querySelector('.manager-collapse')!.getAttribute('aria-label'),uiText('windowControls.expand'));assert.equal(f.host.querySelector<HTMLElement>('main')!.style.getPropertyValue('--manager-expanded-height'),'660px','initially hidden layout uses saved expanded height, not the current 38px native size');
  f.setPreferences(false);await act(async()=>window.dispatchEvent(new Event('focus')));assert.equal(shell.dataset.managerCollapsed,'false');assert.ok(f.host.querySelector('.manager-home')===content);assert.equal(f.calls.filter(call=>call.command==='set_note_mode').length,0,'reading native preferences must not rewrite them');
 }finally{await f.close();}
});

test('initial manager preferences never freeze layout with a nonfinite or collapsed height',async()=>{
 for(const height of [NaN,Infinity,38]){const f=await fixture(true,true,height);try{assert.equal(f.host.querySelector<HTMLElement>('main')!.style.getPropertyValue('--manager-expanded-height'),'');}finally{await f.close();}}
});

test('collapsed manager keeps its mounted content clipped behind a 38px themed header and hides portaled tools',()=>{
 const css=readFileSync(new URL('../src/webview/workspace.css',import.meta.url),'utf8');assert.ok(/manager-shell\[data-manager-collapsed(?:="true"|=true)\][^{]*\{[^}]*height:\s*38px/.test(css),'the collapsed shell is a 38px strip');assert.ok(/data-manager-collapsed[^}]*visibility:\s*hidden/.test(css),'content is hidden without unmounting');assert.ok(/manager-expanded-height/.test(css),'expanded layout height remains locked');assert.ok(/data-manager-collapsed[^}]*\.viewport-ink-toolbar[^}]*visibility:\s*hidden/.test(css),'portaled tools hide with the manager');
});
