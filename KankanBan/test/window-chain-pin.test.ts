import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {PrototypeNote} from '../src/webview/PrototypeNote.tsx';
import {ExtensionWindow} from '../src/webview/ExtensionWindow.tsx';
import {WorkspaceController} from '../src/webview/controller.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {emptyViewState} from '../src/core/view-state.ts';
import {uiText} from '../src/i18n/text.ts';
Object.assign(globalThis,{CustomEvent:window.CustomEvent,ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
type Preferences={collapsed:boolean;pinned:boolean};
async function fixture({extension=false,pinned=false,deferInitial=false,deferMode=false}={}){
 const globalRecord=globalThis as unknown as Record<string,unknown>,windowRecord=window as unknown as Record<string,unknown>,previousGlobal=globalRecord.__TAURI_INTERNALS__,previousWindow=windowRecord.__TAURI_INTERNALS__,previousEvents=windowRecord.__TAURI_EVENT_PLUGIN_INTERNALS__;
 const label=extension?'card-ext-missing__one':'card-test__one',callbacks=new Map<number,(event:unknown)=>void>(),listeners=new Map<string,{handler:number;target:unknown}>(),removed:string[]=[];let sequence=0,initialReply:((value:Preferences)=>void)|undefined,modeReply:(()=>void)|undefined;
 const bridge={metadata:{currentWindow:{label},currentWebview:{label}},transformCallback:(callback:(event:unknown)=>void)=>{callbacks.set(++sequence,callback);return sequence;},invoke:async(command:string,args:Record<string,unknown>={})=>{
  if(command==='window_preferences'){if(deferInitial)return new Promise<Preferences>(resolve=>{initialReply=resolve;});return {collapsed:false,pinned};}
  if(command==='set_note_mode'&&deferMode)return new Promise<void>(resolve=>{modeReply=resolve;});
  if(command==='plugin:event|listen'){listeners.set(String(args.event),{handler:Number(args.handler),target:args.target});return Number(args.handler);}
  if(command==='plugin:event|unlisten'){removed.push(String(args.event));return;}
  return null;
 }};globalRecord.__TAURI_INTERNALS__=bridge;windowRecord.__TAURI_INTERNALS__=bridge;windowRecord.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const buffer=createBufferedFs(),session=openSession('/chain-pin',{ops:buffer.ops}),id=createCard(session,{parentId:null,title:'Title',content:'Body'}),controller=new WorkspaceController(session,emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);let mounted=true;
 await act(async()=>root.render(extension?createElement(ExtensionWindow,{controller,windowId:'ext-missing__one',send:async()=>({}),close:()=>{},startDrag:undefined}):createElement(PrototypeNote,{card:session.state.cards.get(id)!,send:async()=>({}),add:()=>{},children:null,breadcrumb:null})));
 return {host,label,listeners,removed,unmount:async()=>{await act(async()=>root.unmount());mounted=false;},notify:async(value:unknown)=>act(async()=>callbacks.get(listeners.get('kkb:window-chain-pin')?.handler??-1)?.({payload:value})),reply:async(value:Preferences)=>act(async()=>initialReply?.(value)),finishMode:async()=>act(async()=>modeReply?.()),close:async()=>{if(mounted)await act(async()=>root.unmount());host.remove();for(const [record,key,value] of [[globalRecord,'__TAURI_INTERNALS__',previousGlobal],[windowRecord,'__TAURI_INTERNALS__',previousWindow],[windowRecord,'__TAURI_EVENT_PLUGIN_INTERNALS__',previousEvents]] as const){if(value===undefined)delete record[key];else record[key]=value;}}};
}

for(const extension of [false,true])test(`${extension?'extension':'card'} pin controls follow only their scoped native chain event and unregister on dispose`,async()=>{
 const f=await fixture({extension});try{
  const pin=f.host.querySelector<HTMLButtonElement>('.pin')!;assert.equal(pin.classList.contains('off'),true);assert.equal(pin.title,uiText('webview/PrototypeNote.text007'));
  if(!extension)await act(async()=>f.host.querySelector<HTMLInputElement>('.title')!.click());const title=f.host.querySelector<HTMLInputElement>('.title')!,wasReadOnly=title.readOnly,content=f.host.querySelector('.card-regions');
  await f.notify({pinned:true});assert.equal(pin.classList.contains('off'),false);assert.equal(pin.title,uiText('webview/PrototypeNote.text006'));assert.equal(title.readOnly,wasReadOnly,'pin synchronization must not exit text editing');assert.ok(f.host.querySelector('.card-regions')===content);
  assert.deepEqual(f.listeners.get('kkb:window-chain-pin')!.target,{kind:'Window',label:f.label},'an unrelated chain must not update this window');
  await f.notify({pinned:false});assert.equal(pin.classList.contains('off'),true);await f.notify({pinned:'invalid'});assert.equal(pin.classList.contains('off'),true);
  await f.unmount();assert.ok(f.removed.includes('kkb:window-chain-pin'));assert.ok(f.removed.includes('kkb:window-activated'));
 }finally{await f.close();}
});

test('a late initial preference reply cannot overwrite a newer chain pin event',async()=>{
 const f=await fixture({deferInitial:true});try{const pin=f.host.querySelector<HTMLButtonElement>('.pin')!;await f.notify({pinned:true});await f.reply({collapsed:false,pinned:false});assert.equal(pin.classList.contains('off'),false);}finally{await f.close();}
});

test('the ordinary initial native pin preference still populates its button',async()=>{
 const f=await fixture({pinned:true});try{assert.equal(f.host.querySelector('.pin')!.classList.contains('off'),false);}finally{await f.close();}
});

test('a delayed local pin command cannot overwrite a newer native chain pin value',async()=>{
 const f=await fixture({deferMode:true});try{const pin=f.host.querySelector<HTMLButtonElement>('.pin')!;await act(async()=>pin.click());await f.notify({pinned:false});await f.finishMode();assert.equal(pin.classList.contains('off'),true);}finally{await f.close();}
});
