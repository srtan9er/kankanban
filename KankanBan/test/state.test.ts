import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyEvent, emptyState } from '../src/core/state.ts';
import type { CoreState } from '../src/core/state.ts';
import type {
  CardId,
  CardEvent,
  CardFields,
  ChildEntry,
  OrderedEntry,
  PlainEntry,
  SubtreeSnapshot,
} from '../src/core/types.ts';

// ── 测试夹具 ───────────────────────────────────────────────────────────────────

function card(id: string, over: Partial<CardFields> = {}): CardFields {
  return {
    id,
    title: id,
    content: '',
    type: null,
    layout: 'plain',
    isPrefab: false,
    prefabRef: null,
    overrides: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'test',
    editingBy: null,
    deleted: false,
    ...over,
  };
}

let seq = 0;
function env() {
  seq += 1;
  return { id: `e${seq}`, seq, clientId: 'test', timestamp: seq * 1000 };
}

function create(id: string, parentId: CardId | null = null, entry: ChildEntry | null = null): CardEvent {
  return { ...env(), cardId: id, type: 'card_create', parentId, entry, fields: card(id) };
}

/** 从一串事件折出状态 —— 与生产代码走同一个 reducer。 */
function fold(events: CardEvent[]): CoreState {
  return events.reduce(applyEvent, emptyState());
}

const ord = (id: string, order: number): OrderedEntry => ({ id, order });
const plain = (id: string): PlainEntry => ({ id });

// ── 切片 1：card_create ────────────────────────────────────────────────────────

test('card_create 应用到空状态后，卡片字段进入状态', () => {
  const next = applyEvent(emptyState(), create('c1'));

  assert.equal(next.cards.get('c1')?.title, 'c1');
  assert.equal(next.lastAppliedSeq, 1);
});

test('card_create 带父卡时，条目挂到父卡 children 末尾', () => {
  const next = fold([create('p'), create('a', 'p', plain('a')), create('b', 'p', plain('b'))]);

  assert.deepEqual(next.children.get('p'), [plain('a'), plain('b')]);
});

test('card_create 不带父卡时，不进任何 children', () => {
  const next = fold([create('c1')]);

  assert.equal(next.children.size, 0);
});

// ── 切片 2：field_set ──────────────────────────────────────────────────────────

test('field_set 把 /title 写成 to，并把旧值放进 from', () => {
  const state = fold([create('c1')]);
  const event: CardEvent = {
    ...env(),
    cardId: 'c1',
    type: 'field_set',
    path: '/title',
    from: 'c1',
    to: '新标题',
  };

  const next = applyEvent(state, event);

  assert.equal(next.cards.get('c1')?.title, '新标题');
  assert.equal(event.from, 'c1', '事件必须自带旧值，否则 §4.3 的撤销无从下手');
});

test('field_set 是纯函数：不改动入参状态', () => {
  const state = fold([create('c1')]);
  const event: CardEvent = { ...env(), cardId: 'c1', type: 'field_set', path: '/title', from: 'c1', to: 'X' };

  applyEvent(state, event);

  assert.equal(state.cards.get('c1')?.title, 'c1');
});

test('field_set 写未知路径直接抛错', () => {
  const state = fold([create('c1')]);
  const event = { ...env(), cardId: 'c1', type: 'field_set', path: '/nope', from: undefined, to: 1 } as CardEvent;

  assert.throws(() => applyEvent(state, event), /未知字段路径|\/nope/);
});

test('field_set 不允许改 /id', () => {
  const state = fold([create('c1')]);
  const event = { ...env(), cardId: 'c1', type: 'field_set', path: '/id', from: 'c1', to: 'x' } as CardEvent;

  assert.throws(() => applyEvent(state, event), /\/id/);
});

// ── 切片 3：child_add / child_remove / child_update ────────────────────────────

test('child_add 把条目插到指定下标', () => {
  const state = fold([create('p'), create('a', 'p', ord('a', 0)), create('c', 'p', ord('c', 2))]);
  const event: CardEvent = { ...env(), cardId: 'b', type: 'child_add', parentId: 'p', entry: ord('b', 1), index: 1 };

  const next = applyEvent(state, event);

  assert.deepEqual(next.children.get('p'), [ord('a', 0), ord('b', 1), ord('c', 2)]);
});

test('child_remove 按下标移除条目', () => {
  const state = fold([create('p'), create('a', 'p', ord('a', 0)), create('b', 'p', ord('b', 1))]);
  const event: CardEvent = { ...env(), cardId: 'a', type: 'child_remove', parentId: 'p', entry: ord('a', 0), index: 0 };

  const next = applyEvent(state, event);

  assert.deepEqual(next.children.get('p'), [ord('b', 1)]);
});

test('child_update 替换下标处的条目（改 order 重排序）', () => {
  const state = fold([create('p'), create('a', 'p', ord('a', 0)), create('b', 'p', ord('b', 1))]);
  const event: CardEvent = {
    ...env(),
    cardId: 'a',
    type: 'child_update',
    parentId: 'p',
    entry: ord('a', 5),
    from: ord('a', 0),
    index: 0,
  };

  const next = applyEvent(state, event);

  assert.deepEqual(next.children.get('p'), [ord('a', 5), ord('b', 1)]);
});

test('child_remove 的下标错位时抛错，而不是静默删掉别的卡', () => {
  const state = fold([create('p'), create('a', 'p', ord('a', 0)), create('b', 'p', ord('b', 1))]);
  const event: CardEvent = { ...env(), cardId: 'a', type: 'child_remove', parentId: 'p', entry: ord('a', 0), index: 1 };

  assert.throws(() => applyEvent(state, event), /下标错位/);
});

// ── 切片 4：card_move ──────────────────────────────────────────────────────────

test('card_move 跨父移动：旧父摘除、新父按新形状插入', () => {
  const state = fold([
    create('P1'),
    create('P2'),
    create('a', 'P1', plain('a')),
    create('b', 'P1', plain('b')),
    create('x', 'P2', ord('x', 0)),
  ]);
  const event: CardEvent = {
    ...env(),
    cardId: 'b',
    type: 'card_move',
    fromParent: 'P1',
    toParent: 'P2',
    fromIndex: 1,
    removedEntry: plain('b'),
    addedEntry: ord('b', 1),
    index: 1,
  };

  const next = applyEvent(state, event);

  assert.deepEqual(next.children.get('P1'), [plain('a')]);
  assert.deepEqual(next.children.get('P2'), [ord('x', 0), ord('b', 1)]);
});

test('card_move 的 fromIndex 错位时抛错', () => {
  const state = fold([create('P1'), create('P2'), create('a', 'P1', plain('a')), create('b', 'P1', plain('b'))]);
  const event: CardEvent = {
    ...env(),
    cardId: 'a',
    type: 'card_move',
    fromParent: 'P1',
    toParent: 'P2',
    fromIndex: 1,
    removedEntry: plain('a'),
    addedEntry: plain('a'),
    index: 0,
  };

  assert.throws(() => applyEvent(state, event), /下标错位/);
});

test('card_move 保留卡片字段不动', () => {
  const state = fold([create('P1'), create('P2'), create('c1', 'P1', plain('c1'))]);
  const event: CardEvent = {
    ...env(),
    cardId: 'c1',
    type: 'card_move',
    fromParent: 'P1',
    toParent: 'P2',
    fromIndex: 0,
    removedEntry: plain('c1'),
    addedEntry: plain('c1'),
    index: 0,
  };

  const next = applyEvent(state, event);

  assert.equal(next.cards.get('c1')?.title, 'c1');
  assert.equal(next.cards.size, state.cards.size);
});

// ── 切片 5：card_delete（级联 + 子树快照） ─────────────────────────────────────

/** 手工构造一棵 root → mid → leaf 的子树快照（不依赖生产代码的同类实现）。 */
function midSubtreeSnapshot(): SubtreeSnapshot {
  return {
    fields: card('mid'),
    cards: { mid: card('mid'), leaf: card('leaf') },
    // 稀疏：leaf 没有子卡，就不出现这个键（见 state.ts 的规范形态说明）。
    children: { mid: [plain('leaf')] },
  };
}

test('card_delete 级联删掉整棵子树，并从父卡摘除条目', () => {
  const state = fold([
    create('root'),
    create('mid', 'root', plain('mid')),
    create('leaf', 'mid', plain('leaf')),
    create('other'),
  ]);
  const event: CardEvent = {
    ...env(),
    cardId: 'mid',
    type: 'card_delete',
    parentId: 'root',
    removedEntry: plain('mid'),
    removedIndex: 0,
    subtree: midSubtreeSnapshot(),
  };

  const next = applyEvent(state, event);

  // 软删除：子树各卡的**字段都还在**（文件也留在 cards/），只是被标记。
  assert.equal(next.cards.has('mid'), true);
  assert.equal(next.cards.get('mid')?.deleted, true);
  assert.equal(next.cards.has('leaf'), true);
  assert.equal(next.cards.get('leaf')?.deleted, true);
  assert.equal(next.cards.get('root')?.deleted, false);
  assert.equal(next.cards.has('other'), true);
  // root 摘掉 mid 后没有子卡了 —— 规范形态下键被删掉，而不是留一个空数组。
  assert.equal(next.children.has('root'), false);
});

test('card_delete 的快照与实际子树不符时抛错', () => {
  const state = fold([create('root'), create('mid', 'root', plain('mid')), create('leaf', 'mid', plain('leaf'))]);
  const wrong: SubtreeSnapshot = {
    fields: card('mid'),
    cards: { mid: card('mid') }, // ← 漏了 leaf
    children: { mid: [plain('leaf')] },
  };
  const event: CardEvent = {
    ...env(),
    cardId: 'mid',
    type: 'card_delete',
    parentId: 'root',
    removedEntry: plain('mid'),
    removedIndex: 0,
    subtree: wrong,
  };

  assert.throws(() => applyEvent(state, event), /快照与实际子树不一致/);
});

test('card_delete 根卡（parentId 为 null）只删子树，不碰任何 children', () => {
  const state = fold([create('root'), create('child', 'root', plain('child')), create('other')]);
  const event: CardEvent = {
    ...env(),
    cardId: 'root',
    type: 'card_delete',
    parentId: null,
    removedEntry: null,
    removedIndex: null,
    subtree: {
      fields: card('root'),
      cards: { root: card('root'), child: card('child') },
      children: { root: [plain('child')] },
    },
  };

  const next = applyEvent(state, event);

  assert.equal(next.cards.get('root')?.deleted, true);
  assert.equal(next.cards.get('child')?.deleted, true);
  assert.equal(next.cards.get('other')?.deleted, false);
  assert.equal(next.children.has('root'), false);
});
