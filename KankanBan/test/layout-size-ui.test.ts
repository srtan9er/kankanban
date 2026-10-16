import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceApp} from '../src/webview/WorkspaceApp.tsx';
import {WorkspaceController} from '../src/webview/controller.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {emptyViewState} from '../src/core/view-state.ts';
import {newExpansionId} from '../src/core/window-identity.ts';

Object.assign(globalThis,{MutationObserver:window.MutationObserver,requestAnimationFrame:(fn:(time:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id),ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:[...text].length*8})};}}});
async function fixture(){
 const buffer=createBufferedFs(),s=openSession('/size-ui',{ops:buffer.ops}),disk=createMemoryFs();
 const id=createCard(s,{parentId:null,title:'Parent'}),child=createCard(s,{parentId:id,title:'Child'});
 const c=new WorkspaceController(s,emptyViewState(),buffer,toAsync(disk.ops));
 const views=[newExpansionId(id),newExpansionId(id)],hosts:HTMLDivElement[]=[],roots:ReturnType<typeof createRoot>[]=[];
 for(const windowId of views){
  await act(async()=>{await c.execute({kind:'view',id:windowId,focus:id});});
  const host=document.createElement('div');document.body.append(host);hosts.push(host);const root=createRoot(host);roots.push(root);
  await act(async()=>root.render(createElement(WorkspaceApp,{controller:c,cardId:id,windowId})));
 }
 const drag=async(host:HTMLElement,x:number,y:number)=>{
  const region=host.querySelector('.card-regions') as HTMLElement;
  region.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:640,bottom:480,width:640,height:480,toJSON(){}});
  await act(async()=>{
   region.querySelector('.child-region-resizer')!.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,button:0,clientX:x,clientY:y}));
   document.dispatchEvent(new window.MouseEvent('pointermove',{bubbles:true,clientX:x,clientY:y}));
   document.dispatchEvent(new window.MouseEvent('pointerup',{bubbles:true}));await c.flush();
  });
 };
 return {c,id,child,views,hosts,drag,dispose(){act(()=>roots.forEach(root=>root.unmount()));hosts.forEach(host=>host.remove());}};
}
test('real region resize controls restore per-layout sizes in both expansions of the same card',async()=>{
 const f=await fixture();try{
  await f.drag(f.hosts[0]!,0,180);
  for(const host of f.hosts)assert.match((host.querySelector('.child-region') as HTMLElement).style.height,/300px/);
  await act(async()=>{await f.c.execute({kind:'layout',id:f.id,layout:'ordered'});});
  await f.drag(f.hosts[0]!,380,0);
  for(const host of f.hosts)assert.match((host.querySelector('.child-region') as HTMLElement).style.width,/260px/);
  await act(async()=>{await f.c.execute({kind:'layout',id:f.id,layout:'plain'});});
  for(const host of f.hosts)assert.match((host.querySelector('.child-region') as HTMLElement).style.height,/300px/);
  await f.drag(f.hosts[0]!,0,480);
  for(const host of f.hosts)assert.ok(host.querySelector('.child-region-collapsed'));
 }finally{f.dispose();}
});
test('resizing an entered child saves on that child, preserving the parent in the other window',async()=>{
 const f=await fixture();try{
  await f.drag(f.hosts[0]!,0,180);
  await act(async()=>{await f.c.execute({kind:'view',id:f.views[0]!,focus:f.child});});
  await f.drag(f.hosts[0]!,0,120);
  assert.deepEqual(f.c.session.state.cards.get(f.id)?.layoutSizes,{plain:{height:300}});
  assert.deepEqual(f.c.session.state.cards.get(f.child)?.layoutSizes,{plain:{height:360}});
  assert.match((f.hosts[1]!.querySelector('.child-region') as HTMLElement).style.height,/300px/);
 }finally{f.dispose();}
});
