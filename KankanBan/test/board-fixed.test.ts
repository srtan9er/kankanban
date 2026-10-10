import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSession, createCard, moveCard, deleteCard } from '../src/core/workspace.ts';
import { executeAction } from '../src/core/actions.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

test('boards keep three structural columns while allowing event cards inside columns', () => {
  const s = openSession('/board', { ops: createMemoryFs().ops });
  const board = executeAction(s, { kind: 'create', parent: null, title: 'Board', layout: 'columns' }).createdId!;
  const columns = s.state.children.get(board)!;
  assert.equal(columns.length, 3);
  assert.throws(() => executeAction(s, {kind:'create',parent:board,title:'Fourth'}), /三列|列内/);
  assert.throws(() => createCard(s, {parentId:board,title:'Bypass'}), /三列|列内/);
  assert.throws(() => moveCard(s,columns[0]!.id,null,0), /三列|固定/);
  assert.throws(() => deleteCard(s,columns[0]!.id), /三列|固定/);
  const event = executeAction(s, {kind:'create',parent:columns[0]!.id,title:'Event'}).createdId!;
  assert.equal(s.state.children.get(columns[0]!.id)?.[0]?.id,event);
  moveCard(s,event,columns[1]!.id,0);
  assert.equal(s.state.children.get(columns[1]!.id)?.[0]?.id,event);
});
import { normalizeBoards } from '../src/core/boards.ts';
import { setLayout, undoLast } from '../src/core/workspace.ts';

test('old boards fill missing columns and preserve overflow cards and descendants',()=>{
  const s=openSession('/legacy',{ops:createMemoryFs().ops});
  const old=createCard(s,{parentId:null,title:'Legacy',layout:'ordered'});
  const cols=['One','Two','Three','Four'].map(title=>createCard(s,{parentId:old,title,layout:'ordered'}));
  const task=createCard(s,{parentId:cols[3]!,title:'Keep me'});
  setLayout(s,old,'columns');
  normalizeBoards(s);
  assert.equal(s.state.children.get('001')?.length,3);
  assert.equal(s.state.children.get(old)?.length,3);
  assert.equal(s.state.children.get(cols[2]!)?.[0]?.id,cols[3]);
  assert.equal(s.state.children.get(cols[3]!)?.[0]?.id,task);
  const count=s.events.length; normalizeBoards(s); assert.equal(s.events.length,count);
  assert.throws(()=>undoLast(s),/固定三列/);
});

test('legacy overflow also survives when the third column is itself a board',()=>{
  const s=openSession('/nested-legacy',{ops:createMemoryFs().ops});
  const board=createCard(s,{parentId:null,title:'Outer',layout:'ordered'});
  createCard(s,{parentId:board,title:'One'}); createCard(s,{parentId:board,title:'Two'});
  const nested=createCard(s,{parentId:board,title:'Nested',layout:'columns'});
  const extra=createCard(s,{parentId:board,title:'Overflow'});
  setLayout(s,board,'columns'); normalizeBoards(s);
  assert.equal(s.state.children.get(board)?.length,3);
  assert.equal(s.state.children.get(nested)?.length,3);
  const target=s.state.children.get(nested)![2]!.id;
  assert.equal(s.state.children.get(target)?.[0]?.id,extra);
});
