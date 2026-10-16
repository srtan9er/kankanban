import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectDesktop} from '../src/webview/desktop.ts';
import {WorkspaceController} from '../src/webview/controller.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {emptyViewState} from '../src/core/view-state.ts';

type Call={command:string;args:Record<string,unknown>};
const flush=async()=>{for(let index=0;index<12;index++)await Promise.resolve();await new Promise<void>(resolve=>setImmediate(resolve));};
async function fixture(label:string,run:(f:{controller:WorkspaceController;calls:Call[];order:string[];press:(target:Element,button?:number)=>MouseEvent;raise:(handler:()=>Promise<void>)=>void;dispose:()=>void})=>Promise<void>){
 const globals=globalThis as unknown as Record<string,unknown>,record=window as unknown as Record<string,unknown>,previousGlobal=globals.__TAURI_INTERNALS__,previousWindow=record.__TAURI_INTERNALS__,previousEvents=record.__TAURI_EVENT_PLUGIN_INTERNALS__;
 const buffer=createBufferedFs(),session=openSession('/chain-press',{ops:buffer.ops}),id=createCard(session,{parentId:null,title:'Card',content:'Body'}),view=emptyViewState();view.extensions={git:{installed:false,enabled:false,config:{}}};
 const controller=new WorkspaceController(session,view,buffer,toAsync(createMemoryFs().ops)),callbacks=new Map<number,(event:unknown)=>void>(),listeners=new Map<number,{event:string;handler:number}>(),calls:Call[]=[],order:string[]=[];let serial=0,raise:()=>Promise<void>=async()=>{};
 const notify=(event:string,payload:unknown)=>{for(const entry of listeners.values())if(entry.event===event)callbacks.get(entry.handler)?.({payload});};
 const native={metadata:{currentWindow:{label}},transformCallback:(callback:(event:unknown)=>void)=>{callbacks.set(++serial,callback);return serial;},invoke:async(command:string,args:Record<string,unknown>={})=>{
  calls.push({command,args});
  if(command==='plugin:event|listen'){listeners.set(++serial,{event:args.event as string,handler:args.handler as number});return serial;}
  if(command==='plugin:event|unlisten'){listeners.delete(args.eventId as number);return;}
  if(command==='plugin:event|emit'){
   if(args.event==='kkb:v1:request'){const request=args.payload as {token:string;from:string};notify('kkb:v1:reply',{token:request.token,to:request.from,result:{},snapshot:controller.snapshot()});}
   else notify(args.event as string,args.payload);return;
  }
  if(command==='plugin:window|outer_position')return {x:100,y:200};
  if(command==='plugin:window|scale_factor')return 1;
  if(command==='raise_window_chain'){order.push('raise');return raise();}
  return {};
 }};
 globals.__TAURI_INTERNALS__=native;record.__TAURI_INTERNALS__=native;record.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 let connection:Awaited<ReturnType<typeof connectDesktop>>|undefined,disposed=false;
 const dispose=()=>{if(!disposed){disposed=true;connection?.dispose();}};
 try{
  connection=await connectDesktop(controller,label);assert.equal(controller.error,'');void id;
  await run({controller,calls,order,press:(target,button=0)=>{const event=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button,buttons:button===2?2:1});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);return event;},raise:handler=>{raise=handler;},dispose});
 }finally{
  dispose();await flush();
  for(const [object,key,value] of [[globals,'__TAURI_INTERNALS__',previousGlobal],[record,'__TAURI_INTERNALS__',previousWindow],[record,'__TAURI_EVENT_PLUGIN_INTERNALS__',previousEvents]] as const){if(value===undefined)delete object[key];else object[key]=value;}
 }
}

for(const label of ['card-parent__one','card-ext-git__one'])test(`${label} raises its chain at pointerdown capture even when inner controls stop propagation`,()=>fixture(label,async f=>{
 const surface=document.createElement('div');surface.innerHTML='<button>button</button><p contenteditable="true">body</p><img><table><tbody><tr><td>cell</td></tr></tbody></table><div class="doodle-layer"></div>';document.body.append(surface);
 const treeBefore=JSON.stringify([...f.controller.session.state.children]),eventsBefore=f.controller.session.events.length;
 try{
  for(const target of surface.querySelectorAll('button,p,img,td,.doodle-layer')){
   f.order.length=0;target.addEventListener('pointerdown',event=>{f.order.push('target');event.stopPropagation();});const event=f.press(target);await flush();
   assert.deepEqual(f.order,['raise','target']);assert.equal(event.defaultPrevented,false);
  }
  const presses=f.calls.filter(call=>call.command==='raise_window_chain');assert.equal(presses.length,5);assert.ok(presses.every(call=>Object.keys(call.args).length===0),'native receives the calling window implicitly, never a focus card or forged label');
  assert.equal(f.calls.some(call=>['begin_window_drag','move_note','cancel_window_drag','plugin:window|set_focus'].includes(call.command)),false);assert.equal(JSON.stringify([...f.controller.session.state.children]),treeBefore);assert.equal(f.controller.session.events.length,eventsBefore);
  f.dispose();f.order.length=0;f.press(surface);await flush();assert.deepEqual(f.order,[]);assert.equal(f.calls.filter(call=>call.command==='raise_window_chain').length,5);
 }finally{surface.remove();}
}));

test('manager presses do not request card-chain layering',()=>fixture('main',async f=>{
 f.press(document.body);await flush();assert.equal(f.calls.some(call=>call.command==='raise_window_chain'),false);
}));

test('chain press failures are visible, while late failures after disposal do not mutate the controller',()=>fixture('card-parent__one',async f=>{
 f.raise(async()=>{throw new Error('native layering failed');});f.press(document.body,2);await flush();assert.match(f.controller.error,/native layering failed/);
 let reject!:(reason:Error)=>void;const pending=new Promise<void>((_,fail)=>{reject=fail;});f.raise(()=>pending);f.press(document.body);const before=f.controller.error;f.dispose();reject(new Error('obsolete layering failure'));await flush();assert.equal(f.controller.error,before);
}));
