import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceApp } from '../src/webview/WorkspaceApp.tsx';
import { WorkspaceController } from '../src/webview/controller.ts';
import { createBufferedFs } from '../src/platform/buffered-fs-ops.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { toAsync } from '../src/platform/async-fs-ops.ts';
import { openSession, createCard } from '../src/core/workspace.ts';
import { emptyViewState } from '../src/core/view-state.ts';
import {installModernUI} from './modern-ui-fixture.ts';
import {normalizeBoards} from '../src/core/boards.ts';
import {windowAnchor} from '../src/core/window-identity.ts';
import {uiText} from '../src/i18n/text.ts';
import {prepareEditors} from '../src/webview/drafts.ts';
import {getVisualEditorSelection,setVisualEditorSelection} from '../src/webview/VisualBodyEditor.tsx';
installModernUI();

async function fixture(cardId?: string, startDrag?: (id: string, event: import('react').PointerEvent,mode?:import('../src/core/canvas-drag.ts').CanvasDragAction) => void) {
  const b = createBufferedFs(); const s = openSession('/ui', { ops: b.ops });
  const col = createCard(s, { parentId: '001', title: 'Todo', layout: 'ordered' });
  const task = createCard(s, { parentId: col, title: 'Task', content: '**Safe** <img src=x onerror=alert(1)>' });
  normalizeBoards(s);
  const c = new WorkspaceController(s, emptyViewState(), b, toAsync(createMemoryFs().ops));
  const execute=c.execute.bind(c);c.execute=(request,...args)=>request.kind==='tutorial'?Promise.resolve({createdId:task}):execute(request,...args);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render=(anchor?:string)=>root.render(createElement(WorkspaceApp, {key:anchor??'manager',controller: c, ...(startDrag ? {startDrag} : {}), ...(anchor ? { cardId: anchor } : {}) }));
  await act(async () => render(cardId?task:undefined));
  const click = async (element: Element) => act(async () => {assert.ok(element,'the requested interactive target must exist');element.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1}));element.dispatchEvent(new MouseEvent('pointerup',{bubbles:true,button:0,buttons:0}));element.dispatchEvent(new MouseEvent('click', { bubbles: true,detail:1 })); await c.flush(); });
  const openManagerTask=async()=>{await click([...host.querySelectorAll('button')].find(button=>button.textContent===uiText('webview/WorkspaceApp.text024'))!);await click([...host.querySelectorAll('.settings-card button')].find(button=>button.textContent===uiText('webview/WorkspaceApp.reviewTutorial'))!);assert.ok(host.querySelector('.ordinary-content'));};
  return { c, s, host, col, task, click,openManagerTask,showWindow:async(anchor:string)=>act(async()=>render(anchor)),dispose: () => { act(() => root.unmount()); host.remove(); } };
}
const visual=(host:HTMLElement)=>{const editor=host.querySelector<HTMLElement>('[data-visual-editor]');assert.ok(editor);return editor;};
async function replaceBody(f:Awaited<ReturnType<typeof fixture>>,content:string){const editor=visual(f.host);assert.equal(editor.getAttribute('contenteditable'),'true');setVisualEditorSelection(editor,0,getVisualEditorSelection(editor).beforeContent.length);const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=>content}});await act(async()=>editor.dispatchEvent(paste));}
async function flush(f:Awaited<ReturnType<typeof fixture>>){await act(async()=>{await prepareEditors();await f.c.flush();});}
test('manager board card opens a fresh window; board events select on click and enter without editing on double click', async () => {
  const f = await fixture();
  try {
    assert.ok(f.host.querySelector('.manager-home .masonry-grid'));
    const board=f.host.querySelector('[data-card-id="001"]')!;await act(async()=>board.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));assert.ok(f.c.view.openWindows.some(id=>windowAnchor(id)==='001'));
    await f.showWindow('001');assert.equal(f.host.querySelectorAll('.kanban-column').length,3);
    assert.ok(f.host.querySelector('.document-region') === null);
    assert.ok(f.host.querySelector('.new-column') === null);
    assert.ok(!f.host.querySelector('.heading-actions')?.textContent?.includes('新建列'));
    const card = f.host.querySelector(`[data-card-id="${f.task}"]`)!;
    await f.click(card);
    assert.ok(card.classList.contains('selected'));
    assert.equal(f.host.querySelector('.edit-dialog'), null);
    await act(async () => card.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
    assert.equal(f.host.querySelector<HTMLInputElement>('.proto-note .title')?.value,'Task');assert.equal(visual(f.host).getAttribute('contenteditable'),null);
    assert.equal(f.host.querySelector('img'), null, 'raw markdown HTML must remain text');
  } finally { f.dispose(); }
});
test('floating card keeps prototype title, pin, collapse, preview and resize controls', async () => {
  const f = await fixture('floating');
  try {
    for (const selector of ['.proto-note .title', '.proto-note .pin', '.proto-note .collapse', '.proto-note .toggle', '.proto-note .resize']) assert.ok(f.host.querySelector(selector), selector);
    assert.equal(f.host.querySelector('img'), null);
    await f.click(f.host.querySelector('.preview')!);const content=visual(f.host);assert.equal(document.activeElement,content);await replaceBody(f,'Updated text');await flush(f);
    assert.equal(f.s.state.cards.get(f.task)?.content, 'Updated text');
  } finally { f.dispose(); }
});

test('floating board hides body and all column creation controls but allows events in each column', async () => {
  const b = createBufferedFs(); const s = openSession('/board-ui', { ops: b.ops });
  const board = createCard(s,{parentId:null,title:'Board',layout:'columns',content:'Hidden body'});
  for(const title of ['待办','进行中','完成']) createCard(s,{parentId:board,title,layout:'ordered'});
  const c = new WorkspaceController(s, emptyViewState(), b, toAsync(createMemoryFs().ops));
  const host=document.createElement('div'); document.body.append(host); const root=createRoot(host);
  try {
    await act(async()=>root.render(createElement(WorkspaceApp,{controller:c,cardId:board})));
    assert.equal(host.querySelectorAll('.kanban-column').length,3);
    assert.ok(host.querySelector('.proto-note .body') === null, 'board body must be hidden');
    assert.ok(host.querySelector('.proto-note .toggle')); // title remains editable on boards
    assert.equal(host.querySelector('.new-column'),null);
    assert.equal(host.querySelectorAll('.add-card').length,3);
    assert.ok(![...host.querySelectorAll('button')].some(button=>button.textContent==='＋ 新建'));
    await act(async()=>{ (host.querySelector('.add-card') as HTMLButtonElement).click(); await c.flush(); });
    const col=s.state.children.get(board)![0]!.id;
    assert.equal(s.state.children.get(col)?.length,1);
    assert.equal(s.state.children.get(board)?.length,3);
  } finally { await act(async()=>root.unmount()); host.remove(); }
});

test('ordinary cards offer horizontal and vertical modes, a resizable child region, and a floating add button', async()=>{
  const f=await fixture('floating');
  try {
    assert.ok(f.host.querySelector('.child-region-resizer'), 'child area needs a resize control');
    assert.ok(f.host.querySelector('.floating-add-card'), 'new card button floats at the lower right');
    assert.ok(!f.host.querySelector('.note-tree-drag'), 'moving is unified, no separate tree-drag button');
    await f.click(f.host.querySelector('.note-breadcrumb .card-menu-button')!);
    const labels=[...f.host.querySelectorAll('.layout-choices button')].map(e=>e.textContent);
    assert.ok(labels.includes('横列')); assert.ok(labels.includes('竖列')); assert.ok(!labels.includes('标签页'));
  } finally { f.dispose(); }
});

import { childArea, horizontalChildArea, CHILD_BAR_MIN_HEIGHT, CHILD_CARD_MIN_HEIGHT } from '../src/webview/CardRegions.tsx';
test('child region snaps below threshold and can be restored; horizontal wheel scrolls the row', async()=>{
  assert.deepEqual(childArea(47,200),{width:48,height:200});
  assert.deepEqual(childArea(24,200),{width:48,height:200});
  assert.deepEqual(childArea(23,200),{width:0,height:0});
  assert.deepEqual(childArea(240,48),{width:240,height:48});
  const f=await fixture('floating');
  try {
    const host=f.host.querySelector('.card-regions') as HTMLElement;
    const panel=f.host.querySelector('.child-region') as HTMLElement;
    host.getBoundingClientRect=()=>({width:600,height:400,left:0,top:0,right:600,bottom:400,x:0,y:0,toJSON(){}});
    panel.getBoundingClientRect=()=>({width:240,height:180,left:0,top:0,right:240,bottom:180,x:0,y:0,toJSON(){}});
    await act(async()=>{
      f.host.querySelector('.child-region-resizer')!.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,button:0,clientX:0,clientY:0}));
      document.dispatchEvent(new window.MouseEvent('pointermove',{bubbles:true,clientX:0,clientY:400-CHILD_BAR_MIN_HEIGHT/2+1}));
      document.dispatchEvent(new window.MouseEvent('pointerup',{bubbles:true})); await f.c.flush();
    });
    assert.deepEqual(f.c.view.windows[f.task]?.childArea,{width:0,height:0});
    assert.deepEqual(f.s.state.cards.get(f.task)?.layoutSizes?.plain,{height:0},'the card remembers its horizontal child-area size');
    assert.ok(f.host.querySelector('.resize-rails'));
    assert.equal(f.host.querySelector('.restore-children'),null,'the edge rails replace the old expand button');
    await act(async()=>{f.host.querySelector('.child-region-resizer')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,clientY:400}));document.dispatchEvent(new MouseEvent('pointermove',{bubbles:true,clientY:400-CHILD_BAR_MIN_HEIGHT}));document.dispatchEvent(new MouseEvent('pointerup',{bubbles:true}));await f.c.flush();});
    assert.ok(!f.host.querySelector('.child-region-collapsed'));
    const row=f.host.querySelector('.horizontal-card-list') as HTMLElement;
    Object.defineProperty(row,'scrollWidth',{value:1000}); Object.defineProperty(row,'clientWidth',{value:250});
    const scrolls:ScrollToOptions[]=[]; row.scrollTo=(options?:ScrollToOptions | number)=>{if(typeof options==='object') scrolls.push(options);};
    const wheel=new window.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:80});
    row.dispatchEvent(wheel); assert.deepEqual(scrolls,[{left:80,behavior:'smooth'}]);
    row.dispatchEvent(new window.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:80}));
    assert.deepEqual(scrolls[1],{left:160,behavior:'smooth'});
    const trackpad=new window.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaX:30});
    row.dispatchEvent(trackpad); assert.equal(trackpad.defaultPrevented,false); assert.equal(scrolls.length,2); assert.equal(wheel.defaultPrevented,true);
    assert.equal(f.host.querySelectorAll('.floating-add-card').length,1);
  } finally { f.dispose(); }
});


test('title participates in drag and buttons do not', async()=>{
  const dragged:string[]=[]; const f=await fixture('floating',id=>{dragged.push(id);});
  try {
    const down=(e:Element)=>e.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,button:0}));
    down(f.host.querySelector('.proto-note .title')!);
    assert.deepEqual(dragged,[f.task]);
    down(f.host.querySelector('.proto-note .pin')!); assert.equal(dragged.length,1);
    await f.click(f.host.querySelector('.preview')!);const active=visual(f.host);assert.equal(active.getAttribute('contenteditable'),'true');
    assert.equal(dragged.length,2,'an idle body press arms the window mover before click classification');down(active); assert.equal(dragged.length,2,'active body input owns its selection gesture');
    await f.click(f.host.querySelector('.floating-add-card')!);
    assert.equal(f.host.querySelector('.drag-handle'),null);assert.ok(f.host.querySelector('.child-reparent-grip'),'children have a dedicated tree position grip');
    const child=f.host.querySelector('[data-card-id]') as HTMLElement;
    down(child); assert.equal(dragged.length,3); assert.equal(dragged[2],child.dataset.cardId);
  } finally {f.dispose();}
});

test('horizontal fills width and vertical fills height despite saved cross-axis size', async()=>{
  const f=await fixture('floating');
  try {
    await act(async()=>{await f.c.execute({kind:'view',id:f.task,childArea:{width:120,height:130}});});
    assert.equal((f.host.querySelector('.child-region') as HTMLElement).style.width,'100%');
    await f.click(f.host.querySelector('.note-breadcrumb .card-menu-button')!);
    await f.click([...f.host.querySelectorAll('.layout-choices button')].find(e=>e.textContent==='竖列')!);
    assert.equal((f.host.querySelector('.child-region') as HTMLElement).style.height,'100%');
    const host=f.host.querySelector('.card-regions') as HTMLElement;
    const panel=f.host.querySelector('.child-region') as HTMLElement;
    host.getBoundingClientRect=()=>({width:600,height:400,left:0,top:0,right:600,bottom:400,x:0,y:0,toJSON(){}});
    panel.getBoundingClientRect=()=>({width:240,height:400,left:360,top:0,right:600,bottom:400,x:360,y:0,toJSON(){}});
    await act(async()=>{
      f.host.querySelector('.child-region-resizer')!.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,button:0,clientX:360,clientY:0}));
      document.dispatchEvent(new window.MouseEvent('pointermove',{bubbles:true,clientX:380,clientY:300}));
      document.dispatchEvent(new window.MouseEvent('pointerup',{bubbles:true})); await f.c.flush();
    });
    assert.deepEqual(f.c.view.windows[f.task]?.childArea,{width:220,height:9999},'vertical drag changes only width');
    assert.deepEqual(f.s.state.cards.get(f.task)?.layoutSizes?.ordered,{width:220},'vertical size history is independent from horizontal history');
    assert.equal(panel.style.height,'100%');

  } finally {f.dispose();}
});


test('clicking body preview opens a focused editor and saves content', async()=>{
 const f=await fixture('floating');
 try {
  await f.click(f.host.querySelector('.preview')!);
  const editor=visual(f.host);assert.equal(editor.getAttribute('contenteditable'),'true');assert.equal(document.activeElement,editor);
  await replaceBody(f,'Editable again');await flush(f);
  assert.equal(f.s.state.cards.get(f.task)?.content,'Editable again');
 } finally {f.dispose();}
});

test('waterfall uses one floating add action outside the child collection', async()=>{
 const f=await fixture('floating');
 try {
  await f.click(f.host.querySelector('.note-breadcrumb .card-menu-button')!);
  await f.click([...f.host.querySelectorAll('.layout-choices button')].find(e=>e.textContent===uiText('webview/WorkspaceApp.text003'))!);
  assert.equal(f.host.querySelector('.new-card-tile'),null);
  assert.equal(f.host.querySelectorAll('.floating-add-card').length,1);
  assert.equal(f.host.querySelector('.card-collection .floating-add-card'),null);
 } finally {f.dispose();}
});


test('horizontal bar minimum includes the child card and its surrounding controls',()=>{
 assert.ok(CHILD_BAR_MIN_HEIGHT>CHILD_CARD_MIN_HEIGHT);
 assert.deepEqual(horizontalChildArea(CHILD_BAR_MIN_HEIGHT-1),{width:9999,height:CHILD_BAR_MIN_HEIGHT});
 assert.deepEqual(horizontalChildArea(CHILD_BAR_MIN_HEIGHT/2),{width:9999,height:CHILD_BAR_MIN_HEIGHT});
 assert.deepEqual(horizontalChildArea(CHILD_BAR_MIN_HEIGHT/2-1),{width:0,height:0});
 assert.deepEqual(horizontalChildArea(CHILD_BAR_MIN_HEIGHT),{width:9999,height:CHILD_BAR_MIN_HEIGHT});
});


test('title and body edit separately with the same finish and Escape transitions',async()=>{
 const f=await fixture('floating');
 try {
  const title=f.host.querySelector('.proto-note .title') as HTMLInputElement;
  assert.equal(title.readOnly,true);
  await f.click(title);
  assert.equal(title.readOnly,false);
  assert.equal(visual(f.host).getAttribute('contenteditable'),null,'editing the title must leave the body read-only');
  assert.ok(f.host.querySelector('.preview'));
  assert.ok(f.host.querySelector('.editing-mode'));
  assert.equal(document.activeElement,title);
  await f.click(f.host.querySelector('.preview')!);
  assert.equal(title.readOnly,true);assert.equal(visual(f.host).getAttribute('contenteditable'),'true');
  await act(async()=>{document.activeElement!.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await f.c.flush();});
  assert.equal(title.readOnly,true); assert.ok(!f.host.querySelector('.editing-mode'));
 } finally {f.dispose();}
});


test('manager title entry edits only title',async()=>{
 const f=await fixture();
 try {
  await f.openManagerTask();
  await f.click(f.host.querySelector('.editable-title')!);
  assert.ok(f.host.querySelector('input[aria-label="卡片标题"]'));
  assert.equal(visual(f.host).getAttribute('contenteditable'),null);assert.equal(f.host.querySelector<HTMLElement>('.card-body-editor')!.dataset.bodyEditing,'false');
  assert.ok([...f.host.querySelectorAll('.edit-dialog button')].some(e=>e.textContent===uiText('webview/WorkspaceApp.text100')));
 } finally {f.dispose();}
});


test('failed save keeps the active field open and leaves the other field unchanged',async()=>{
 const f=await fixture('floating'); const execute=f.c.execute.bind(f.c);
 try {
  await f.click(f.host.querySelector('.proto-note .title')!);
  f.c.execute=async request=>{if(request.kind==='edit') throw new Error('Save unavailable'); return execute(request);};
  await act(async()=>{
   const title=f.host.querySelector('.proto-note .title')!;
   Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(title,'Changed title');
   title.dispatchEvent(new window.Event('input',{bubbles:true}));

  });
  await f.click(f.host.querySelector('.proto-note .toggle')!);
  assert.ok(f.host.querySelector('.editing-mode'));
  assert.match(f.host.querySelector('[role="alert"]')?.textContent??'',/Save unavailable/);
  assert.equal(f.host.querySelector<HTMLInputElement>('.proto-note .title')!.value,'Changed title');assert.equal(f.host.querySelector<HTMLInputElement>('.proto-note .title')!.readOnly,false);assert.equal(f.s.state.cards.get(f.task)?.title,'Task');assert.equal(visual(f.host).getAttribute('contenteditable'),null);
  f.c.execute=execute;
  await f.click(f.host.querySelector('.proto-note .toggle')!);
  assert.ok(!f.host.querySelector('.editing-mode'));
  assert.equal(f.s.state.cards.get(f.task)?.title,'Changed title');
  assert.equal(f.s.state.cards.get(f.task)?.content,'**Safe** <img src=x onerror=alert(1)>');
 } finally {f.c.execute=execute;f.dispose();}
});


test('resizing pauses at minimum and collapses only after continued overdrag',async()=>{
 const f=await fixture('floating');
 try {
  const host=f.host.querySelector('.card-regions') as HTMLElement, panel=f.host.querySelector('.child-region') as HTMLElement;
  host.getBoundingClientRect=()=>({width:600,height:400,left:0,top:0,right:600,bottom:400,x:0,y:0,toJSON(){}});
  panel.getBoundingClientRect=()=>({width:600,height:180,left:0,top:220,right:600,bottom:400,x:0,y:220,toJSON(){}});
  await act(async()=>{
   f.host.querySelector('.child-region-resizer')!.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,button:0,clientY:220}));
   document.dispatchEvent(new window.MouseEvent('pointermove',{bubbles:true,clientY:220+180-CHILD_BAR_MIN_HEIGHT+10}));
  });
  assert.ok(!panel.classList.contains('child-region-collapsed'));
  assert.equal(panel.style.height,`min(${CHILD_BAR_MIN_HEIGHT}px, 100%)`);
  await act(async()=>{
   document.dispatchEvent(new window.MouseEvent('pointermove',{bubbles:true,clientY:400-CHILD_BAR_MIN_HEIGHT/2+1}));
   document.dispatchEvent(new window.MouseEvent('pointerup',{bubbles:true})); await f.c.flush();
  });
  assert.ok(panel.classList.contains('child-region-collapsed'));
  assert.deepEqual(f.c.view.windows[f.task]?.childArea,{width:0,height:0});
 } finally {f.dispose();}
});


test('switching fields saves the first and focuses only the next editor',async()=>{
 const f=await fixture('floating');
 try {
  const title=f.host.querySelector('.proto-note .title') as HTMLInputElement;
  await f.click(title);
  await act(async()=>{
   Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(title,'Separate title');
   title.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
  await f.click(f.host.querySelector('.preview')!);
  assert.equal(f.s.state.cards.get(f.task)?.title,'Separate title');
  assert.equal(title.readOnly,true);
  assert.equal(document.activeElement,visual(f.host));assert.equal(document.activeElement?.getAttribute('aria-label'),uiText('bodyEditor.label'));
  await f.click(title);
  assert.equal(visual(f.host).getAttribute('contenteditable'),null);
  assert.equal(title.readOnly,false); assert.equal(document.activeElement,title);
 } finally {f.dispose();}
});


test('clicking outside the active editor saves and returns to viewing',async()=>{
 const f=await fixture('floating');
 try {
  const title=f.host.querySelector('.proto-note .title') as HTMLInputElement;
  await f.click(title); await f.click(title); assert.equal(title.readOnly,false);
  await f.click(f.host.querySelector('.note-breadcrumb')!); assert.equal(title.readOnly,true);
  await f.click(f.host.querySelector('.preview')!);
  const body=visual(f.host);await replaceBody(f,'Outside saved');
  await f.click(f.host.querySelector('.child-region')!);
  assert.ok(f.host.querySelector('[data-visual-editor]')===body);assert.equal(body.getAttribute('contenteditable'),null);
  assert.equal(f.s.state.cards.get(f.task)?.content,'Outside saved');
 } finally {f.dispose();}
});

test('waterfall card baseline also defines the horizontal card minimum height',()=>{
 assert.equal(CHILD_CARD_MIN_HEIGHT,70);
});


test('all card layout minima include shared grid size and scrollbar clearance',async()=>{
 const {CARD_MIN_WIDTH,CARD_MIN_HEIGHT,CHILD_MIN_WIDTH,BOARD_NOTE_MIN_WIDTH,BOARD_MAIN_MIN_WIDTH}=await import('../src/core/layout-metrics.ts');
 const {verticalChildArea}=await import('../src/webview/CardRegions.tsx');
 assert.equal(CARD_MIN_WIDTH,140); assert.equal(CARD_MIN_HEIGHT,70);
 assert.equal(CHILD_MIN_WIDTH,178);
 assert.deepEqual(verticalChildArea(CHILD_MIN_WIDTH-1),{width:CHILD_MIN_WIDTH,height:9999});
 assert.deepEqual(verticalChildArea(CHILD_MIN_WIDTH/2),{width:CHILD_MIN_WIDTH,height:9999});
 assert.deepEqual(verticalChildArea(CHILD_MIN_WIDTH/2-1),{width:0,height:0});
 assert.equal(BOARD_NOTE_MIN_WIDTH,552); assert.equal(BOARD_MAIN_MIN_WIDTH,804);
});


test('manager backdrop finishes editing without changing the inactive field',async()=>{
 const f=await fixture();
 try {
  await f.openManagerTask();
  await f.click(f.host.querySelector('.editable-title')!);
  await act(async()=>{
   const title=f.host.querySelector('input[aria-label="卡片标题"]')!;
   Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(title,'Backdrop saved');
   title.dispatchEvent(new window.Event('input',{bubbles:true}));
  });
  await f.click(f.host.querySelector('.modal-backdrop')!);
  assert.ok(!f.host.querySelector('.edit-dialog'));
  assert.equal(f.s.state.cards.get(f.task)?.title,'Backdrop saved');
  assert.equal(f.s.state.cards.get(f.task)?.content,'**Safe** <img src=x onerror=alert(1)>');
 } finally {f.dispose();}
});


test('canvas hides body and keeps a floating creation action',async()=>{
 const f=await fixture('floating');
 try {
  await f.click(f.host.querySelector('.note-breadcrumb .card-menu-button')!);
  await f.click([...f.host.querySelectorAll('.layout-choices button')].find(e=>e.textContent==='画布')!);
  assert.ok(!f.host.querySelector('.proto-note .body'));
  assert.ok(f.host.querySelector('.canvas-viewport'));
  assert.equal(f.host.querySelectorAll('.floating-add-card').length,1);
 } finally {f.dispose();}
});

test('configured middle and right drags pan the canvas, preserve tree entries and cancel back to the original view',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const dragged:(string|undefined)[]=[]; const f=await fixture('floating',(_id,_event,mode)=>dragged.push(mode));
 try {
  await act(async()=>f.c.execute({kind:'interaction',canvasDragBindings:{left:'window-desktop',right:'pan',combined:'pan'}}));
  await f.click(f.host.querySelector('.note-breadcrumb .card-menu-button')!);
  await f.click([...f.host.querySelectorAll('.layout-choices button')].find(e=>e.textContent==='画布')!);
  await act(async()=>{await f.c.execute({kind:'create',parent:f.task,title:'Canvas child'});});
  const before=JSON.stringify(f.s.state.children.get(f.task));
  const viewport=f.host.querySelector('.canvas-viewport') as HTMLElement;
  const surface=f.host.querySelector('.canvas-surface') as HTMLElement;
  for(const button of [1,2]) {
   await act(async()=>{
    const handle=button===1 ? f.host.querySelector('.canvas-card .task-card')! : viewport;
    handle.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button,buttons:button===1?4:2,clientX:100,clientY:100}));
    document.dispatchEvent(new window.MouseEvent('pointermove',{bubbles:true,buttons:button===1?4:2,clientX:150,clientY:130}));
    document.dispatchEvent(new window.MouseEvent('pointerup',{bubbles:true,button,buttons:0,clientX:150,clientY:130}));context.mock.timers.tick(0);
   });
  }
  assert.equal(surface.style.transform,'translate3d(100px,60px,0) scale(1)');
  assert.deepEqual(dragged,['pan','pan'],'forwarding pan intent must never request native window movement');
  assert.equal(JSON.stringify(f.s.state.children.get(f.task)),before);
  const menu=new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true});viewport.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented,true);
  await act(async()=>{
   viewport.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true,button:1,buttons:4,clientX:100,clientY:100}));
   document.dispatchEvent(new window.MouseEvent('pointermove',{bubbles:true,buttons:4,clientX:0,clientY:0}));
   document.dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));context.mock.timers.tick(0);
  });
  assert.equal(surface.style.transform,'translate3d(100px,60px,0) scale(1)');
 } finally {f.dispose();}
});
