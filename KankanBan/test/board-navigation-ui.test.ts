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
import {executeAction} from '../src/core/actions.ts';
import {emptyViewState,windowViewFor} from '../src/core/view-state.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:(time:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id)});
Object.assign(globalThis,{OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
test('restored focus on a column renders its board and double clicking the heading stays on the board',async()=>{
 const buffer=createBufferedFs(),session=openSession('/board-ui',{ops:buffer.ops}),board=executeAction(session,{kind:'create',parent:null,title:'Board',layout:'columns'}).createdId!,column=session.state.children.get(board)![0]!.id;
 const view=emptyViewState();view.windows[board]={...windowViewFor(view,board),focusId:column};
 const c=new WorkspaceController(session,view,buffer,toAsync(createMemoryFs().ops)),host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{
  await act(async()=>root.render(createElement(WorkspaceApp,{controller:c,cardId:board})));
  assert.equal(host.querySelectorAll('.kanban-column').length,3);
  await act(async()=>{await c.execute({kind:'view',id:board,focus:column});});assert.equal(c.view.windows[board]!.focusId,board);
  await act(async()=>host.querySelector('.column-heading button')!.dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true})));
  assert.equal(host.querySelectorAll('.kanban-column').length,3);assert.equal(c.view.windows[board]!.focusId,board);
 }finally{await act(async()=>root.unmount());host.remove();}
});
