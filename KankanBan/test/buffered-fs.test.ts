/**
 * 写回缓冲的测试。两层验证：
 *   1. **等价性**：缓冲刷新到后端之后，后端的内容必须与"直接写后端"逐字节一致
 *   2. **次序**：journal 在批内原样保留 §4.2 的"日志先于状态"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openWorkspace } from '../src/core/storage/workspace-io.ts';
import type { FsOps } from '../src/core/storage/fs-ops.ts';
import { createCard, moveCard, openSession, setField } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { toAsync } from '../src/platform/async-fs-ops.ts';
import { createBufferedFs } from '../src/platform/buffered-fs-ops.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

const ROOT = '/ws';

function makeSession(ops: FsOps): Session {
  let counter = 0;
  return openSession(ROOT, {
      builtins: false,
    clientId: 'buf',
    ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
  });
}

const scenario = (session: Session): void => {
  const p = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
  const a = createCard(session, { parentId: p, title: 'A' });
  const b = createCard(session, { parentId: p, title: 'B' });
  moveCard(session, b, p, 0);
  setField(session, a, '/content', '正文');
};

test('缓冲刷新后的后端内容与直接写后端逐字节一致', async () => {
  // 直接写
  const direct = createMemoryFs();
  scenario(makeSession(direct.ops));

  // 经缓冲写
  const buffered = createBufferedFs();
  const session = makeSession(buffered.ops);
  scenario(session);

  assert.ok(buffered.pendingCount() > 0, 'core 写完之后缓冲里应当有积压');

  const backend = createMemoryFs();
  await buffered.flushTo(toAsync(backend.ops));

  assert.equal(buffered.pendingCount(), 0);
  assert.deepEqual(backend.snapshot(), direct.snapshot());
});

test('刷新之后用后端重开工作区，状态与内存里一致', async () => {
  const buffered = createBufferedFs();
  const session = makeSession(buffered.ops);
  scenario(session);

  const backend = createMemoryFs();
  await buffered.flushTo(toAsync(backend.ops));

  const { state } = openWorkspace(ROOT, backend.ops);

  assert.deepEqual([...state.cards.keys()].sort(), [...session.state.cards.keys()].sort());
  assert.deepEqual(state.children.get('c1'), session.state.children.get('c1'));
  assert.equal(state.cards.get('c2')?.content, '正文');
});

test('journal 里"日志 append 在状态写入之前"（§4.2 的次序在批内保持）', () => {
  const buffered = createBufferedFs();
  const session = makeSession(buffered.ops);
  createCard(session, { parentId: null, title: 'P' });

  const journal = [...buffered.journal()];
  const appendAt = journal.findIndex((e) => e.op === 'appendFile');
  const firstCardWriteAt = journal.findIndex((e) => e.op === 'writeFile' && e.args[0]?.includes('/cards/'));

  assert.ok(appendAt >= 0, '应当有 appendFile');
  assert.ok(firstCardWriteAt >= 0, '应当有卡片文件写入');
  assert.ok(appendAt < firstCardWriteAt, `日志必须先于状态：append@${appendAt} 应早于 cards@${firstCardWriteAt}`);
});

test('刷新失败时 journal 不丢，可以在**同一个**后端上重试', async () => {
  const buffered = createBufferedFs();
  const session = makeSession(buffered.ops);
  createCard(session, { parentId: null, title: 'P' });

  const pendingBefore = buffered.pendingCount();
  assert.ok(pendingBefore > 0);

  const backend = createMemoryFs();
  let failing = true;
  let writes = 0;
  const flaky: FsOps = {
    ...backend.ops,
    writeFile: (path: string, data: string) => {
      writes += 1;
      if (failing && writes > 2) throw new Error('后端炸了');
      backend.ops.writeFile(path, data);
    },
  };

  await assert.rejects(() => buffered.flushTo(toAsync(flaky)), /后端炸了/);
  assert.ok(buffered.pendingCount() > 0, '失败后必须还有积压，否则日志就丢了');
  assert.ok(buffered.pendingCount() < pendingBefore, '已经成功的那些不该重来');

  // 后端恢复后重试。**必须是同一个后端** —— 游标只保证"不重放已完成的那些"，
  // 那是以"后端没换过"为前提的。
  failing = false;
  await buffered.flushTo(toAsync(flaky));
  assert.equal(buffered.pendingCount(), 0);

  const { state } = openWorkspace(ROOT, backend.ops);
  assert.deepEqual([...state.cards.values()].map((c) => c.title), ['P']);
});

test('读操作不进 journal（否则刷新会白白重放一堆读）', () => {
  const buffered = createBufferedFs();
  buffered.ops.mkdirp('/d');
  buffered.ops.writeFile('/d/a.txt', 'x');
  const before = buffered.pendingCount();

  buffered.ops.exists('/d/a.txt');
  buffered.ops.readFile('/d/a.txt');
  buffered.ops.readDir('/d');

  assert.equal(buffered.pendingCount(), before);
});
