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
import {executeAction} from '../src/core/actions.ts';
import {emptyViewState,windowViewFor} from '../src/core/view-state.ts';
import {Markdown} from '../src/webview/Markdown.tsx';
import {EditMode} from '../src/webview/edit-mode.ts';
import {windowAnchor} from '../src/core/window-identity.ts';
import type {Request} from '../src/webview/controller.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:(time:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id)});
Object.assign(globalThis,{OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
test('browsing blocks table cell edits and task changes even with a writer attached',async()=>{
 const host=document.createElement('div'),root=createRoot(host),requests:Request[]=[];document.body.append(host);
 try{
  await act(async()=>root.render(createElement(EditMode.Provider,{value:{editable:false,busy:false}},createElement(Markdown,{id:'card',text:'- [ ] Task\n\n| A | B |\n| --- | --- |\n| C | D |',send:async request=>{requests.push(request);}}))));
  const cell=host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!;
  await act(async()=>cell.click());assert.ok(!host.querySelector('.table-cell-editor'));assert.ok(!host.querySelector('.table-tools'));
  const task=host.querySelector<HTMLInputElement>('.markdown-task-check')!;assert.ok(task.disabled);await act(async()=>task.click());assert.equal(task.checked,false);assert.equal(requests.length,0);
 }finally{await act(async()=>root.unmount());host.remove();}
});
async function mount(board=false,standaloneColumn=false){
 const buffer=createBufferedFs(),s=openSession('/controls',{ops:buffer.ops}),anchor=executeAction(s,{kind:'create',parent:null,title:'Anchor',layout:board?'columns':'ordered'}).createdId!;
 const parent=board?s.state.children.get(anchor)![0]!.id:anchor,id=createCard(s,{parentId:parent,title:'Child',content:'Full preview text'}),c=new WorkspaceController(s,emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 const windowAnchor=standaloneColumn?parent:anchor;
 if(board)c.view.windows[windowAnchor]={...windowViewFor(c.view,windowAnchor),focusId:id};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(createElement(WorkspaceApp,{controller:c,cardId:windowAnchor})));
 return {s,c,anchor,parent,id,host,close:async()=>{await act(async()=>root.unmount());host.remove();}};
}
test('manager lists tree roots independently of desktop expansions and updates after reparenting',async()=>{
 const buffer=createBufferedFs(),session=openSession('/tree-manager',{ops:buffer.ops}),parent=createCard(session,{parentId:null,title:'Parent'}),child=createCard(session,{parentId:parent,title:'Child'}),other=createCard(session,{parentId:null,title:'Closed root'});
 const c=new WorkspaceController(session,emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 await c.execute({kind:'window',id:child,open:true});await c.execute({kind:'window',id:child+'__one',open:true});
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 const ids=()=>[...host.querySelectorAll<HTMLElement>('.manager-home [data-card-id]')].map(element=>element.dataset.cardId!);
 try{
  await act(async()=>root.render(createElement(WorkspaceApp,{controller:c})));
  assert.ok(ids().includes(parent));assert.ok(ids().includes(other));assert.ok(!ids().includes(child));assert.equal(ids().filter(id=>id===parent).length,1);
  await act(async()=>c.execute({kind:'window',id:child,open:false}));assert.ok(!ids().includes(child));
  await act(async()=>c.execute({kind:'move',id:child,parent:null,index:0}));assert.ok(ids().includes(child));
  await act(async()=>c.execute({kind:'move',id:child,parent,index:0}));assert.ok(!ids().includes(child));assert.ok(c.view.openWindows.includes(child+'__one'));
  const open=()=>host.querySelector(`[data-card-id="${other}"]`)!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  await act(async()=>open());await act(async()=>open());
  const expansions=c.view.openWindows.filter(id=>windowAnchor(id)===other);assert.equal(expansions.length,2);assert.notEqual(expansions[0],expansions[1]);
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('independent child windows refresh full tree breadcrumbs when the card moves or is extracted',async()=>{
 const buffer=createBufferedFs(),s=openSession('/breadcrumbs',{ops:buffer.ops}),a=createCard(s,{parentId:null,title:'Parent A'}),b=createCard(s,{parentId:null,title:'Parent B'}),child=createCard(s,{parentId:a,title:'Child'}),c=new WorkspaceController(s,emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 await c.execute({kind:'window',id:child+'__one',open:true});await c.execute({kind:'window',id:child+'__two',open:true});
 const mirrors=[1,2].map(()=>new WorkspaceController(openSession('/mirror',{ops:createMemoryFs().ops}),emptyViewState(),createBufferedFs(),toAsync(createMemoryFs().ops)));
 const hosts=mirrors.map(()=>{const host=document.createElement('div');document.body.append(host);return host;}),roots=hosts.map(host=>createRoot(host));
 const titles=(host:HTMLElement)=>[...host.querySelectorAll('.note-breadcrumb .breadcrumb-node:not(.breadcrumb-measure .breadcrumb-node) button')].map(button=>button.getAttribute('title'));
 const update=async()=>{await act(async()=>{mirrors.forEach(m=>m.accept(c.snapshot()));});};
 try{
  await update();await act(async()=>roots.forEach((root,i)=>root.render(createElement(WorkspaceApp,{controller:mirrors[i]!,cardId:child,windowId:child+(i===0?'__one':'__two')}))));
  for(const host of hosts)assert.deepEqual(titles(host),['Parent A','Child']);
  await c.execute({kind:'move',id:child,parent:b,index:0});await update();for(const host of hosts)assert.deepEqual(titles(host),['Parent B','Child']);
  await c.execute({kind:'move',id:b,parent:a,index:0});await update();for(const host of hosts)assert.deepEqual(titles(host),['Parent A','Parent B','Child']);
  await c.execute({kind:'float',id:child});await update();for(const host of hosts)assert.deepEqual(titles(host),['Child']);
 }finally{await act(async()=>roots.forEach(root=>root.unmount()));hosts.forEach(host=>host.remove());}
});
test('window mode switch disables body and title editing and hides doodle tools until editing resumes',async()=>{
 const f=await mount();try{
  const toggle=f.host.querySelector<HTMLButtonElement>('.toggle')!;
  const visual=f.host.querySelector<HTMLElement>('[data-visual-editor]')!;assert.ok(visual);assert.equal(visual.getAttribute('data-visual-active'),'false');
  assert.equal(toggle.getAttribute('aria-label'),'切换到浏览模式');
  await act(async()=>toggle.click());
  assert.equal(toggle.getAttribute('aria-label'),'切换到编辑模式');
  assert.ok(!document.querySelector('.ink-pill'));
  await act(async()=>f.host.querySelector('.preview')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.ok(f.host.querySelector('[data-visual-editor]')===visual,'browsing retains the same formatted surface');assert.equal(visual.getAttribute('data-visual-active'),'false');assert.equal(visual.getAttribute('contenteditable'),null);assert.equal(f.host.querySelector<HTMLElement>('.card-body-editor')!.dataset.bodyEditing,'false');
  await act(async()=>f.host.querySelector<HTMLInputElement>('.title')!.click());
  assert.equal(f.host.querySelector<HTMLInputElement>('.title')!.readOnly,true);
  await act(async()=>toggle.click());
  assert.ok(document.querySelector('.ink-pill'));
  await act(async()=>f.host.querySelector('.preview')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.ok(f.host.querySelector('[data-visual-editor]')===visual);assert.equal(visual.getAttribute('data-visual-active'),'true');assert.equal(visual.getAttribute('contenteditable'),'true');
 }finally{await f.close();}
});
test('failed persistence keeps the window in editing mode and reports the error',async()=>{
 const f=await mount(),flush=f.c.flush;
 try{
  f.c.flush=async()=>{throw new Error('save failed');};
  await act(async()=>f.host.querySelector<HTMLButtonElement>('.toggle')!.click());
  assert.equal(f.host.querySelector('.toggle')!.getAttribute('aria-label'),'切换到浏览模式');
  assert.ok(f.host.querySelector('[role="alert"]')!.textContent?.includes('save failed'));
  assert.ok(document.querySelector('.ink-pill'));
 }finally{f.c.flush=flush;await f.close();}
});
test('creation control uses a geometric SVG; delete is inside the preview and does not enter the card',async()=>{
 const f=await mount();try{
  assert.ok(f.host.querySelector('.floating-add-card > svg.add-icon'));
  const card=f.host.querySelector(`[data-card-id="${f.id}"]`)!;assert.ok(card.querySelector('.child-preview > .child-delete'));
  const button=card.querySelector('.child-delete')!;await act(async()=>button.dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true})));
  assert.equal(f.c.view.windows[f.anchor]?.focusId,undefined);assert.equal(f.s.state.cards.get(f.id)?.deleted,false);
 }finally{await f.close();}
});
for(const control of ['back','breadcrumb'] as const)test(`${control} skips the board's structural column`,async()=>{
 const f=await mount(true);try{
  const button=control==='back'?f.host.querySelector('.breadcrumb-back'):[...f.host.querySelectorAll('.breadcrumb-node button')].find(b=>b.getAttribute('title')===f.s.state.cards.get(f.parent)!.title && !b.closest('.breadcrumb-measure'));
  assert.ok(button);await act(async()=>button.dispatchEvent(new window.MouseEvent('click',{bubbles:true})));assert.equal(f.c.view.windows[f.anchor]?.focusId,f.anchor);
 }finally{await f.close();}
});
test('returning from a standalone column opens a fresh board expansion without changing the tree',async()=>{
 const f=await mount(true,true);try{
  await act(async()=>f.host.querySelector('.breadcrumb-back')!.dispatchEvent(new window.MouseEvent('click',{bubbles:true})));
  const expansion=f.c.view.openWindows.find(id=>windowAnchor(id)===f.anchor);assert.ok(expansion);assert.notEqual(expansion,f.anchor);assert.equal(f.c.view.windows[expansion]?.focusId,f.anchor);
  assert.ok(f.s.state.children.get(f.parent)?.some(e=>e.id===f.id));
 }finally{await f.close();}
});
