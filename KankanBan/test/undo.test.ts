import { test } from 'node:test';
import assert from 'node:assert/strict';

import { replay } from '../src/core/replay.ts';
import { applyEvent, emptyState, type CoreState } from '../src/core/state.ts';
import { collectSubtree } from '../src/core/subtree.ts';
import { undoEvent } from '../src/core/undo.ts';
import type { CardEvent, CardFields, OrderedEntry, PlainEntry } from '../src/core/types.ts';

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

const plain = (id: string): PlainEntry => ({ id });
const ord = (id: string, order: number): OrderedEntry => ({ id, order });

/** 整个状态的完整可比表示 —— 只比 id 会漏掉字段和 order 的错。 */
function snap(state: CoreState) {
  const byKey = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {
    lastAppliedSeq: state.lastAppliedSeq,
    cards: [...state.cards.entries()].sort(byKey),
    children: [...state.children.entries()].sort(byKey),
  };
}

/** e1..e8：到"B 被删之前"为止。 */
function beforeDelete(): CardEvent[] {
  return [
    { id: 'e1', seq: 1, clientId: 't', timestamp: 1, cardId: 'P', type: 'card_create', parentId: null, entry: null, fields: card('P', { layout: 'ordered' }) },
    { id: 'e2', seq: 2, clientId: 't', timestamp: 2, cardId: 'A', type: 'card_create', parentId: 'P', entry: ord('A', 0), fields: card('A') },
    { id: 'e3', seq: 3, clientId: 't', timestamp: 3, cardId: 'B', type: 'card_create', parentId: 'P', entry: ord('B', 1), fields: card('B') },
    { id: 'e4', seq: 4, clientId: 't', timestamp: 4, cardId: 'C', type: 'card_create', parentId: 'P', entry: ord('C', 2), fields: card('C') },
    { id: 'e5', seq: 5, clientId: 't', timestamp: 5, cardId: 'A', type: 'field_set', path: '/title', from: 'A', to: '甲' },
    { id: 'e6', seq: 6, clientId: 't', timestamp: 6, cardId: 'C', type: 'child_update', parentId: 'P', entry: ord('C', 0), from: ord('C', 2), index: 2 },
    { id: 'e7', seq: 7, clientId: 't', timestamp: 7, cardId: 'D', type: 'card_create', parentId: 'B', entry: ord('D', 0), fields: card('D') },
    { id: 'e8', seq: 8, clientId: 't', timestamp: 8, cardId: 'C', type: 'card_move', fromParent: 'P', toParent: 'B', fromIndex: 2, removedEntry: ord('C', 0), addedEntry: ord('C', 1), index: 1 },
  ];
}

function script(): CardEvent[] {
  const head = withPrevUpdatedAt(beforeDelete());
  const atE9 = replay(head);

  const deleteB: CardEvent = {
    id: 'e9',
    seq: 9,
    clientId: 't',
    timestamp: 9,
    cardId: 'B',
    type: 'card_delete',
    parentId: 'P',
    removedEntry: ord('B', 1),
    removedIndex: 1,
    // 快照取自"e9 之前"的**真实**状态：手写它会与脚本漂移（`updatedAt` 是派生的，
    // B/D/C 分别是 e3/e7/e8 的时间）。真实路径下也是这么取的（`collectSubtree`）。
    subtree: collectSubtree(atE9, 'B').snapshot,
    prevUpdatedAt: atE9.cards.get('B')?.updatedAt,
  };

  const tail = withPrevUpdatedAt(
    [deleteB, { id: 'e10', seq: 10, clientId: 't', timestamp: 10, cardId: 'P', type: 'child_add', parentId: 'P', entry: plain('E'), index: 1 }],
    atE9,
  );

  return [...head, ...tail];
}

/**
 * 把脚本补成"真实发射器会写出来的样子"。
 *
 * `prevUpdatedAt` 是撤销 `updatedAt` 所需要的**旧值**，与 `from` / `fromIndex` /
 * `removedEntry` 同一类 —— 凡是这条事件改掉的旧状态，都得由它自己带上（§4.3 断言二）。
 * 真实路径由 `envelope()` 填；这里按前缀重放算出来，免得在十条事件里手抄一遍数字。
 */
function withPrevUpdatedAt(events: readonly CardEvent[], from: CoreState = emptyState()): CardEvent[] {
  let state = from;
  return events.map((event) => {
    const filled: CardEvent = { ...event, prevUpdatedAt: state.cards.get(event.cardId)?.updatedAt };
    state = applyEvent(state, filled);
    return filled;
  });
}

/** §4.3 断言二：每撤一条，都必须等于"这一条之前"的重放结果。 */
test('undoEvent 逐条撤销 == 前缀重放', () => {
  const events = script();

  for (let n = events.length; n >= 1; n -= 1) {
    const prefix = events.slice(0, n);
    const last = prefix[prefix.length - 1];
    assert.ok(last !== undefined);

    const undone = undoEvent(replay(prefix), last);
    const expected = replay(prefix.slice(0, -1));

    assert.deepEqual(snap(undone), snap(expected), `撤销 e${n} (${last.type}) 后应与前 ${n - 1} 条的重放一致`);
  }
});

test('撤销全部事件后回到空状态', () => {
  const events = script();

  let state = replay(events);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    assert.ok(event !== undefined);
    state = undoEvent(state, event);
  }

  assert.deepEqual(snap(state), snap(replay([])));
});

test('撤销 field_set 会把字段写回 from', () => {
  const events = script();
  const e5 = events[4];
  assert.ok(e5 !== undefined);

  const undone = undoEvent(replay(events.slice(0, 5)), e5);

  assert.equal(undone.cards.get('A')?.title, 'A');
});

test('撤销 card_delete 会把整棵子树连同原位放回来', () => {
  const events = script();
  const e9 = events[8];
  assert.ok(e9 !== undefined);

  const undone = undoEvent(replay(events.slice(0, 9)), e9);

  assert.equal(undone.cards.has('B'), true);
  assert.equal(undone.cards.has('C'), true);
  assert.equal(undone.cards.has('D'), true);
  // C 在 e8 已经移进 B，所以 P 只剩 A 和 B；B 必须插回原来的下标 1。
  assert.deepEqual(undone.children.get('P'), [ord('A', 0), ord('B', 1)]);
  assert.deepEqual(undone.children.get('B'), [ord('D', 0), ord('C', 1)]);
});

test('撤销 card_move 会把条目按旧形状放回旧父卡', () => {
  const events = script();
  const e8 = events[7];
  assert.ok(e8 !== undefined);

  const undone = undoEvent(replay(events.slice(0, 8)), e8);

  assert.deepEqual(undone.children.get('P'), [ord('A', 0), ord('B', 1), ord('C', 0)]);
  assert.deepEqual(undone.children.get('B'), [ord('D', 0)]);
});
