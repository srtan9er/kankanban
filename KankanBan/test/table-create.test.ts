import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {DrawingBody} from '../src/webview/DrawingBody.tsx';
import {MarkdownEditor} from '../src/webview/MarkdownEditor.tsx';
import {setMarkdownEditorSelection} from '../src/webview/markdown-editor-model.ts';
import {EditMode} from '../src/webview/edit-mode.ts';
import {parseTables} from '../src/core/table-markdown.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {executeAction} from '../src/core/actions.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:(time:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id),OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
test('one button creates empty named 2 by 2 tables, visible in a second view and persisted through reopen',async()=>{
 const fs=createMemoryFs(),session=openSession('/quick-table',{ops:fs.ops}),id=createCard(session,{parentId:null,content:'Keep this text.'}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 const render=()=>root.render(createElement('div',{},...[0,1].map(key=>createElement(DrawingBody,{key,id,content:session.state.cards.get(id)!.content,send:async request=>{assert.equal(request.kind,'edit');executeAction(session,request as Extract<typeof request,{kind:'edit'}>);render();}}))));
 try{
  await act(async()=>render());
  const add=()=>document.querySelector<HTMLButtonElement>('.table-create-button');assert.ok(add(),'a discoverable one-click table button must exist');
  await act(async()=>add()!.click());await act(async()=>add()!.click());
  const text=session.state.cards.get(id)!.content,tables=parseTables(text);assert.ok(text.startsWith('Keep this text.\n'));
  assert.deepEqual(tables.map(table=>table.name),['table_0','table_1']);
  for(const table of tables){assert.equal(table.layout,'inline');assert.equal(table.data.rows.length,2);assert.equal(table.data.columns.length,2);assert.equal(table.data.cells.length,4);assert.ok(table.data.cells.every(cell=>cell.text===''));}
  assert.equal(host.querySelectorAll('.editable-table').length,4);
  assert.equal(openSession('/quick-table',{ops:fs.ops}).state.cards.get(id)!.content,text);
  await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());assert.ok(host.querySelector('.table-cell-editor'));
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('Ctrl+T inserts a stable table token at the body caret and supports undo',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);let value='Before After';
 const render=()=>root.render(createElement(MarkdownEditor,{value,onChange:next=>{value=next;render();}}));
 try{
  await act(async()=>render());const editor=host.querySelector<HTMLElement>('[data-markdown-editor]')!;editor.focus();setMarkdownEditorSelection(editor,7);
  await act(async()=>editor.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,bubbles:true,cancelable:true})));
  assert.equal(parseTables(value).length,1);assert.ok(value.startsWith('Before '));assert.ok(value.endsWith('After'));assert.equal(editor.querySelector('[data-markdown-token]')?.textContent?.trim(),'<table_0>');
  await act(async()=>editor.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true})));assert.equal(value,'Before After');
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('preview Ctrl+T creates a table, while browsing and cell text never use the insertion shortcut',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);let content='',editable=true,writes=0;
 const render=()=>root.render(createElement(EditMode.Provider,{value:{editable,busy:false}},createElement(DrawingBody,{id:'card',content,send:async request=>{if(request.kind==='edit'){writes++;content=request.value as string;render();}}})));
 const shortcut=(target:Element)=>target.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,bubbles:true,cancelable:true}));
 try{
  await act(async()=>render());await act(async()=>shortcut(host.querySelector('.drawing-body')!));assert.equal(writes,1);
  await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());const cell=host.querySelector('.table-cell-editor')!;await act(async()=>shortcut(cell));assert.equal(writes,1);
  editable=false;await act(async()=>render());assert.equal(document.querySelector('.table-create-button'),null);await act(async()=>shortcut(host.querySelector('.drawing-body')!));assert.equal(writes,1);
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('failed quick creation reports the error and can retry without changing existing body content',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);let content='Preserve me',attempts=0;
 const render=()=>root.render(createElement(DrawingBody,{id:'card',content,send:async request=>{attempts++;if(attempts===1)throw new Error('save failed');if(request.kind==='edit'){content=request.value as string;render();}}}));
 try{
  await act(async()=>render());const add=()=>document.querySelector<HTMLButtonElement>('.table-create-button')!;
  await act(async()=>add().click());assert.equal(content,'Preserve me');assert.match(host.querySelector('[role=alert]')!.textContent!,/save failed/);assert.equal(add().disabled,false);
  await act(async()=>add().click());assert.equal(attempts,2);assert.ok(content.startsWith('Preserve me\n'));assert.equal(parseTables(content).length,1);assert.equal(host.querySelector('[role=alert]'),null);
 }finally{await act(async()=>root.unmount());host.remove();}
});
