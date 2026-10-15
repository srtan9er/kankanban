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
import {openSession,createCard} from '../src/core/workspace.ts';
import {emptyViewState} from '../src/core/view-state.ts';
Object.assign(globalThis,{ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},requestAnimationFrame:(fn:(time:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id)});
test('child grip starts the child structural drag once and does not activate navigation',async()=>{
 const b=createBufferedFs(),s=openSession('/grip',{ops:b.ops});const parent=createCard(s,{parentId:null,title:'Parent',layout:'ordered'}),child=createCard(s,{parentId:parent,title:'Child'});
 const c=new WorkspaceController(s,emptyViewState(),b,toAsync(createMemoryFs().ops));const host=document.createElement('div');document.body.append(host);const root=createRoot(host),seen:{id:string;grip:boolean}[]=[];
 try{
  await act(async()=>root.render(createElement(WorkspaceApp,{controller:c,cardId:parent,startDrag:(id,event)=>{seen.push({id,grip:!!(event.target as Element).closest('.reparent-grip')});}})));
  const grip=host.querySelector(`[data-card-id="${child}"] .child-reparent-grip`)!;assert.ok(grip);
  await act(async()=>grip.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,button:0})));
  assert.deepEqual(seen,[{id:child,grip:true}]);
  await act(async()=>grip.dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true,button:0})));
  assert.equal(c.view.windows[parent]?.focusId,undefined);
 }finally{await act(async()=>root.unmount());host.remove();}
});
