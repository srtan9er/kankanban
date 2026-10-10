import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyEvent, emptyState } from '../src/core/state.ts';
import { replay } from '../src/core/replay.ts';
import type { CardEvent, CardFields, PlainEntry, OrderedEntry, SubtreeSnapshot } from '../src/core/types.ts';

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

/**
 * 一段真实感较强的事件序列：建 4 张卡 → 改字段 → 重排序 → 跨父移动 → 删除子树。
 * 全部手写，不经过操作层 —— 这样 replay 的正确性不依赖操作层的正确性。
 */
function script(): CardEvent[] {
  // 注意：快照必须反映 e8 之后 B 的真实子树 —— C 在 e8 已经移进 B 了。
  const subtree: SubtreeSnapshot = {
    fields: card('B'),
    cards: { B: card('B'), D: card('D'), C: card('C') },
    children: { B: [ord('D', 0), ord('C', 1)] },
  };
  return [
    { id: 'e1', seq: 1, clientId: 't', timestamp: 1, cardId: 'P', type: 'card_create', parentId: null, entry: null, fields: card('P', { layout: 'ordered' }) },
    { id: 'e2', seq: 2, clientId: 't', timestamp: 2, cardId: 'A', type: 'card_create', parentId: 'P', entry: ord('A', 0), fields: card('A') },
    { id: 'e3', seq: 3, clientId: 't', timestamp: 3, cardId: 'B', type: 'card_create', parentId: 'P', entry: ord('B', 1), fields: card('B') },
    { id: 'e4', seq: 4, clientId: 't', timestamp: 4, cardId: 'C', type: 'card_create', parentId: 'P', entry: ord('C', 2), fields: card('C') },
    { id: 'e5', seq: 5, clientId: 't', timestamp: 5, cardId: 'A', type: 'field_set', path: '/title', from: 'A', to: '甲' },
    { id: 'e6', seq: 6, clientId: 't', timestamp: 6, cardId: 'C', type: 'child_update', parentId: 'P', entry: ord('C', 0), from: ord('C', 2), index: 2 },
    { id: 'e7', seq: 7, clientId: 't', timestamp: 7, cardId: 'D', type: 'card_create', parentId: 'B', entry: ord('D', 0), fields: card('D') },
    { id: 'e8', seq: 8, clientId: 't', timestamp: 8, cardId: 'C', type: 'card_move', fromParent: 'P', toParent: 'B', fromIndex: 2, removedEntry: ord('C', 0), addedEntry: ord('C', 1), index: 1 },
    { id: 'e9', seq: 9, clientId: 't', timestamp: 9, cardId: 'B', type: 'card_delete', parentId: 'P', removedEntry: ord('B', 1), removedIndex: 1, subtree },
    { id: 'e10', seq: 10, clientId: 't', timestamp: 10, cardId: 'P', type: 'child_add', parentId: 'P', entry: plain('E'), index: 1 },
  ];
}

function fold(events: readonly CardEvent[]) {
  return events.reduce(applyEvent, emptyState());
}

test('replay(events) 等于把同样的事件逐个 apply 到空状态', () => {
  const events = script();

  const replayed = replay(events);
  const folded = fold(events);

  assert.equal(replayed.cards.size, folded.cards.size);
  assert.deepEqual([...replayed.cards.keys()].sort(), [...folded.cards.keys()].sort());
  assert.equal(replayed.lastAppliedSeq, 10);
});

test('replay 结果的树结构符合脚本预期', () => {
  const state = replay(script());

  assert.equal(state.cards.get('B')?.deleted, true, 'B 被软删除');
  assert.equal(state.cards.get('C')?.deleted, true, 'C 是 B 的子卡，一并软删');
  assert.equal(state.cards.get('D')?.deleted, true, 'D 是 B 的子卡，一并软删');
  assert.equal(state.cards.get('A')?.deleted, false);
  assert.deepEqual(state.children.get('P'), [ord('A', 0), plain('E')]);
  assert.equal(state.children.has('B'), false);
});

test('replay 对同一序列是幂等且无副作用的', () => {
  const events = script();

  const a = replay(events);
  const b = replay(events);

  assert.notEqual(a, b, '每次重放返回新对象');
  assert.deepEqual([...a.cards.keys()].sort(), [...b.cards.keys()].sort());
  assert.equal(events.length, 10, 'replay 不得改动事件数组');
});
