/**
 * §2.2 的「强制存在」：四张内置卡必须在新工作区里就有。
 *
 * 上一轮发现它们**谁都建不出来** —— `openSession` 不建、MCP 的 `create_card` 又不暴露 `id`，
 * 于是 `read_tree({scope:'public'})` 在真实工作区里**永远返回空**。
 * 公有区域这条链（§2.6 的 scope、§9.2 的 scope 过滤）因此在端到端上从没被验过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { BUILTIN_CARDS } from '../src/core/builtins.ts';
import { replay } from '../src/core/replay.ts';
import { scopeOf } from '../src/core/scope.ts';
import { openWorkspace } from '../src/core/storage/workspace-io.ts';
import { createCard, ensureBuiltins, openSession, readTree } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { desktopCards } from '../src/core/windows.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

const ROOT = '/b';

/** 真实入口的用法：**不传** `builtins`，于是默认确保内置卡存在。 */
function openReal(root = ROOT): { session: Session; memory: ReturnType<typeof createMemoryFs> } {
  const memory = createMemoryFs();
  let counter = 0;
  const session = openSession(root, {
    clientId: 'real',
    ops: memory.ops,
    clock: () => 1_700_000_000_000,
    newId: () => `c${(counter += 1)}`,
  });
  return { session, memory };
}

test('新工作区一打开就有四张内置卡', () => {
  const { session } = openReal();

  for (const builtin of BUILTIN_CARDS) {
    const card = session.state.cards.get(builtin.id);
    assert.ok(card !== undefined, `${builtin.id} 应当存在`);
    assert.equal(card.title, builtin.name);
    assert.equal(card.layout, builtin.layout);
    assert.equal(card.deleted, false);
  }
});

test('四张内置卡都是窗口（根卡），且顺序稳定', () => {
  const { session } = openReal();

  assert.deepEqual(desktopCards(session.state), ['000', '001', '002', '003']);
});

test('内置卡是用**普通事件**建的：重放日志能一模一样地重建出来', () => {
  const { session } = openReal();

  const replayed = replay(session.events);

  assert.equal(session.events.length, BUILTIN_CARDS.length);
  assert.deepEqual(
    [...replayed.cards.keys()].sort(),
    [...session.state.cards.keys()].sort(),
  );
  assert.deepEqual(desktopCards(replayed), desktopCards(session.state));
});

test('内置卡的 scope 与 §2.2 一致：001/002 公有，000/003 私有', () => {
  const { session } = openReal();

  assert.equal(scopeOf(session.state, '001'), 'public');
  assert.equal(scopeOf(session.state, '002'), 'public');
  assert.equal(scopeOf(session.state, '000'), 'private');
  assert.equal(scopeOf(session.state, '003'), 'private');
});

test('read_tree 的 scope=public 终于能给东西了（上一轮这里永远为空）', () => {
  const { session } = openReal();

  const pub = readTree(session, { scope: 'public' });

  assert.deepEqual(pub.nodes.map((n) => n.id), ['001', '002']);
});

test('反过来：scope=private 不含公有那两棵', () => {
  const { session } = openReal();

  const priv = readTree(session, { scope: 'private' });

  assert.deepEqual(priv.nodes.map((n) => n.id), ['000', '003']);
  assert.equal(priv.nodes.some((n) => n.id === '001'), false);
});

test('重复调用 ensureBuiltins 不会重复建（幂等）', () => {
  const { session } = openReal();
  const before = session.events.length;

  const created = ensureBuiltins(session);

  assert.deepEqual(created, [], '已经都在了，不该再建');
  assert.equal(session.events.length, before, '也不该多出事件');
});

test('重开工作区不会又把内置卡建一遍', () => {
  const { session, memory } = openReal();
  const eventsAfterFirstOpen = session.events.length;

  const reopened = openSession(ROOT, { clientId: 'real', ops: memory.ops, clock: () => 0 });

  assert.equal(reopened.events.length, eventsAfterFirstOpen, '日志不该变长');
  assert.deepEqual(desktopCards(reopened.state), ['000', '001', '002', '003']);
});

test('显式传 builtins:false 时不建 —— 这是给"要最小树"的场景留的口子', () => {
  const memory = createMemoryFs();
  const session = openSession(ROOT, { clientId: 't', ops: memory.ops, builtins: false });

  assert.equal(session.state.cards.size, 0);
  assert.deepEqual(desktopCards(session.state), []);
});

test('内置卡建出来之后就受"不可删"保护', () => {
  const { session } = openReal();

  assert.throws(() => createCard(session, { id: '001', parentId: null, title: '重复' }), /已存在/);
});

test('内置卡落在磁盘上，换个会话读回来还在', () => {
  const { memory } = openReal();

  const { state } = openWorkspace(ROOT, memory.ops);

  assert.deepEqual([...state.cards.keys()].sort(), ['000', '001', '002', '003']);
});

test('用户建的卡与内置卡并存，且用户的仍是私有', () => {
  const { session } = openReal();
  const mine = createCard(session, { parentId: null, title: '我的卡' });

  assert.equal(scopeOf(session.state, mine), 'private');
  assert.deepEqual(desktopCards(session.state), ['000', '001', '002', '003', mine].sort());
  assert.deepEqual(readTree(session, { scope: 'public' }).nodes.map((n) => n.id), ['001', '002']);
});
