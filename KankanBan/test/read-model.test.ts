/**
 * §9.2 读模型的签名对齐。
 *
 * 文档给的形状是：
 * ```
 * read_tree(scope?, maxDepth?, cursor?)      → { nodes, nextCursor? }
 * read_card(id, includeChildren?)            → CardSnapshot
 * list_children(parentId, cursor?, limit?)   → { entries, nextCursor? }
 * search(query, limit?, cursor?)             → { items, nextCursor? }
 * ```
 * 实现时漏掉了 `scope`、`includeChildren`，`search` 也**没有分页** ——
 * 而 §9.2 明说"**强制分页**是重点：AI 读整棵大树会直接爆上下文"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { BUILTIN_CARDS } from '../src/core/builtins.ts';
import { createCard, deleteCard, listChildren, openSession, readCard, readTree, search, subtreeSize } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

function makeSession(): Session {
  let counter = 0;
  return openSession('/r', {
      builtins: false,
    clientId: 'r',
    ops: createMemoryFs().ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
  });
}

function withBuiltins(session: Session): void {
  for (const card of BUILTIN_CARDS) {
    createCard(session, { id: card.id, parentId: null, title: card.name, layout: card.layout });
  }
}

// ── read_tree 的 scope 过滤 ───────────────────────────────────────────────────

test('read_tree 的 scope=public 只给公有区域那两棵树的根', () => {
  const session = makeSession();
  withBuiltins(session);
  const mine = createCard(session, { parentId: null, title: '我的私有卡' });

  const publicTree = readTree(session, { scope: 'public' });
  const privateTree = readTree(session, { scope: 'private' });

  assert.deepEqual(publicTree.nodes.map((n) => n.id).sort(), ['001', '002']);
  assert.equal(privateTree.nodes.map((n) => n.id).includes(mine), true);
  assert.equal(privateTree.nodes.map((n) => n.id).includes('001'), false);
});

test('scope 过滤是按根卡做的 —— 因为 scope 由深度 0 祖先决定', () => {
  const session = makeSession();
  withBuiltins(session);
  const column = createCard(session, { parentId: '001', title: '列', layout: 'ordered' });
  const task = createCard(session, { parentId: column, title: '任务' });

  const publicTree = readTree(session, { scope: 'public', maxDepth: 5 });
  const root = publicTree.nodes.find((n) => n.id === '001');
  const [firstColumn] = root?.children ?? [];

  assert.equal(firstColumn?.id, column);
  assert.deepEqual(firstColumn?.children.map((n) => n.id), [task], '孙卡应当跟着公有根一起出现');
});

test('不传 scope 时给全部根卡（旧行为不变）', () => {
  const session = makeSession();
  withBuiltins(session);
  createCard(session, { parentId: null, title: '我的' });

  assert.equal(readTree(session).nodes.length, 5);
});

// ── 分页 ───────────────────────────────────────────────────────────────────────

test('read_tree 分页：limit 小的时候给 nextCursor，下一页接着读', () => {
  const session = makeSession();
  withBuiltins(session);
  createCard(session, { parentId: null, title: '我的' });

  const first = readTree(session, { limit: 2 });
  assert.equal(first.nodes.length, 2);
  assert.equal(typeof first.nextCursor, 'string');

  const second = readTree(session, { limit: 2, cursor: first.nextCursor });
  assert.equal(second.nodes.length, 2);

  const third = readTree(session, { limit: 2, cursor: second.nextCursor });
  assert.equal(third.nodes.length, 1);
  assert.equal(third.nextCursor, undefined, '最后一页不该再给游标');

  const all = [...first.nodes, ...second.nodes, ...third.nodes].map((n) => n.id);
  assert.deepEqual(all, [...all].sort(), '分页拼起来应当不重不漏');
});

test('search 分页，且结果顺序稳定（否则分页会在两次调用之间漂移）', () => {
  const session = makeSession();
  for (const title of ['牛奶 A', '牛奶 B', '牛奶 C']) {
    createCard(session, { parentId: null, title });
  }

  const first = search(session, '牛奶', { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(typeof first.nextCursor, 'string');

  const second = search(session, '牛奶', { limit: 2, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, undefined);

  const ids = [...first.items, ...second.items].map((item) => item.id);
  assert.deepEqual(ids, [...ids].sort(), '结果应当按 id 稳定排序');
  assert.equal(new Set(ids).size, 3, '分页不重不漏');
});

test('非法 cursor 一律抛错，而不是当成 0 静默从头读', () => {
  const session = makeSession();
  createCard(session, { parentId: null, title: '卡' });

  assert.throws(() => readTree(session, { cursor: 'abc' }), /cursor 非法/);
  assert.throws(() => search(session, '卡', { cursor: '-1' }), /cursor 非法/);
  assert.throws(() => listChildren(session, 'c1', { cursor: 'x' }), /cursor 非法/);
});

// ── read_card 的 includeChildren ───────────────────────────────────────────────

// ── subtreeSize：删除前的无副作用预览（§2.7） ─────────────────────────────────

test('subtreeSize 数整棵子树，而且**不删**任何东西', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: 'R' });
  const mid = createCard(session, { parentId: root, title: 'M' });
  createCard(session, { parentId: mid, title: 'L1' });
  createCard(session, { parentId: mid, title: 'L2' });
  const eventsBefore = session.events.length;

  assert.equal(subtreeSize(session, root), 4, 'R + M + 两个叶子');
  assert.equal(subtreeSize(session, mid), 3);

  // 关键：预览不能有副作用
  assert.equal(session.events.length, eventsBefore, '预览不该写事件');
  assert.equal(session.state.cards.get(mid)?.deleted, false);
});

test('subtreeSize 对叶子卡是 1', () => {
  const session = makeSession();
  const leaf = createCard(session, { parentId: null, title: '叶子' });

  assert.equal(subtreeSize(session, leaf), 1);
});

test('subtreeSize 与 deleteCard 的返回值一致（预览不能骗人）', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: 'R' });
  const mid = createCard(session, { parentId: root, title: 'M' });
  createCard(session, { parentId: mid, title: 'L' });

  const preview = subtreeSize(session, root);
  const actual = deleteCard(session, root);

  assert.equal(preview, actual, '预览与实际删除数必须一致，否则确认框就是在骗用户');
});

test('read_card 默认不带子卡；includeChildren 为真时带上条目', () => {
  const session = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
  const child = createCard(session, { parentId: parent, title: 'C' });

  assert.equal(readCard(session, parent).children, undefined);

  const withChildren = readCard(session, parent, { includeChildren: true });
  assert.deepEqual(withChildren.children, [{ id: child, order: 0 }]);
  assert.equal(withChildren.title, 'P', '其它字段照常');
});

test('list_children 的 cursor 也走同一套校验', () => {
  const session = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
  for (const title of ['A', 'B', 'C']) createCard(session, { parentId: parent, title });

  const first = listChildren(session, parent, { limit: 2 });
  const second = listChildren(session, parent, { limit: 2, cursor: first.nextCursor });

  assert.equal(first.entries.length, 2);
  assert.equal(second.entries.length, 1);
  assert.equal(second.nextCursor, undefined);
});
