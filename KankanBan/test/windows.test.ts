/**
 * 不变量 W′ 的验收（§2.8 / §10 阶段二）。
 *
 * 文档说 W′ 的两条推论是"拖进容器 → 不再是桌面卡片、浮动到桌面 → 成为桌面卡片"。
 * 这里把它们当成**可执行断言**：每一步操作后都算一次 `desktopCards`（窗口**候选**集合），
 * 看差集是不是恰好该增/减那一个。
 *
 * 「候选 ≠ 已开」那一半（关窗不改树、可从 main 重开）在 `desktop-windows.test.ts`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { applyEvent } from '../src/core/state.ts';
import type { CoreState } from '../src/core/state.ts';
import { assertInvariantW, desktopCards, windowTransition } from '../src/core/windows.ts';
import { createCard, deleteCard, moveCard, openSession, setField, undoLast } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

function makeSession(): Session {
  let counter = 0;
  return openSession('/w', {
      builtins: false,
    clientId: 'w',
    ops: createMemoryFs().ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
  });
}

/** 跑一段操作，每步之后检查 W′ 并返回**桌面卡片**集合的变化。 */
function track(session: Session, step: () => void): { before: string[]; after: string[] } {
  const before = desktopCards(session.state);
  step();
  const after = desktopCards(session.state);
  assertInvariantW(session.state, '每步之后');
  return { before, after };
}

// ── 桌面卡片就是根卡集合 ──────────────────────────────────────────────────────

test('新建的根卡成为桌面卡片；子卡不是', () => {
  const session = makeSession();

  const root = createCard(session, { parentId: null, title: '根' });
  assert.deepEqual(desktopCards(session.state), [root]);

  const child = createCard(session, { parentId: root, title: '子' });
  assert.deepEqual(desktopCards(session.state), [root], '子卡不是桌面卡片，不该有窗口');

  const second = createCard(session, { parentId: null, title: '第二张根卡' });
  assert.deepEqual(desktopCards(session.state), [root, second].sort());
  void child;
});

test('桌面卡片按 id 排序：同一个状态永远给同一个数组（差集才可信）', () => {
  const session = makeSession();
  for (const title of ['c', 'a', 'b']) createCard(session, { parentId: null, title });

  const first = desktopCards(session.state);
  const second = desktopCards({ ...session.state });

  assert.deepEqual(first, second);
  assert.deepEqual(first, [...first].sort());
});

// ── §2.8 的两条推论（v7：都只到"桌面卡片"这一层为止） ────────────────────────

test('把根卡拖进容器 → 它不再是桌面卡片', () => {
  const session = makeSession();
  const container = createCard(session, { parentId: null, title: '容器' });
  const loose = createCard(session, { parentId: null, title: '浮在外面的卡' });

  assert.deepEqual(desktopCards(session.state), [container, loose].sort());

  const { before, after } = track(session, () => moveCard(session, loose, container, 0));

  assert.deepEqual(windowTransition(before, after), { opened: [], closed: [loose] });
});

test('把子卡浮动到桌面 → 它成为桌面卡片（**不**自动开窗，要显式提出）', () => {
  const session = makeSession();
  const container = createCard(session, { parentId: null, title: '容器' });
  const child = createCard(session, { parentId: container, title: '子卡' });

  assert.deepEqual(desktopCards(session.state), [container]);

  const { before, after } = track(session, () => moveCard(session, child, null, 0));

  assert.deepEqual(windowTransition(before, after), { opened: [child], closed: [] });
});

test('在容器之间移动不产生任何桌面卡片增减', () => {
  const session = makeSession();
  const a = createCard(session, { parentId: null, title: 'A 容器' });
  const b = createCard(session, { parentId: null, title: 'B 容器' });
  const child = createCard(session, { parentId: a, title: '子卡' });

  const { before, after } = track(session, () => moveCard(session, child, b, 0));

  assert.deepEqual(windowTransition(before, after), { opened: [], closed: [] });
  assert.deepEqual(desktopCards(session.state), [a, b].sort());
});

test('删掉一张根卡 → 它不再是桌面卡片', () => {
  const session = makeSession();
  const keep = createCard(session, { parentId: null, title: '留着' });
  const gone = createCard(session, { parentId: null, title: '要删' });

  const { before, after } = track(session, () => deleteCard(session, gone));

  assert.deepEqual(windowTransition(before, after), { opened: [], closed: [gone] });
  assert.deepEqual(after, [keep]);
});

test('删掉容器连同它的子卡 → 只少了容器那一张桌面卡片（子卡本来就不是）', () => {
  const session = makeSession();
  const container = createCard(session, { parentId: null, title: '容器' });
  createCard(session, { parentId: container, title: '子1' });
  createCard(session, { parentId: container, title: '子2' });

  const { before, after } = track(session, () => deleteCard(session, container));

  assert.deepEqual(windowTransition(before, after), { opened: [], closed: [container] });
  assert.deepEqual(after, []);
});

test('撤销会把桌面卡片集合原样还原', () => {
  const session = makeSession();
  const container = createCard(session, { parentId: null, title: '容器' });
  const loose = createCard(session, { parentId: null, title: '松的' });
  const before = desktopCards(session.state);

  moveCard(session, loose, container, 0);
  assert.deepEqual(desktopCards(session.state), [container]);

  const { after } = track(session, () => undoLast(session));

  assert.deepEqual(after, before, '撤销一次移动必须把窗口还回来');
});

// ── W 的护栏：它得能抓到真的坏 ────────────────────────────────────────────────

test('children 指向不存在的卡时 assertInvariantW 报错', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });

  const broken: CoreState = {
    cards: session.state.cards,
    children: new Map([[root, [{ id: 'ghost' }]]]),
    lastAppliedSeq: 1,
  };

  assert.throws(() => assertInvariantW(broken), /不存在的卡 ghost/);
});

test('已删除的卡仍被 children 引用时 assertInvariantW 报错', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '子' });
  deleteCard(session, child);

  // 手动把它塞回 children，模拟"删除没删干净"
  const deleted = session.state.cards.get(child);
  assert.ok(deleted !== undefined);
  const broken: CoreState = {
    cards: session.state.cards,
    children: new Map([[root, [{ id: child }]]]),
    lastAppliedSeq: session.state.lastAppliedSeq,
  };

  assert.throws(() => assertInvariantW(broken), /已删除的卡仍被 children 引用/);
});

test('replay 出来的状态也满足 W（不只是实时应用成立）', () => {
  const session = makeSession();
  const container = createCard(session, { parentId: null, title: '容器' });
  const loose = createCard(session, { parentId: null, title: '松的' });
  moveCard(session, loose, container, 0);
  moveCard(session, loose, null, 0);

  const replayed = session.events.reduce(applyEvent, {
    cards: new Map(),
    children: new Map(),
    lastAppliedSeq: 0,
  } satisfies CoreState);

  assertInvariantW(replayed, 'replay 结果');
  assert.deepEqual(desktopCards(replayed), desktopCards(session.state));
});

// ── W 接进了运行时路径（不只是测试里调用） ──────────────────────────────────

test('结构改动之后会当场校验 W：状态被写坏时操作直接失败', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: '子' });

  // 人为把状态写坏（children 指向不存在的卡），模拟 core 自己算错
  session.state = {
    ...session.state,
    children: new Map([[root, [{ id: 'ghost' }]]]),
  };

  assert.throws(
    () => createCard(session, { parentId: root, title: '新卡' }),
    /不变量 W/,
    '结构事件之后必须校验，否则坏状态会一路带到下次加载',
  );
});

test('field_set 之后不校验 W —— 它不可能破坏结构，没必要每次全量扫描', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });

  session.state = {
    ...session.state,
    children: new Map([[root, [{ id: 'ghost' }]]]),
  };

  // 改字段照常成功：这条路径上做全量校验只是白扫码
  assert.doesNotThrow(() => setField(session, root, '/title', '改过'));
});
