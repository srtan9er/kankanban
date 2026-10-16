import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { openSession, createCard, readCard } from '../src/core/workspace.ts';
import { executeAction } from '../src/core/actions.ts';
import { stateFingerprint } from '../src/core/subtree.ts';
import { openWorkspace } from '../src/core/storage/workspace-io.ts';

test('a torn compound append cannot replay half an instance', () => {
  const fs = createMemoryFs(); const s = openSession('/ws', { ops: fs.ops });
  const p = createCard(s, { parentId: '003', title: 'Template', isPrefab: true });
  createCard(s, { parentId: p, title: 'Child', isPrefab: true });
  const snapshot = fs.snapshot(); const before = stateFingerprint(s.state);
  executeAction(s, { kind: 'instantiate', id: p, parent: null });
  const log = fs.ops.readFile('/ws/.kkb/events.jsonl');
  const broken = createMemoryFs();
  for (const [path, text] of Object.entries(snapshot)) { broken.ops.mkdirp(path.slice(0, path.lastIndexOf('/'))); broken.ops.writeFile(path, text); }
  broken.ops.writeFile('/ws/.kkb/events.jsonl', log.split('\n').slice(0, -3).join('\n') + '\n');
  assert.equal(stateFingerprint(openWorkspace('/ws', broken.ops).state), before);
});

test('instantiate copies a subtree atomically and synchronizes accumulated changes only when requested', () => {
  const fs = createMemoryFs();
  const s = openSession('/ws', { ops: fs.ops });
  const p = createCard(s, { parentId: '003', title: 'Template', isPrefab: true });
  createCard(s, { parentId: p, title: 'Child', content: 'Original', isPrefab: true });
  const before = stateFingerprint(s.state);
  const instance = executeAction(s, { kind: 'instantiate', id: p, parent: null }).createdId!;
  assert.ok(instance && instance !== p);
  const child = s.state.children.get(instance)![0]!.id;
  assert.equal(s.state.cards.get(instance)?.prefabRef, p);
  assert.equal(s.state.cards.get(child)?.isPrefab, false);
  executeAction(s, { kind: 'undo' });
  assert.equal(stateFingerprint(s.state), before);
  const instance2 = executeAction(s, { kind: 'instantiate', id: p, parent: null }).createdId!;
  executeAction(s, { kind: 'edit', id: p, field: 'title', value: 'Updated' });
  assert.equal(s.state.cards.get(instance2)?.title, 'Template', 'template edits remain pending until an explicit synchronization');
  executeAction(s, { kind: 'prefab-sync', id: p, target: 'all' });
  assert.equal(s.state.cards.get(instance2)?.title, 'Updated');
  executeAction(s, { kind: 'edit', id: instance2, field: 'title', value: 'Override' });
  assert.deepEqual(s.state.cards.get(instance2)?.overrides, ['title']);
  executeAction(s, { kind: 'edit', id: p, field: 'content', value: 'Template content' });
  assert.equal(s.state.cards.get(instance2)?.content, '', 'unsynchronized source changes must not leak into the instance');
  executeAction(s, { kind: 'prefab-sync', id: p, target: 'all' });
  assert.equal(s.state.cards.get(instance2)?.content, 'Template content');
  assert.equal(s.state.cards.get(instance2)?.title, 'Override', 'synchronizing an unrelated field preserves the local title override');
  executeAction(s, { kind: 'prefab-sync', id: instance2, target: 'all' });
  assert.equal(s.state.cards.get(p)?.title, 'Override', 'the instance can explicitly publish its pending override to the template and siblings');
  assert.equal(s.state.cards.get(instance2)?.title, 'Override');
  assert.throws(() => executeAction(s, { kind: 'delete', id: p }), /实例/);
  executeAction(s, { kind: 'detach', id: instance2 });
  executeAction(s, { kind: 'delete', id: p });
  const reopened = openSession('/ws', { ops: fs.ops });
  assert.equal(reopened.state.cards.get(instance2)?.title, 'Override');
});

test('layout change and explicit board creation retain content and support plane placement', () => {
  const s = openSession('/ws', { ops: createMemoryFs().ops });
  const board = executeAction(s, { kind: 'create', parent: null, title: 'Board', layout: 'columns' }).createdId!;
  assert.equal(s.state.children.get(board)?.length, 3);
  const column = s.state.children.get(board)![0]!.id;
  const task = executeAction(s, { kind: 'create', parent: column, title: 'Task' }).createdId!;
  executeAction(s, { kind: 'move', id: task, parent: '002', index: 0, x: 150, y: 90 });
  assert.deepEqual(s.state.children.get('002')?.[0], { id: task, x: 150, y: 90, w: 220, h: 120, z: 0 });
  executeAction(s, { kind: 'layout', id: board, layout: 'plain' });
  assert.equal(s.state.children.get(board)?.length, 3);
  executeAction(s, { kind: 'undo' });
  assert.equal(s.state.cards.get(board)?.layout, 'columns');
});
import { dropIndex } from '../src/webview/drop-index.ts';

test('presentation references follow layout changes and detach without copying children', () => {
  const fs = createMemoryFs(); const s = openSession('/ws', { ops: fs.ops });
  const source = executeAction(s, { kind: 'create', parent: null, title: 'Style', layout: 'grid' }).createdId!;
  const target = executeAction(s, { kind: 'create', parent: null, title: 'Document' }).createdId!;
  const child = executeAction(s, { kind: 'create', parent: target, title: 'Own child' }).createdId!;
  executeAction(s, { kind: 'presentation', id: target, source });
  assert.equal(s.state.cards.get(target)?.layout, 'grid');
  executeAction(s, { kind: 'layout', id: source, layout: 'plane' });
  assert.equal(s.state.cards.get(target)?.layout, 'plane');
  assert.equal(s.state.cards.get(target)?.type, source);
  assert.deepEqual((s.state.children.get(target) ?? []).map(e => e.id), [child]);
  assert.ok('x' in s.state.children.get(target)![0]!);
  assert.throws(() => executeAction(s, { kind: 'delete', id: source }), /呈现来源/);
  executeAction(s, { kind: 'presentation', id: target, source: null });
  executeAction(s, { kind: 'delete', id: source });
  assert.equal(s.state.cards.get(target)?.layout, 'plane');
  assert.equal(openWorkspace('/ws', fs.ops).state.cards.get(target)?.type, null);
});

test('drop gaps account for removal only when reordering in the same parent', () => {
  const s = openSession('/ws', { ops: createMemoryFs().ops });
  const parent = createCard(s, { parentId: null, title: 'List', layout: 'ordered' });
  const ids = ['A', 'B', 'C'].map(title => createCard(s, { parentId: parent, title }));
  assert.equal(dropIndex(s.state, ids[0]!, parent, 2), 1);
  assert.equal(dropIndex(s.state, ids[2]!, parent, 0), 0);
  executeAction(s, { kind: 'move', id: ids[0]!, parent, index: dropIndex(s.state, ids[0]!, parent, 2) });
  assert.deepEqual(s.state.children.get(parent)?.map(e => e.id), [ids[1], ids[0], ids[2]]);
});
