/**
 * `layout` 改动与**子卡条目形状**的一致性。
 *
 * §2.4 定死了两件事：
 *   1. 条目形状由**父卡的 `layout`** 决定，条目自己不带判别字段
 *   2. **加载时必须依据父卡的 `layout` 校验条目，形状不匹配视为数据损坏**
 *
 * 而 §2.3 又把 `layout` 列成一个普通落盘字段 —— 于是 `setField('/layout')` 看起来完全合法。
 * 两者一撞就会出事：改了 `layout`、子卡条目还是旧形状 → **下次打开工作区直接报数据损坏**。
 * 这个文件先把这个情形钉出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { setField, createCard, openSession, setLayout } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { openWorkspace } from '../src/core/storage/workspace-io.ts';
import { replay } from '../src/core/replay.ts';
import { undoEvent } from '../src/core/undo.ts';
import type { Layout, OrderedEntry, PlainEntry, PlaneEntry } from '../src/core/types.ts';
import { callTool } from '../src/mcp/tools.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

const ROOT = '/l';

function makeSession(): { session: Session; memory: ReturnType<typeof createMemoryFs> } {
  const memory = createMemoryFs();
  let counter = 0;
  const session = openSession(ROOT, {
    clientId: 'l',
    ops: memory.ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
    builtins: false,
  });
  return { session, memory };
}

function idOf(result: unknown): string {
  const id = (result as { id?: unknown }).id;
  assert.equal(typeof id, 'string', `期望返回带 id 的对象，实际是 ${JSON.stringify(result)}`);
  return id as string;
}

function snap(state: ReturnType<typeof replay>): string {
  const byKey = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return JSON.stringify({
    seq: state.lastAppliedSeq,
    cards: [...state.cards.entries()].sort(byKey),
    children: [...state.children.entries()].sort(byKey),
  });
}

// ── 先钉住旧毛病：裸改 layout 会把工作区写坏 ───────────────────────────────────

test('setField 不允许直接改 /layout（改它必须连带重写子卡条目）', () => {
  const { session } = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P' });
  createCard(session, { parentId: parent, title: 'C' });

  assert.throws(
    () => setField(session, parent, '/layout', 'ordered'),
    /layout|setLayout/,
    '裸改 layout 会让 children 里的条目形状对不上，下次加载就是数据损坏',
  );
});

// ── setLayout：合法入口 ────────────────────────────────────────────────────────

test('plain → ordered：子卡条目被重写成顺序型，工作区仍能加载', () => {
  const { session, memory } = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P' });
  const a = createCard(session, { parentId: parent, title: 'A' });
  const b = createCard(session, { parentId: parent, title: 'B' });

  setLayout(session, parent, 'ordered');

  assert.equal(session.state.cards.get(parent)?.layout, 'ordered');
  assert.deepEqual(session.state.children.get(parent), [
    { id: a, order: 0 },
    { id: b, order: 1 },
  ] satisfies OrderedEntry[]);

  // 关键：能重新加载
  const reopened = openWorkspace(ROOT, memory.ops);
  assert.equal(reopened.state.cards.get(parent)?.layout, 'ordered');
});

test('ordered → plain：条目退回无布局型', () => {
  const { session, memory } = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
  const a = createCard(session, { parentId: parent, title: 'A' });

  setLayout(session, parent, 'plain');

  assert.deepEqual(session.state.children.get(parent), [{ id: a }] satisfies PlainEntry[]);
  assert.doesNotThrow(() => openWorkspace(ROOT, memory.ops));
});

test('改 layout 是**一条**事件 —— 撤销仍然只需一步', () => {
  const { session } = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P' });
  createCard(session, { parentId: parent, title: 'A' });
  createCard(session, { parentId: parent, title: 'B' });
  const eventsBefore = session.events.length;
  const before = snap(session.state);

  setLayout(session, parent, 'ordered');

  assert.equal(session.events.length, eventsBefore + 1, '一次操作只该产生一条事件');

  const last = session.events.at(-1);
  assert.ok(last !== undefined);
  assert.deepEqual(snap(undoEvent(session.state, last)), before, '撤销一步就该回到原样');
});

test('改 layout 之后 replay 出来的状态与实时状态一致', () => {
  const { session } = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P' });
  createCard(session, { parentId: parent, title: 'A' });
  setLayout(session, parent, 'grid');

  assert.equal(snap(replay(session.events)), snap(session.state));
});

test('所有"顺序型" layout 之间互转都保持条目形状正确', () => {
  const orderedLayouts: Layout[] = ['tabs', 'columns', 'ordered', 'grid'];

  for (const from of orderedLayouts) {
    for (const to of orderedLayouts) {
      const { session, memory } = makeSession();
      const parent = createCard(session, { parentId: null, title: 'P', layout: from });
      createCard(session, { parentId: parent, title: 'A' });

      setLayout(session, parent, to);

      assert.doesNotThrow(() => openWorkspace(ROOT, memory.ops), `${from} → ${to} 之后应当能加载`);
      const entries = session.state.children.get(parent) ?? [];
      assert.deepEqual(entries, [{ id: entries[0]?.id, order: 0 }], `${from} → ${to} 的条目应当是顺序型`);
    }
  }
});

// ── 不能凭空造数据的转换 ───────────────────────────────────────────────────────

test('改成 plane 需要坐标：不给就明确拒绝，而不是编一个默认位置', () => {
  const { session } = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P' });
  createCard(session, { parentId: parent, title: 'A' });

  assert.throws(() => setLayout(session, parent, 'plane'), /坐标|plane/);
  assert.equal(session.state.cards.get(parent)?.layout, 'plain', '拒绝之后不能留下半改状态');
});

test('改成 plane 时逐个给坐标就行', () => {
  const { session, memory } = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P' });
  const a = createCard(session, { parentId: parent, title: 'A' });
  const b = createCard(session, { parentId: parent, title: 'B' });

  setLayout(session, parent, 'plane', {
    placements: [
      { x: 10, y: 20, w: 100, h: 60, z: 1 },
      { x: 200, y: 30, w: 120, h: 80, z: 2 },
    ],
  });

  assert.deepEqual(session.state.children.get(parent), [
    { id: a, x: 10, y: 20, w: 100, h: 60, z: 1 },
    { id: b, x: 200, y: 30, w: 120, h: 80, z: 2 },
  ]);
  assert.doesNotThrow(() => openWorkspace(ROOT, memory.ops));
});

test('坐标个数与子卡数对不上时拒绝', () => {
  const { session } = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P' });
  createCard(session, { parentId: parent, title: 'A' });
  createCard(session, { parentId: parent, title: 'B' });

  assert.throws(
    () => setLayout(session, parent, 'plane', { placements: [{ x: 0, y: 0, w: 1, h: 1, z: 0 }] }),
    /坐标|数量/,
  );
});

test('plane → ordered：坐标被丢掉，但形状正确且能加载', () => {
  const { session, memory } = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P', layout: 'plane' });
  const a = createCard(session, { parentId: parent, title: 'A', plane: { x: 5, y: 6, w: 100, h: 60, z: 1 } });

  setLayout(session, parent, 'ordered');

  assert.deepEqual(session.state.children.get(parent), [{ id: a, order: 0 }]);
  assert.doesNotThrow(() => openWorkspace(ROOT, memory.ops));
});

test('没有子卡时改 layout 也照常工作', () => {
  const { session, memory } = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P' });

  setLayout(session, parent, 'grid');

  assert.equal(session.state.cards.get(parent)?.layout, 'grid');
  assert.equal(session.state.children.has(parent), false, '没有子卡就不留空数组（不变量 C）');
  assert.doesNotThrow(() => openWorkspace(ROOT, memory.ops));
});

test('改到同样的 layout 不做任何事（不发事件）', () => {
  const { session } = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
  const before = session.events.length;

  setLayout(session, parent, 'ordered');

  assert.equal(session.events.length, before);
});

// ── MCP 层：那条"AI 一句调用写死工作区"的路必须堵上 ───────────────────────────

function mcpSession(): Session {
  return openSession(ROOT, {
    clientId: 'mcp',
    ops: createMemoryFs().ops,
    clock: () => 0,
    newId: (() => {
      let n = 0;
      return () => `m${(n += 1)}`;
    })(),
    builtins: false,
  });
}

test('MCP 的 set_field 改 /layout 会被拒（而不是写坏工作区）', () => {
  const session = mcpSession();
  const parent = idOf(callTool(session, 'create_card', { title: 'P' }));
  idOf(callTool(session, 'create_card', { title: 'C', parentId: parent }));

  assert.throws(() => callTool(session, 'set_field', { cardId: parent, path: '/layout', value: 'ordered' }), /layout/);
  assert.equal(session.state.cards.get(parent)?.layout, 'plain', '拒绝之后 layout 不该被改');
});

test('MCP 的 set_layout 是那条路的正确替代', () => {
  const session = mcpSession();
  const parent = idOf(callTool(session, 'create_card', { title: 'P' }));
  const child = idOf(callTool(session, 'create_card', { title: 'C', parentId: parent }));

  const updated = callTool(session, 'set_layout', { cardId: parent, layout: 'ordered' }) as { layout: string };

  assert.equal(updated.layout, 'ordered');
  assert.deepEqual(session.state.children.get(parent), [{ id: child, order: 0 }]);
});

test('MCP 的 set_layout 自动分布平面子卡，同时遵守显式给出的坐标', () => {
  const session = mcpSession();
  const parent = idOf(callTool(session, 'create_card', { title: 'P' }));
  const children = Array.from({ length: 6 }, (_, index) =>
    idOf(callTool(session, 'create_card', { title: `C${index}`, parentId: parent })),
  );
  const automatic = callTool(session, 'set_layout', { cardId: parent, layout: 'plane' }) as { layout: string };
  assert.equal(automatic.layout, 'plane');
  const entries = session.state.children.get(parent) as PlaneEntry[];
  assert.deepEqual(entries.map(entry => entry.id), children, '自动排布不能改变节点身份或同级顺序');
  assert.equal(new Set(entries.map(entry => `${entry.x},${entry.y}`)).size, children.length);
  for (const entry of entries) {
    assert.ok([entry.x, entry.y, entry.w, entry.h, entry.z].every(Number.isFinite));
    assert.ok(entry.x >= 0 && entry.y >= 0 && entry.w > 0 && entry.h > 0);
    for (const other of entries) if (entry !== other) {
      assert.ok(entry.x + entry.w <= other.x || other.x + other.w <= entry.x || entry.y + entry.h <= other.y || other.y + other.h <= entry.y, '默认预览应能分别看到各张卡');
    }
  }

  const explicitParent = idOf(callTool(session, 'create_card', { title: 'Explicit' }));
  const explicitChild = idOf(callTool(session, 'create_card', { title: 'Positioned', parentId: explicitParent }));
  const placement = { x: 1, y: 2, w: 100, h: 60, z: 7 };

  const ok = callTool(session, 'set_layout', {
    cardId: explicitParent,
    layout: 'plane',
    placements: [placement],
  }) as { layout: string };
  assert.equal(ok.layout, 'plane');
  assert.deepEqual(session.state.children.get(explicitParent), [{ id: explicitChild, ...placement }]);
  assert.equal(snap(replay(session.events)), snap(session.state), '默认及显式坐标必须都可从事件恢复');
});
