import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyEvent, emptyState } from '../src/core/state.ts';
import type { CoreState } from '../src/core/state.ts';
import { replay } from '../src/core/replay.ts';
import { collectSubtree } from '../src/core/subtree.ts';
import { undoEvent } from '../src/core/undo.ts';
import type { CardEvent, CardFields, ChildEntry, PlainEntry, SubtreeSnapshot } from '../src/core/types.ts';

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

function env(seq: number, cardId: string) {
  return { id: `e${seq}`, seq, clientId: 'test', timestamp: seq * 1000, cardId };
}

/** root → mid → leaf，另有 other。 */
function tree(): CardEvent[] {
  return [
    { ...env(1, 'root'), type: 'card_create', parentId: null, entry: null, fields: card('root') },
    { ...env(2, 'mid'), type: 'card_create', parentId: 'root', entry: plain('mid'), fields: card('mid') },
    { ...env(3, 'leaf'), type: 'card_create', parentId: 'mid', entry: plain('leaf'), fields: card('leaf') },
    { ...env(4, 'other'), type: 'card_create', parentId: null, entry: null, fields: card('other') },
  ];
}

/**
 * 删除那一刻的**真实**快照。
 *
 * **不能手写**：它必须与"`tree()` 重放之后"的状态逐字段一致，而 `updatedAt` 现在是派生的
 * （mid 是 e2 的时间、leaf 是 e3 的时间）。手抄这些数字一旦与脚本漂移，
 * `card_delete` 的撤销就会把过期的时间写回去 —— 而"撤销 == 前缀重放"正是要验的东西。
 * 所以直接向 core 要：真实路径下的快照也是这么来的（`collectSubtree`）。
 */
function snapshotOfMid(): SubtreeSnapshot {
  return collectSubtree(replay(tree()), 'mid').snapshot;
}

function deleteMid(index = 0): CardEvent {
  return {
    ...env(5, 'mid'),
    type: 'card_delete',
    parentId: 'root',
    removedEntry: plain('mid'),
    removedIndex: index,
    subtree: snapshotOfMid(),
    // 撤销要把 `updatedAt` 放回**删除前**的值。它是派生的（= 指向这张卡的最后一条事件的时间），
    // 在这份夹具里就是 mid 的建卡事件 e2。与 `removedEntry` / `removedIndex` 同一类：
    // 凡是这条事件改掉的旧状态，都得由它自己带上（§4.3 断言二）。
    prevUpdatedAt: env(2, 'mid').timestamp,
  };
}

function fold(events: readonly CardEvent[]): CoreState {
  return events.reduce(applyEvent, emptyState());
}

test('card_delete 把整棵子树标记为 deleted，而不是从 cards 里抹掉', () => {
  const next = applyEvent(fold(tree()), deleteMid());

  assert.equal(next.cards.has('mid'), true, '文件还在 cards/ 里，只是被标记');
  assert.equal(next.cards.get('mid')?.deleted, true);
  assert.equal(next.cards.get('leaf')?.deleted, true);
  assert.equal(next.cards.get('root')?.deleted, false);
  assert.equal(next.cards.get('other')?.deleted, false);
});

test('已删除的子树不再被任何 children 引用（否则会变成幽灵根卡）', () => {
  const next = applyEvent(fold(tree()), deleteMid());

  const referenced = new Set<string>();
  for (const list of next.children.values()) {
    for (const entry of list) referenced.add(entry.id);
  }

  assert.equal(referenced.has('mid'), false);
  assert.equal(referenced.has('leaf'), false);
  assert.equal(next.children.has('mid'), false);
});

test('撤销 card_delete 会把 deleted 还原成 false', () => {
  const events = [...tree(), deleteMid()];

  const undone = undoEvent(replay(events), deleteMid());

  assert.equal(undone.cards.get('mid')?.deleted, false);
  assert.equal(undone.cards.get('leaf')?.deleted, false);
  assert.deepEqual(undone.children.get('root'), [plain('mid')]);
});

test('撤销 card_delete 后 deleted 字段与原状态逐字段一致', () => {
  const before = replay(tree());
  const undo = undoEvent(replay([...tree(), deleteMid()]), deleteMid());

  assert.deepEqual(undo.cards.get('mid'), before.cards.get('mid'));
  assert.deepEqual(undo.cards.get('leaf'), before.cards.get('leaf'));
});

test('field_set 不允许直接改 /deleted', () => {
  const state = fold(tree());
  const event = {
    ...env(9, 'mid'),
    type: 'field_set',
    path: '/deleted',
    from: false,
    to: true,
  } as CardEvent;

  assert.throws(() => applyEvent(state, event), /\/deleted/);
});

test('空状态的 lastAppliedSeq 与卡片数不受 deleted 字段影响', () => {
  const state = replay(tree());
  assert.equal(state.lastAppliedSeq, 4);
  assert.equal([...state.cards.values()].filter((c) => c.deleted).length, 0);
});
