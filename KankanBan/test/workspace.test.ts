import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import '../src/node/bootstrap.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openWorkspace, readEvents } from '../src/core/storage/workspace-io.ts';
import {
  createCard,
  deleteCard,
  entryFor,
  listChildren,
  moveCard,
  openSession,
  readCard,
  readTree,
  search,
  setField,
  undoLast,
} from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import type { ChildEntry, Layout, OrderedEntry, PlaneEntry, PlainEntry } from '../src/core/types.ts';

function withSession(body: (session: Session) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'kkb-ws-'));
  try {
    body(openSession(root, { builtins: false, clientId: 't' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 条目形状由父卡 layout 决定（§2.4.1） ──────────────────────────────────────

test('entryFor：顺序型 layout 一律给 OrderedEntry', () => {
  for (const layout of ['tabs', 'columns', 'ordered', 'grid'] satisfies Layout[]) {
    assert.deepEqual(entryFor(layout, 'a', 3), { id: 'a', order: 3 } satisfies OrderedEntry);
  }
});

test('entryFor：plain 给 PlainEntry，plane 给 PlaneEntry', () => {
  assert.deepEqual(entryFor('plain', 'a', 0), { id: 'a' } satisfies PlainEntry);

  const plane = entryFor('plane', 'a', 0, { x: 10, y: 20, w: 200, h: 120, z: 5 });
  assert.deepEqual(plane, { id: 'a', x: 10, y: 20, w: 200, h: 120, z: 5 } satisfies PlaneEntry);
});

test('entryFor：plane 缺坐标时抛错，而不是编一个默认位置', () => {
  assert.throws(() => entryFor('plane', 'a', 0), /plane|坐标/);
});

// ── 建卡 ───────────────────────────────────────────────────────────────────────

test('createCard 建根卡：进 state 但不进任何 children', () => {
  withSession((s) => {
    const id = createCard(s, { parentId: null, title: '根卡' });

    assert.equal(readCard(s, id).title, '根卡');
    assert.equal(s.state.children.size, 0);
  });
});

test('createCard 挂到顺序型父卡下：条目 order 递增', () => {
  withSession((s) => {
    const parent = createCard(s, { parentId: null, title: 'P', layout: 'ordered' });
    const a = createCard(s, { parentId: parent, title: 'A' });
    const b = createCard(s, { parentId: parent, title: 'B' });

    assert.deepEqual(listChildren(s, parent).entries, [
      { id: a, order: 0 },
      { id: b, order: 1 },
    ] satisfies OrderedEntry[]);
  });
});

test('createCard 挂到 plain 父卡下：条目是 PlainEntry', () => {
  withSession((s) => {
    const parent = createCard(s, { parentId: null, title: 'P' });
    const a = createCard(s, { parentId: parent, title: 'A' });

    assert.deepEqual(listChildren(s, parent).entries, [{ id: a }] satisfies PlainEntry[]);
  });
});

test('createCard 挂到不存在的父卡下时抛错', () => {
  withSession((s) => {
    assert.throws(() => createCard(s, { parentId: 'nope', title: 'A' }), /不存在/);
  });
});

// ── 改字段 ─────────────────────────────────────────────────────────────────────

test('setField 改标题：事件带着旧值，便于撤销', () => {
  withSession((s) => {
    const id = createCard(s, { parentId: null, title: '旧' });
    setField(s, id, '/title', '新');

    assert.equal(readCard(s, id).title, '新');
    assert.equal(s.events.at(-1)?.type, 'field_set');
    assert.equal((s.events.at(-1) as { from: unknown }).from, '旧');
  });
});

test('setField 值没变时不产生事件（避免日志噪音）', () => {
  withSession((s) => {
    const id = createCard(s, { parentId: null, title: '同' });
    const before = s.events.length;

    setField(s, id, '/title', '同');

    assert.equal(s.events.length, before);
  });
});

// ── 移卡 ───────────────────────────────────────────────────────────────────────

test('moveCard 跨父：removedEntry 是旧形状、addedEntry 是新形状', () => {
  withSession((s) => {
    const plainParent = createCard(s, { parentId: null, title: 'PP' });
    const orderedParent = createCard(s, { parentId: null, title: 'OP', layout: 'ordered' });
    const card = createCard(s, { parentId: plainParent, title: 'C' });

    moveCard(s, card, orderedParent, 0);

    const event = s.events.at(-1);
    assert.equal(event?.type, 'card_move');
    assert.deepEqual((event as { removedEntry: ChildEntry }).removedEntry, { id: card } satisfies PlainEntry);
    assert.deepEqual((event as { addedEntry: ChildEntry }).addedEntry, { id: card, order: 0 } satisfies OrderedEntry);
    assert.equal((event as { fromIndex: number }).fromIndex, 0);
    assert.equal((event as { index: number }).index, 0);
    assert.deepEqual(listChildren(s, plainParent).entries, []);
    assert.deepEqual(listChildren(s, orderedParent).entries, [{ id: card, order: 0 }] satisfies OrderedEntry[]);
  });
});

test('moveCard 把卡移进自己的子树时抛错（不许成环）', () => {
  withSession((s) => {
    const outer = createCard(s, { parentId: null, title: 'O' });
    const inner = createCard(s, { parentId: outer, title: 'I' });

    assert.throws(() => moveCard(s, outer, inner, 0), /环|子树/);
  });
});

test('moveCard 移到自己身上时抛错', () => {
  withSession((s) => {
    const parent = createCard(s, { parentId: null, title: 'P' });
    const card = createCard(s, { parentId: parent, title: 'C' });

    assert.throws(() => moveCard(s, card, card, 0), /环|自己|子树/);
  });
});

// ── §2.5.1：不允许任务卡直接落在 board 层级上 ─────────────────────────────────

test('不允许把卡直接移到看板层级（那会让它变成一列）', () => {
  withSession((s) => {
    const board = createCard(s, { id: '001', parentId: null, title: '看板', layout: 'columns' });
    const column = createCard(s, { parentId: board, title: '待办', layout: 'ordered' });
    const task = createCard(s, { parentId: column, title: '任务' });

    assert.throws(() => moveCard(s, task, board, 0), /看板层级|变成一列/, '任务卡不该能落到 board 那一层');

    // 结构没被破坏
    assert.deepEqual(
      (s.state.children.get(board) ?? []).map((e) => e.id),
      [column],
    );
  });
});

test('看板下已有的列卡之间重排序是允许的（只拦"从外面移进来"）', () => {
  withSession((s) => {
    const board = createCard(s, { id: '001', parentId: null, title: '看板', layout: 'columns' });
    const a = createCard(s, { parentId: board, title: 'A', layout: 'ordered' });
    const b = createCard(s, { parentId: board, title: 'B', layout: 'ordered' });

    assert.doesNotThrow(() => moveCard(s, a, board, 1));

    assert.deepEqual(
      (s.state.children.get(board) ?? []).map((e) => e.id),
      [b, a],
    );
  });
});

test('建一张卡到看板下是允许的 —— 那正是"新建一列"', () => {
  withSession((s) => {
    const board = createCard(s, { id: '001', parentId: null, title: '看板', layout: 'columns' });

    const column = createCard(s, { parentId: board, title: '新列', layout: 'ordered' });

    assert.deepEqual(
      (s.state.children.get(board) ?? []).map((e) => e.id),
      [column],
    );
  });
});

test('用 type 指向 columns 呈现定义卡的看板也受这条防线管', () => {
  withSession((s) => {
    const template = createCard(s, { parentId: null, title: '看板模板', layout: 'columns' });
    const board = createCard(s, { parentId: null, title: '我的看板', type: template });
    const column = createCard(s, { parentId: board, title: '列', layout: 'ordered' });
    const task = createCard(s, { parentId: column, title: '任务' });

    assert.throws(() => moveCard(s, task, board, 0), /看板层级/);
  });
});

test('移到普通卡（非看板）下面不受这条限制', () => {
  withSession((s) => {
    const plain = createCard(s, { parentId: null, title: '普通容器' });
    const loose = createCard(s, { parentId: null, title: '散卡' });

    assert.doesNotThrow(() => moveCard(s, loose, plain, 0));
  });
});

// ── 删卡 ───────────────────────────────────────────────────────────────────────

test('deleteCard 的事件携带与实际子树一致的快照', () => {
  withSession((s) => {
    const root = createCard(s, { parentId: null, title: 'R' });
    const leaf = createCard(s, { parentId: root, title: 'L' });

    deleteCard(s, root);

    const event = s.events.at(-1);
    assert.equal(event?.type, 'card_delete');
    const subtree = (event as { subtree: { cards: Record<string, unknown>; children: Record<string, unknown> } })
      .subtree;
    assert.deepEqual(Object.keys(subtree.cards).sort(), [leaf, root].sort());
    assert.deepEqual(Object.keys(subtree.children), [root]);
    assert.equal(readCard(s, root).deleted, true);
    assert.equal(readCard(s, leaf).deleted, true);
  });
});

test('deleteCard 之后卡不再出现在读树结果里', () => {
  withSession((s) => {
    const keep = createCard(s, { parentId: null, title: 'K' });
    const gone = createCard(s, { parentId: null, title: 'G' });

    deleteCard(s, gone);

    assert.deepEqual(
      readTree(s).nodes.map((n) => n.id),
      [keep],
    );
  });
});

// ── 撤销与持久化 ───────────────────────────────────────────────────────────────

test('undoLast 撤销最后一次操作', () => {
  withSession((s) => {
    const id = createCard(s, { parentId: null, title: '旧' });
    setField(s, id, '/title', '新');

    assert.equal(undoLast(s), true);

    assert.equal(readCard(s, id).title, '旧');
  });
});

test('undoLast 在日志为空时返回 false，不抛错', () => {
  withSession((s) => {
    assert.equal(undoLast(s), false);
  });
});

test('每次操作都立刻落盘：重开工作区能看到全部改动', () => {
  const root = mkdtempSync(join(tmpdir(), 'kkb-ws-'));
  try {
    const session = openSession(root, { builtins: false, clientId: 't' });
    const parent = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
    const a = createCard(session, { parentId: parent, title: 'A' });
    setField(session, a, '/content', '# 正文');

    const { state, events } = openWorkspace(root);

    assert.equal(events.length, 3);
    assert.equal(state.cards.get(a)?.content, '# 正文');
    assert.deepEqual(state.children.get(parent), [{ id: a, order: 0 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('重开工作区后能接着写，日志是追加的', () => {
  const root = mkdtempSync(join(tmpdir(), 'kkb-ws-'));
  try {
    const first = openSession(root, { builtins: false, clientId: 't' });
    const a = createCard(first, { parentId: null, title: 'A' });

    const second = openSession(root, { builtins: false, clientId: 't' });
    setField(second, a, '/title', 'A2');

    const { events } = readEvents(root);
    assert.equal(events.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 读模型（§9.2） ─────────────────────────────────────────────────────────────

test('readTree 默认只展到浅深度，到顶的节点被标记 truncated', () => {
  withSession((s) => {
    // 四层 A → B → C → D。maxDepth=2 表示"根算第 0 层，往下再展 2 层"，
    // 所以应当看到 A、B、C，而 C 因为还有 D 被标记为截断。
    const a = createCard(s, { parentId: null, title: 'A', layout: 'ordered' });
    const b = createCard(s, { parentId: a, title: 'B', layout: 'ordered' });
    const c = createCard(s, { parentId: b, title: 'C', layout: 'ordered' });
    const d = createCard(s, { parentId: c, title: 'D' });

    const shallow = readTree(s, { maxDepth: 2 });

    assert.deepEqual(shallow.nodes.map((n) => n.id), [a]);
    assert.equal(shallow.nodes[0]?.truncated, false, 'A 的子层已经展出来了');
    assert.deepEqual(shallow.nodes[0]?.children.map((n) => n.id), [b]);
    assert.equal(shallow.nodes[0]?.children[0]?.truncated, false, 'B 的子层已经展出来了');
    assert.deepEqual(shallow.nodes[0]?.children[0]?.children.map((n) => n.id), [c]);
    assert.equal(shallow.nodes[0]?.children[0]?.children[0]?.truncated, true, 'C 还有 D，但到深度上限了');
    assert.deepEqual(shallow.nodes[0]?.children[0]?.children[0]?.children, []);

    const deep = readTree(s, { maxDepth: 10 });
    assert.deepEqual(deep.nodes[0]?.children[0]?.children[0]?.children.map((n) => n.id), [d]);
    assert.equal(deep.nodes[0]?.children[0]?.children[0]?.truncated, false);
  });
});

test('readTree 的 maxDepth 为 0 时只给根卡', () => {
  withSession((s) => {
    const a = createCard(s, { parentId: null, title: 'A' });
    createCard(s, { parentId: a, title: 'B' });

    const nodes = readTree(s, { maxDepth: 0 }).nodes;
    assert.deepEqual(nodes.map((n) => n.id), [a]);
    assert.equal(nodes[0]?.truncated, true);
  });
});

test('listChildren 支持 limit 与 cursor 分页', () => {
  withSession((s) => {
    const parent = createCard(s, { parentId: null, title: 'P', layout: 'ordered' });
    const ids = ['A', 'B', 'C'].map((t) => createCard(s, { parentId: parent, title: t }));

    const firstPage = listChildren(s, parent, { limit: 2 });
    assert.deepEqual(firstPage.entries.map((e) => e.id), ids.slice(0, 2));
    assert.equal(typeof firstPage.nextCursor, 'string');

    const secondPage = listChildren(s, parent, { limit: 2, cursor: firstPage.nextCursor });
    assert.deepEqual(secondPage.entries.map((e) => e.id), ids.slice(2));
    assert.equal(secondPage.nextCursor, undefined);
  });
});

test('search 命中标题与正文，且不返回已删除的卡', () => {
  withSession((s) => {
    const hit = createCard(s, { parentId: null, title: '买牛奶' });
    const body = createCard(s, { parentId: null, title: '其它', content: '记得买牛奶' });
    const gone = createCard(s, { parentId: null, title: '买牛奶（已删）' });
    deleteCard(s, gone);

    assert.deepEqual(
      search(s, '买牛奶').items.map((c) => c.id).sort(),
      [hit, body].sort(),
    );
  });
});
