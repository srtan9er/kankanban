import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { createBufferedFs } from '../src/platform/buffered-fs-ops.ts';
import { toAsync } from '../src/platform/async-fs-ops.ts';
import { openSession, createCard, moveCard, setLayout } from '../src/core/workspace.ts';
import { rendererOf } from '../src/core/renderer.ts';

test('concurrent flush callers append each event exactly once', async () => {
  const buffer = createBufferedFs();
  const disk = createMemoryFs();
  buffer.ops.mkdirp('/ws');
  await buffer.flushTo(toAsync(disk.ops));
  buffer.ops.appendFile('/ws/events', 'one\n');
  await Promise.all([buffer.flushTo(toAsync(disk.ops)), buffer.flushTo(toAsync(disk.ops))]);
  assert.equal(disk.ops.readFile('/ws/events'), 'one\n');
  assert.equal(buffer.pendingCount(), 0);
});

test('choosing grid actually renders a normal card as grid', () => {
  const session = openSession('/ws', { ops: createMemoryFs().ops });
  const id = createCard(session, { parentId: null, title: 'Project' });
  setLayout(session, id, 'grid');
  assert.equal(rendererOf(session.state, id), 'grid');
});

test('prefab definitions cannot move outside their library, even via core', () => {
  const session = openSession('/ws', { ops: createMemoryFs().ops });
  const id = createCard(session, { parentId: '003', title: 'Template', isPrefab: true });
  const events = session.events.length;
  assert.throws(() => moveCard(session, id, null, 0), /预制体/);
  assert.equal(session.events.length, events);
});
