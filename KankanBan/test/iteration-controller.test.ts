import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBufferedFs } from '../src/platform/buffered-fs-ops.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { toAsync } from '../src/platform/async-fs-ops.ts';
import { openSession } from '../src/core/workspace.ts';
import { emptyViewState } from '../src/core/view-state.ts';
import { WorkspaceController } from '../src/webview/controller.ts';

test('queued actions acknowledge only durable state and stay replayable after restart', async () => {
  const b = createBufferedFs(), disk = createMemoryFs();
  const session = openSession('/ws', { ops: b.ops });
  const c = new WorkspaceController(session, emptyViewState(), b, toAsync(disk.ops));
  const [a, d] = await Promise.all([c.execute({ kind: 'create', parent: null, title: 'A' }), c.execute({ kind: 'create', parent: null, title: 'B' })]);
  const restored = openSession('/ws', { ops: disk.ops });
  assert.equal(restored.state.cards.get(a.createdId!)?.title, 'A');
  assert.equal(restored.state.cards.get(d.createdId!)?.title, 'B');
  assert.equal(new Set(restored.events.map(e => e.seq)).size, restored.events.length);
  assert.equal(b.pendingCount(), 0);
});

test('failed persistence is visible, retry drains it without duplicating the event', async () => {
  const b = createBufferedFs(), disk = createMemoryFs();
  const backend = toAsync(disk.ops);
  const c = new WorkspaceController(openSession('/ws', { ops: b.ops }), emptyViewState(), b, backend);
  await c.flush();
  const append = backend.appendFile;
  backend.appendFile = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(c.execute({ kind: 'create', parent: null, title: 'Keep me' }), /disk unavailable/);
  assert.ok(b.pendingCount() > 0);
  backend.appendFile = append;
  await c.retry();
  const restored = openSession('/ws', { ops: disk.ops });
  assert.equal([...restored.state.cards.values()].filter(card => card.title === 'Keep me').length, 1);
  assert.equal(new Set(restored.events.map(event => event.seq)).size, restored.events.length);
  assert.equal(c.error, '');
});

import { readViewState } from '../src/core/view-state.ts';
test('child region width and height survive reopening view state',async()=>{
  const b=createBufferedFs(), disk=createMemoryFs();
  const c=new WorkspaceController(openSession('/ws',{ops:b.ops}),emptyViewState(),b,toAsync(disk.ops));
  await c.execute({kind:'view',id:'001',childArea:{width:280,height:150}});
  assert.deepEqual(readViewState('/ws',disk.ops).windows['001']?.childArea,{width:280,height:150});
  await assert.rejects(c.execute({kind:'view',id:'001',childArea:{width:NaN,height:150}}),/尺寸无效/);
});
