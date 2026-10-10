/**
 * `field_set` 的**写侧类型校验**。
 *
 * 【起因】CLI 第一次实跑时，`edit Card1 --set /title=123` **成功了**：
 * 一个数字被写进 `cards/Card1.md` 的 frontmatter，而读侧的 `parseCard` 要求字符串 ——
 * 于是**整个工作区再也打不开**。更糟的是 `undo` 也没法用：
 * 读不出工作区就没有会话，没有会话就没有撤销。一次误写 = 工作区被写死。
 *
 * 写侧原来只校验**字段名**（`SETTABLE_FIELDS`），不校验**值的类型**。
 * 这个文件把那条线补上，并且钉住"写侧与读侧的类型表不许漂移"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { openSession, setField } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import type { FsOps } from '../src/core/storage/fs-ops.ts';

function makeSession(ops: FsOps): Session {
  let counter = 0;
  return openSession('/w', {
    builtins: false,
    clientId: 't',
    ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
  });
}

/** 每个可写字段：一个合法值 + 一批必须被拒的值。 */
const CASES: ReadonlyArray<{ path: `/${string}`; good: unknown; bad: unknown[] }> = [
  { path: '/title', good: '文字', bad: [123, null, true, ['x'], { a: 1 }] },
  { path: '/content', good: '正文', bad: [123, null, true, {}] },
  { path: '/createdBy', good: 'me', bad: [1, null, false] },
  { path: '/type', good: 'Card1', bad: [123, true, {}] },
  { path: '/prefabRef', good: 'Card1', bad: [1, false, []] },
  { path: '/editingBy', good: 'me', bad: [1, false, {}] },
  { path: '/createdAt', good: 1, bad: ['1', null, true] },
  { path: '/isPrefab', good: true, bad: [1, 'true', null] },
  { path: '/overrides', good: ['a'], bad: ['a', [1], null, {}] },
  // `/updatedAt` **不在这里**：它现在是从事件日志派生的（= 指向这张卡的最后一条事件的时间），
  // 已被 `field_set` 明确拒绝，见 `test/updated-at.test.ts`
];

test('每个可写字段：合法值写得进去', () => {
  const ops = createMemoryFs().ops;
  const session = makeSession(ops);
  const id = 'Card1';
  session.state.cards.set(id, {
    id,
    title: 't',
    content: '',
    type: null,
    layout: 'plain',
    isPrefab: false,
    prefabRef: null,
    overrides: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: 't',
    editingBy: null,
    deleted: false,
  });

  for (const { path, good } of CASES) {
    assert.doesNotThrow(() => setField(session, id, path, good), `${path} 应当接受 ${JSON.stringify(good)}`);
  }
});

test('每个可写字段：类型不对的值**当场被拒**', () => {
  const ops = createMemoryFs().ops;
  const session = makeSession(ops);
  const id = 'Card1';
  session.state.cards.set(id, {
    id,
    title: 't',
    content: '',
    type: null,
    layout: 'plain',
    isPrefab: false,
    prefabRef: null,
    overrides: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: 't',
    editingBy: null,
    deleted: false,
  });

  for (const { path, bad } of CASES) {
    for (const value of bad) {
      assert.throws(
        () => setField(session, id, path, value),
        /需要|实际/,
        `${path} 不该接受 ${JSON.stringify(value)}`,
      );
    }
  }
});

test('被拒之后状态一个字都没变（不是"写了一半才发现"）', () => {
  const ops = createMemoryFs().ops;
  const session = makeSession(ops);
  const id = 'Card1';
  session.state.cards.set(id, {
    id,
    title: '原名',
    content: '',
    type: null,
    layout: 'plain',
    isPrefab: false,
    prefabRef: null,
    overrides: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: 't',
    editingBy: null,
    deleted: false,
  });
  const eventsBefore = session.events.length;

  assert.throws(() => setField(session, id, '/title', 123));

  assert.equal(session.state.cards.get(id)?.title, '原名');
  assert.equal(session.events.length, eventsBefore, '不该留下半条事件');
});

test('**防砖**：被拒的写入不落盘，工作区仍然能重新打开', () => {
  const ops = createMemoryFs().ops;
  const session = makeSession(ops);
  const id = 'Card1';
  session.state.cards.set(id, {
    id,
    title: '原名',
    content: '',
    type: null,
    layout: 'plain',
    isPrefab: false,
    prefabRef: null,
    overrides: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: 't',
    editingBy: null,
    deleted: false,
  });

  assert.throws(() => setField(session, id, '/title', 123));
  assert.throws(() => setField(session, id, '/overrides', 'a'));

  // 这一句就是当初炸掉的那条路径：写坏了就再也读不出来
  assert.doesNotThrow(
    () => makeSession(ops),
    '一次非法写入不该让工作区变成打不开的状态',
  );
});

test('合法值走完「写 → 盘 → 读」的往返：写侧与读侧的类型表不许漂移', () => {
  const ops = createMemoryFs().ops;
  const session = makeSession(ops);
  const id = 'Card1';
  session.state.cards.set(id, {
    id,
    title: 't',
    content: '',
    type: null,
    layout: 'plain',
    isPrefab: false,
    prefabRef: null,
    overrides: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: 't',
    editingBy: null,
    deleted: false,
  });

  // 先落一次盘，让 cards/Card1.md 真的存在
  setField(session, id, '/title', '写一遍');
  for (const { path, good } of CASES) setField(session, id, path, good);

  const reread = makeSession(ops);
  const card = reread.state.cards.get(id);
  assert.ok(card !== undefined);

  for (const { path, good } of CASES) {
    const key = path.slice(1);
    assert.deepEqual(
      (card as unknown as Record<string, unknown>)[key],
      good,
      `${path} 写进去再读出来应当一模一样（写侧/读侧类型表漂移了？）`,
    );
  }
});
