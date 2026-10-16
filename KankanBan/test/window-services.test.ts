import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cardWindowService} from '../src/webview/card-window-service.ts';
import {windowDragIntent,extractOnDesktop} from '../src/webview/window-drag-intent.ts';
import {createDesktopMirror,serveDesktopRequests,requestTimeout,DESKTOP_CHANNEL,type DesktopBus,type DesktopReply} from '../src/webview/desktop-mirror.ts';
import {emptyViewState} from '../src/core/view-state.ts';
import type {Snapshot} from '../src/webview/controller.ts';
import {connectWindowPositions,type PositionWindow} from '../src/webview/window-position-sync.ts';
import {WindowPositions} from '../src/webview/window-events.ts';
function busFixture(){
 const handlers=new Map<string,Set<(event:{payload:any})=>void>>();
 const bus:DesktopBus={emit:async(channel,payload)=>{for(const handler of [...(handlers.get(channel) ?? [])])handler({payload});},listen:async(channel,handler)=>{const listeners=handlers.get(channel) ?? new Set();listeners.add(handler);handlers.set(channel,listeners);return()=>{listeners.delete(handler);};}};
 return {bus,count:()=>[...handlers.values()].reduce((total,set)=>total+set.size,0)};
}
const snapshot=(revision:number):Snapshot=>({cards:[],children:[],seq:revision,view:emptyViewState(),undoCount:0,revision});
test('extension polling replies carry results without rebuilding or sending the card snapshot',async()=>{
 const {bus}=busFixture();let snapshots=0;const stop=await serveDesktopRequests(bus,async()=>({toolResult:{state:'running'}}),()=>{snapshots++;return snapshot(1);},{incoming:0,replied:0,failed:0,requests:[]});let reply:DesktopReply|undefined;
 const listen=await bus.listen<DesktopReply>(`${DESKTOP_CHANNEL}:reply`,event=>{reply=event.payload;});try{await bus.emit(`${DESKTOP_CHANNEL}:request`,{token:'poll',from:'card-ext',request:{kind:'extension-job',jobId:1}});await new Promise(resolve=>setImmediate(resolve));assert.equal(snapshots,0);assert.equal(reply?.snapshot,undefined);assert.deepEqual(reply?.result?.toolResult,{state:'running'});}finally{stop();listen();}
});
test('native view adapter keeps existing command names and passes independent view IDs unchanged',async()=>{
 const calls:{command:string;args?:Record<string,unknown>|undefined}[]=[],service=cardWindowService(async<T>(command:string,args?:Record<string,unknown>)=>{calls.push({command,args});return [] as T;});
 await service.open('card__one');await service.close('card__two');await service.position('card__one',100,200);await service.sync(['card','card__one']);await service.labels();
 assert.deepEqual(calls,[{command:'open_card_window',args:{cardId:'card__one'}},{command:'close_card_window',args:{cardId:'card__two'}},{command:'position_card_window',args:{cardId:'card__one',x:100,y:200}},{command:'sync_card_windows',args:{wanted:['card','card__one']}},{command:'card_window_labels',args:undefined}]);
});
test('drag classification preserves child expansion, relation grip and desktop motion distinctions',()=>{
 assert.deepEqual(windowDragIntent({label:'card-parent__one',cardId:'child',childBody:true,relationHandle:false}),{sourceWindow:false,reparent:false,positionOnly:true,movingWindow:false});
 assert.deepEqual(windowDragIntent({label:'card-child__one',cardId:'child',childBody:false,relationHandle:true}),{sourceWindow:true,reparent:true,positionOnly:false,movingWindow:false});
 assert.ok(windowDragIntent({label:'card-child__one',cardId:'child',childBody:false,relationHandle:false}).movingWindow);
 assert.ok(windowDragIntent({label:'card-parent',cardId:'child',childBody:true,relationHandle:false,mode:'window-fixed'}).movingWindow);
});
test('ordinary relation-grip drops onto the desktop extract to roots; invalid in-window drops do nothing',()=>{
 const grip=windowDragIntent({label:'card-parent',cardId:'child',childBody:false,relationHandle:true});
 assert.ok(extractOnDesktop({...grip,valid:false,target:null}));
 assert.equal(extractOnDesktop({...grip,valid:false,target:{label:'card-other'}}),false);
 assert.equal(extractOnDesktop({valid:false,target:null,movingWindow:true}),false);
 assert.equal(extractOnDesktop({...grip,valid:true,target:{label:'card-other'}}),false);
});
test('mirror channels target replies, broadcast to every expansion and reject older snapshots',async()=>{
 const {bus,count}=busFixture(),diagnostics={incoming:0,replied:0,failed:0,requests:[]},seen:number[][]=[[],[]];let revision=1;
 const stop=await serveDesktopRequests(bus,async()=>({createdId:'new'}),()=>snapshot(revision),diagnostics);
 const mirrors=seen.map((values,i)=>createDesktopMirror(`card-c__${i}`,s=>values.push(s.revision),bus));
 try{
  await Promise.all(mirrors.map(m=>m.start()));assert.deepEqual(seen,[[1],[1]]);
  await bus.emit(`${DESKTOP_CHANNEL}:snapshot`,snapshot(3));await bus.emit(`${DESKTOP_CHANNEL}:snapshot`,snapshot(2));assert.deepEqual(seen,[[1,3],[1,3]]);
  revision=4;const result=await mirrors[0]!.request({kind:'window',id:'c__other',open:true});assert.equal(result.createdId,'new');assert.deepEqual(seen,[[1,3,4],[1,3]]);
 }finally{mirrors.forEach(m=>m.dispose());stop();}assert.equal(count(),0);
});
test('reply errors retain accompanying snapshots and disposal rejects pending requests',async()=>{
 const {bus,count}=busFixture(),seen:number[]=[];let fail=false;
 const stop=await serveDesktopRequests(bus,async()=>{if(fail)throw new Error('failure');return {};},()=>snapshot(1),{incoming:0,replied:0,failed:0,requests:[]});
 const mirror=createDesktopMirror('card-c',s=>seen.push(s.revision),bus);await mirror.start();fail=true;
 await assert.rejects(mirror.request({kind:'window',id:'c',open:true}),/failure/);stop();
 let message:{token:string}|undefined;const stopCapture=await bus.listen<{token:string}>(`${DESKTOP_CHANNEL}:request`,event=>{message=event.payload;});
 const request=mirror.request({kind:'view',id:'c'});const rejected=assert.rejects(request,/denied/);await bus.emit(`${DESKTOP_CHANNEL}:reply`,{token:message!.token,to:'card-c',error:'denied',snapshot:snapshot(5)} satisfies DesktopReply);await rejected;assert.equal(seen.at(-1),5);
 const pending=mirror.request({kind:'view',id:'c'}),disposed=assert.rejects(pending);mirror.dispose();await disposed;stopCapture();assert.equal(count(),0);
});
test('request timeouts retain image and share exceptions',()=>{
 assert.equal(requestTimeout(null),12000);assert.equal(requestTimeout({kind:'share-export',id:'c'}),null);assert.equal(requestTimeout({kind:'images-import',id:'c',inputs:[]}),120000);
});
test('position sync coalesces frames, adjusts display scale, respects fixed movement and disposes subscriptions',async()=>{
 const {bus,count}=busFixture(),positions=new WindowPositions(),shifts:{x:number;y:number}[]=[],notifications:number[]=[],frames=new Map<number,FrameRequestCallback>();let fixed=false,frameId=0;
 let moved:((event:{payload:{x:number;y:number}})=>void)|undefined,scaled:((event:{payload:{scaleFactor:number}})=>void)|undefined;
 const native:PositionWindow={outerPosition:async()=>({x:10,y:20}),scaleFactor:async()=>2,onMoved:async handler=>{moved=handler;return()=>{moved=undefined;};},onScaleChanged:async handler=>{scaled=handler;return()=>{scaled=undefined;};}};
 const connection=await connectWindowPositions({label:'card-c__one',window:native,bus,positions,fixed:()=>fixed,shift:delta=>shifts.push(delta),notify:position=>notifications.push(position.x),error:reason=>assert.fail(reason),frames:{request:callback=>{frames.set(++frameId,callback);return frameId;},cancel:id=>{frames.delete(id);}}});
 const frame=async()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(0));await Promise.resolve();};
 try{
  moved!({payload:{x:14,y:26}});moved!({payload:{x:18,y:30}});assert.equal(frames.size,1);await frame();assert.deepEqual(shifts,[{x:2,y:3},{x:2,y:2}]);assert.deepEqual(notifications,[18]);
  fixed=true;moved!({payload:{x:22,y:40}});await frame();assert.equal(shifts.length,2);assert.deepEqual(notifications,[18,22]);
  connection.resetOrigin({x:30,y:50});fixed=false;scaled!({payload:{scaleFactor:1}});moved!({payload:{x:31,y:52}});assert.deepEqual(shifts.at(-1),{x:1,y:2});assert.equal(frames.size,1);
 }finally{connection.dispose();}assert.equal(frames.size,0);assert.equal(count(),0);assert.equal(moved,undefined);assert.equal(scaled,undefined);
});

test('chain followers keep canvas fixed through late final move events and resume after settling frames',async()=>{
 const {bus,count}=busFixture(),positions=new WindowPositions(),shifts:{x:number;y:number}[]=[],frames=new Map<number,FrameRequestCallback>();let frameId=0,point={x:10,y:20},moved!:((event:{payload:{x:number;y:number}})=>void);
 const native:PositionWindow={outerPosition:async()=>({...point}),scaleFactor:async()=>2,onMoved:async handler=>{moved=handler;return()=>{};},onScaleChanged:async()=>()=>{}};
 const connection=await connectWindowPositions({label:'card-c__follower',window:native,bus,positions,fixed:()=>false,shift:delta=>shifts.push(delta),notify:()=>{},error:reason=>assert.fail(reason),frames:{request:callback=>{frames.set(++frameId,callback);return frameId;},cancel:id=>{frames.delete(id);}}});
 const frame=async()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(0));await Promise.resolve();};
 const move=(x:number,y:number)=>{point={x,y};moved({payload:point});};
 try{
  await bus.emit('kkb:window-chain-motion',{active:true,fixed:true});move(30,40);assert.deepEqual(shifts,[]);
  await bus.emit('kkb:window-chain-motion',{active:false,fixed:true});await Promise.resolve();move(34,44);assert.deepEqual(shifts,[],'the final queued native position must not compensate the canvas');
  await frame();await frame();move(38,48);assert.deepEqual(shifts,[{x:2,y:2}]);
  await bus.emit('kkb:window-chain-motion',{active:true,fixed:false});move(42,52);assert.deepEqual(shifts.at(-1),{x:2,y:2});
  await bus.emit('kkb:window-chain-motion',{active:true,fixed:true});await bus.emit('kkb:window-chain-motion',{active:false,fixed:true});await bus.emit('kkb:window-chain-motion',{active:true,fixed:true});await frame();await frame();move(46,56);assert.equal(shifts.length,2,'an older ending cannot release a newer fixed chain drag');
 }finally{connection.dispose();}assert.equal(count(),0);assert.equal(frames.size,0);
});

test('released fixed dragging keeps canvas compensation disabled throughout native follow frames',async()=>{
 const {bus,count}=busFixture(),frames=new Map<number,FrameRequestCallback>(),shifts:{x:number;y:number}[]=[];let frameId=0,point={x:10,y:20},localFixed=true,moved!:((event:{payload:{x:number;y:number}})=>void);
 const native:PositionWindow={outerPosition:async()=>({...point}),scaleFactor:async()=>2,onMoved:async handler=>{moved=handler;return()=>{};},onScaleChanged:async()=>()=>{}};
 const connection=await connectWindowPositions({label:'card-c__settling',window:native,bus,positions:new WindowPositions(),fixed:()=>localFixed,shift:delta=>shifts.push(delta),notify:()=>{},error:reason=>assert.fail(reason),frames:{request:callback=>{frames.set(++frameId,callback);return frameId;},cancel:id=>{frames.delete(id);}}});
 const frame=async()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(0));await Promise.resolve();};
 const move=(x:number,y:number)=>{point={x,y};moved({payload:point});};
 try{
  await bus.emit('kkb:window-chain-motion',{active:true,fixed:true});move(12,22);localFixed=false;
  for(let index=0;index<10;index++){move(14+index*2,24+index*2);await frame();}
  assert.deepEqual(shifts,[],'pointer release must not end the native fixed-motion guard while followers keep moving');
  await bus.emit('kkb:window-chain-motion',{active:false,fixed:true});await Promise.resolve();move(36,46);await frame();assert.deepEqual(shifts,[]);await frame();move(38,48);assert.deepEqual(shifts,[{x:1,y:1}]);
 }finally{connection.dispose();}assert.equal(count(),0);assert.equal(frames.size,0);
});
