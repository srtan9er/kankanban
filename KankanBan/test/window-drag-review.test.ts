import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectDesktopDrag} from '../src/webview/desktop-drag.ts';
import {connectWindowPositions,type PositionWindow} from '../src/webview/window-position-sync.ts';
import {WindowPositions} from '../src/webview/window-events.ts';
import type {DesktopBus} from '../src/webview/desktop-mirror.ts';

type Command={command:string;args:Record<string,unknown>};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();await new Promise<void>(resolve=>setImmediate(resolve));};
function pointer(type:string,x:number,y:number,buttons=type==='pointerup'?0:1){const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:1});document.dispatchEvent(event);}
async function fixture(run:(f:{press:(fixed?:boolean)=>void;commands:Command[];errors:string[];state:{fixed:boolean};mouse:(x:number,y:number)=>void;position:(x:number,y:number)=>void;onBegin:(handler:()=>Promise<void>|void)=>void;onFinish:(handler:()=>Promise<void>)=>void;originReads:{begun:boolean;x:number;y:number}[];originResets:{x:number;y:number}[];frame:()=>Promise<void>;dispose:()=>void})=>Promise<void>,failFinish=false){
 const globals=globalThis as unknown as Record<string,unknown>,record=window as unknown as Record<string,unknown>,keys=['__TAURI_INTERNALS__','requestAnimationFrame','cancelAnimationFrame'] as const,old=keys.map(key=>globals[key]),oldNative=record.__TAURI_INTERNALS__,oldEvents=record.__TAURI_EVENT_PLUGIN_INTERNALS__;
 const commands:Command[]=[],errors:string[]=[],frames=new Map<number,FrameRequestCallback>(),state={fixed:false},originReads:{begun:boolean;x:number;y:number}[]=[],originResets:{x:number;y:number}[]=[];let serial=0,point={x:500,y:600},position={x:100,y:200},begun=false,beforeBegin:(()=>Promise<void>|void)|undefined,beforeFinish:(()=>Promise<void>)|undefined;
 const native={metadata:{currentWindow:{label:'card-a'}},transformCallback:()=>++serial,invoke:async(command:string,args:Record<string,unknown>={})=>{commands.push({command,args});if(command==='begin_window_drag'){await beforeBegin?.();begun=true;}if(command==='plugin:event|listen')return ++serial;if(command==='plugin:window|cursor_position')return {...point};if(command==='drag_mouse_buttons')return null;if(command==='move_note'&&args.finish){await beforeFinish?.();if(failFinish)throw new Error('finish failed');}return {};}};
 globals.__TAURI_INTERNALS__=native;record.__TAURI_INTERNALS__=native;record.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};globals.requestAnimationFrame=(callback:FrameRequestCallback)=>{frames.set(++serial,callback);return serial;};globals.cancelAnimationFrame=(id:number)=>frames.delete(id);
 const target=document.createElement('div'),captured=new Set<number>();target.className='canvas-note';target.setPointerCapture=id=>{captured.add(id);};target.hasPointerCapture=id=>captured.has(id);target.releasePointerCapture=id=>{captured.delete(id);};document.body.append(target);
 const connection=await connectDesktopDrag({controller:{view:{}} as never,label:'card-a',window:{outerPosition:async()=>{originReads.push({begun,...position});return {...position};}} as never,windows:{} as never,request:async()=>({}),positionSync:{resetOrigin:(position:{x:number;y:number})=>{originResets.push(position);}} as never,dragState:state,clearCanvasDrag:()=>{},errorHandler:message=>errors.push(message)});
 const press=(fixed=true)=>connection.startDrag('a',{target,currentTarget:target,pointerId:1,clientX:10,clientY:10,button:0,buttons:1,stopPropagation:()=>{}} as never,fixed?'window-fixed':'window-desktop');
 try{await run({press,commands,errors,state,mouse:(x,y)=>{point={x,y};},position:(x,y)=>{position={x,y};},onBegin:handler=>{beforeBegin=handler;},onFinish:handler=>{beforeFinish=handler;},originReads,originResets,frame:async()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(0));await flush();},dispose:connection.dispose});}
 finally{connection.dispose();await flush();target.remove();document.documentElement.classList.remove('card-dragging');for(let i=0;i<keys.length;i++){if(old[i]===undefined)delete globals[keys[i]!];else globals[keys[i]!]=old[i];}if(oldNative===undefined)delete record.__TAURI_INTERNALS__;else record.__TAURI_INTERNALS__=oldNative;if(oldEvents===undefined)delete record.__TAURI_EVENT_PLUGIN_INTERNALS__;else record.__TAURI_EVENT_PLUGIN_INTERNALS__=oldEvents;}
}

test('fixed-mode press below threshold neither changes the compensation guard nor opens a native chain transaction',()=>fixture(async f=>{
 f.press();await flush();pointer('pointermove',15,10);await f.frame();pointer('pointerup',15,10);await flush();
 assert.equal(f.commands.some(call=>call.command==='begin_window_drag'),false);assert.equal(f.commands.some(call=>call.command==='move_note'),false);assert.equal(f.state.fixed,false,'an idle fixed-mode click must not suppress future canvas compensation');assert.deepEqual(f.errors,[]);
}));

test('actual desktop drag opens its chain only after six pixels and cancels the transaction on dispose',()=>fixture(async f=>{
 f.press(false);await flush();pointer('pointermove',15,10);await f.frame();assert.equal(f.commands.some(call=>call.command==='begin_window_drag'),false);
 f.mouse(520,630);pointer('pointermove',16,10);await f.frame();assert.deepEqual(f.commands.filter(call=>call.command==='begin_window_drag'||call.command==='move_note').map(call=>[call.command,call.args]),[['begin_window_drag',{fixed:false}],['move_note',{x:100,y:200,finish:false}]]);
 f.mouse(540,660);await f.frame();assert.deepEqual(f.commands.filter(call=>call.command==='move_note').at(-1)?.args,{x:120,y:230,finish:false});
 f.dispose();await flush();assert.equal(f.commands.filter(call=>call.command==='cancel_window_drag').length,1);assert.deepEqual(f.errors,[]);
}));

test('grabbing a settling follower begins before sampling its actual origin and never jumps to the old press position',()=>fixture(async f=>{
 f.press(false);await flush();f.position(140,240);f.mouse(520,630);pointer('pointermove',16,10);await f.frame();
 assert.deepEqual(f.commands.find(call=>call.command==='move_note')?.args,{x:140,y:240,finish:false});assert.deepEqual(f.originReads,[{begun:true,x:140,y:240}]);
 f.mouse(530,640);await f.frame();assert.deepEqual(f.commands.filter(call=>call.command==='move_note').at(-1)?.args,{x:150,y:250,finish:false});assert.deepEqual(f.errors,[]);
}));

test('release before the first frame samples its final cursor after the native begin completes',()=>fixture(async f=>{
 f.onBegin(()=>{f.position(140,240);f.mouse(530,640);});f.press(false);f.mouse(520,630);pointer('pointermove',16,10);pointer('pointerup',16,10);await flush();
 assert.deepEqual(f.commands.filter(call=>call.command==='move_note').map(call=>call.args),[{x:140,y:240,finish:true}]);assert.equal(f.commands.filter(call=>call.command==='begin_window_drag').length,1);assert.deepEqual(f.errors,[]);
}));

test('a new gesture waits for a pending native begin to cancel before taking over',()=>fixture(async f=>{
 let release!:()=>void,first=true;const gate=new Promise<void>(resolve=>{release=resolve;});f.onBegin(()=>{if(first){first=false;return gate;}});
 f.press();f.mouse(520,630);pointer('pointermove',16,10);await f.frame();f.press(false);f.mouse(540,650);pointer('pointermove',16,10);await f.frame();
 assert.equal(f.commands.filter(call=>call.command==='begin_window_drag').length,1);assert.equal(f.commands.some(call=>call.command==='move_note'),false);release();await flush();
 assert.deepEqual(f.commands.filter(call=>['begin_window_drag','move_note','cancel_window_drag'].includes(call.command)).map(call=>call.command),['begin_window_drag','cancel_window_drag','begin_window_drag','move_note']);pointer('pointerup',16,10);await flush();
 assert.equal(f.commands.filter(call=>call.command==='move_note'&&call.args.finish===true).length,1);assert.deepEqual(f.errors,[]);
}));

test('Escape while native begin is pending cancels without sending an obsolete move or finish',()=>fixture(async f=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.onBegin(()=>gate);f.press();f.mouse(520,630);pointer('pointermove',16,10);await f.frame();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));release();await flush();
 assert.deepEqual(f.commands.filter(call=>['begin_window_drag','move_note','cancel_window_drag'].includes(call.command)).map(call=>call.command),['begin_window_drag','cancel_window_drag']);assert.equal(f.state.fixed,false);assert.deepEqual(f.errors,[]);
}));

test('disposing during a pending drop prevents its late origin reset and canvas-end broadcast',()=>fixture(async f=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.onFinish(()=>gate);f.press();f.mouse(520,630);pointer('pointermove',16,10);await f.frame();pointer('pointerup',16,10);await flush();
 assert.equal(f.commands.filter(call=>call.command==='move_note'&&call.args.finish===true).length,1);f.dispose();release();await flush();
 assert.deepEqual(f.originResets,[]);assert.equal(f.commands.some(call=>call.command==='plugin:event|emit'&&call.args.event==='kkb:v1:canvas-end'),false);assert.deepEqual(f.errors,[]);
}));

test('a new gesture cancels the prior native transaction before beginning its own chain motion',()=>fixture(async f=>{
 f.press();await flush();f.mouse(520,630);pointer('pointermove',16,10);await f.frame();
 f.press(false);await flush();assert.equal(f.commands.filter(call=>call.command==='cancel_window_drag').length,1);assert.equal(f.commands.filter(call=>call.command==='begin_window_drag').length,1,'the new press still has no chain transaction before movement');
 f.mouse(540,650);pointer('pointermove',16,10);await f.frame();
 assert.deepEqual(f.commands.filter(call=>['begin_window_drag','move_note','cancel_window_drag'].includes(call.command)).map(call=>call.command),['begin_window_drag','move_note','cancel_window_drag','begin_window_drag','move_note']);
 pointer('pointerup',16,10);await flush();assert.equal(f.commands.filter(call=>call.command==='move_note'&&call.args.finish===true).length,1);assert.deepEqual(f.errors,[]);
}));

test('a failed final native move is cancelled instead of leaving the chain transaction open after release',()=>fixture(async f=>{
 f.press();await flush();f.mouse(520,630);pointer('pointermove',16,10);await f.frame();pointer('pointerup',16,10);await flush();
 assert.equal(f.commands.filter(call=>call.command==='move_note'&&call.args.finish===true).length,1);assert.deepEqual(f.errors,['Error: finish failed']);assert.equal(f.commands.filter(call=>call.command==='cancel_window_drag').length,1,'release failure must restore and close the still-open chain transaction');
},true));

test('a delayed chain-end position reply cannot replace a newer native movement origin',async()=>{
 const listeners=new Map<string,Set<(event:{payload:any})=>void>>(),frames=new Map<number,FrameRequestCallback>(),shifts:{x:number;y:number}[]=[];let frameId=0,initial=true,moved!:((event:{payload:{x:number;y:number}})=>void),reply!:(point:{x:number;y:number})=>void;
 const endPosition=new Promise<{x:number;y:number}>(resolve=>{reply=resolve;}),bus:DesktopBus={listen:async(channel,handler)=>{const group=listeners.get(channel)??new Set();group.add(handler);listeners.set(channel,group);return()=>group.delete(handler);},emit:async(channel,payload)=>{for(const handler of listeners.get(channel)??[])handler({payload});}};
 const native:PositionWindow={outerPosition:()=>{if(initial){initial=false;return Promise.resolve({x:10,y:10});}return endPosition;},scaleFactor:async()=>1,onMoved:async handler=>{moved=handler;return()=>{};},onScaleChanged:async()=>()=>{}};
 const connection=await connectWindowPositions({label:'card-a',window:native,bus,positions:new WindowPositions(),fixed:()=>false,shift:delta=>shifts.push(delta),notify:()=>{},error:reason=>assert.fail(reason),frames:{request:callback=>{frames.set(++frameId,callback);return frameId;},cancel:id=>frames.delete(id)}});
 const frame=async()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(0));await flush();};
 try{
  await bus.emit('kkb:window-chain-motion',{active:true,fixed:true});moved({payload:{x:30,y:30}});
  await bus.emit('kkb:window-chain-motion',{active:false,fixed:true});moved({payload:{x:40,y:40}});
  reply({x:30,y:30});await flush();await frame();await frame();moved({payload:{x:50,y:50}});
  assert.deepEqual(shifts,[{x:10,y:10}],'the newer onMoved origin must survive an older in-flight outerPosition snapshot');
 }finally{connection.dispose();}
});
