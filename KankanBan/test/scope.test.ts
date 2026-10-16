/**
 * §2.6 的 `scope` 派生、§2.2 的内置卡表、§2.7 的"内置卡不可删"。
 *
 * 这三条文档都写得很死（§2.6 连代码都给了），所以这里是把**已经定好的规则**
 * 变成可执行断言，不是新增设计。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { BUILTIN_CARDS, builtinOf, isBuiltin, isDeletable, publicRootIds } from '../src/core/builtins.ts';
import { pathFromRoot, rootAncestorOf, scopeOf } from '../src/core/scope.ts';
import type { Layout } from '../src/core/types.ts';
import { rendererOf } from '../src/core/view-model.ts';
import { createCard, deleteCard, moveCard, openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

function makeSession(): Session {
  let counter = 0;
  return openSession('/s', {
      builtins: false,
    clientId: 's',
    ops: createMemoryFs().ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
  });
}

/** 把四张内置卡建出来。 */
function withBuiltins(session: Session): void {
  for (const card of BUILTIN_CARDS) {
    createCard(session, { id: card.id, parentId: null, title: card.name, layout: card.layout });
  }
}

// ── §2.2 内置卡表 ─────────────────────────────────────────────────────────────

test('内置卡表与 §2.2 一致', () => {
  assert.deepEqual(
    BUILTIN_CARDS.map((card) => [card.id, card.name, card.layout]),
    [
      ['000', 'main', 'tabs'],
      ['001', 'board', 'columns'],
      ['002', 'inspiration', 'plane'],
      ['003', 'prefabs', 'library'],
    ],
  );
});

test('公有区域恰好是 board 与 inspiration（§2.6 明确说的）', () => {
  assert.deepEqual([...publicRootIds()].sort(), ['001', '002']);
});

test('rendererOf 直接用内置表，不看卡的 type；id 保留所以卡没建出来也认', () => {
  const session = makeSession(); // 故意一张卡都不建

  for (const card of BUILTIN_CARDS) {
    assert.equal(rendererOf(session.state, card.id), card.layout satisfies Layout);
  }
  assert.equal(isBuiltin('000'), true);
  assert.equal(isBuiltin('c1'), false);
});

// ── §2.6 scope 派生 ───────────────────────────────────────────────────────────

test('根卡默认是私有', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });

  assert.equal(scopeOf(session.state, root), 'private');
});

test('board 的直接子卡与孙卡都是公有', () => {
  const session = makeSession();
  withBuiltins(session);
  const column = createCard(session, { parentId: '001', title: '列', layout: 'ordered' });
  const task = createCard(session, { parentId: column, title: '任务' });

  assert.equal(scopeOf(session.state, column), 'public');
  assert.equal(scopeOf(session.state, task), 'public', 'scope 是递归到深度 0 祖先，不是看直接父卡');
});

test('inspiration 子树也是公有', () => {
  const session = makeSession();
  withBuiltins(session);
  const card = createCard(session, {
    parentId: '002',
    title: '灵感',
    plane: { x: 0, y: 0, w: 200, h: 120, z: 1 },
  });

  assert.equal(scopeOf(session.state, card), 'public');
});

test('main 与 prefabs 子树是私有', () => {
  const session = makeSession();
  withBuiltins(session);
  const tab = createCard(session, { parentId: '000', title: '设置' });
  const prefab = createCard(session, { parentId: '003', title: '预制体' });

  assert.equal(scopeOf(session.state, tab), 'private');
  assert.equal(scopeOf(session.state, prefab), 'private');
});

test('把私有卡移到 board 下就变公有，移回来又变私有 —— 全靠移动', () => {
  const session = makeSession();
  withBuiltins(session);
  const column = createCard(session, { parentId: '001', title: '列', layout: 'ordered' });
  const loose = createCard(session, { parentId: null, title: '散卡' });

  assert.equal(scopeOf(session.state, loose), 'private');

  moveCard(session, loose, column, 0);
  assert.equal(scopeOf(session.state, loose), 'public');

  moveCard(session, loose, null, 0);
  assert.equal(scopeOf(session.state, loose), 'private');
});

test('rootAncestorOf 一路走到深度 0', () => {
  const session = makeSession();
  withBuiltins(session);
  const a = createCard(session, { parentId: '001', title: 'A' });
  const b = createCard(session, { parentId: a, title: 'B' });
  const c = createCard(session, { parentId: b, title: 'C' });

  assert.equal(rootAncestorOf(session.state, c), '001');
  assert.equal(rootAncestorOf(session.state, '001'), '001');
});

test('pathFromRoot 给出深度 0 祖先到这张卡的完整路径', () => {
  const session = makeSession();
  withBuiltins(session);
  const a = createCard(session, { parentId: '001', title: 'A' });
  const b = createCard(session, { parentId: a, title: 'B' });

  assert.deepEqual(pathFromRoot(session.state, b), ['001', a, b]);
});

test('父链成环时 rootAncestorOf 不挂死，也不抛错', () => {
  const session = makeSession();
  const a = createCard(session, { parentId: null, title: 'A' });
  const b = createCard(session, { parentId: a, title: 'B' });

  // 手动造一个环：a 的父卡是 b
  const cyclic = {
    cards: session.state.cards,
    children: new Map([
      [a, [{ id: b }]],
      [b, [{ id: a }]],
    ]),
    lastAppliedSeq: 2,
  };

  // 读路径上的函数不该因为一棵坏子树整体报错 —— 走到环就停，返回当时那张卡
  assert.equal(typeof rootAncestorOf(cyclic, a), 'string');
  assert.equal(scopeOf(cyclic, a), 'private');
});

// ── §2.7 内置卡不可删 ─────────────────────────────────────────────────────────

test('内置卡不可删', () => {
  const session = makeSession();
  withBuiltins(session);

  for (const card of BUILTIN_CARDS) {
    assert.throws(() => deleteCard(session, card.id), /内置卡|不可删/, `${card.id} 不该能删`);
  }
  assert.equal(isDeletable('001'), false);
  assert.equal(isDeletable('c1'), true);
});

test('内置卡即便挂在别的卡下面也仍然不可删（按 id 判定，不看位置）', () => {
  const session = makeSession();
  withBuiltins(session);

  // 挂到一个**非看板**的父卡下面。
  // （早先这里写的是把 003 移到 001 下 —— 那被 §2.5.1 的看板层级防线正确地拒了：
  //   移到看板下会让它变成一列。）
  const container = createCard(session, { parentId: null, title: '普通容器' });
  // Simulate imported legacy data: new UI no longer permits moving the library.
  session.state.children.set(container, [{ id: '003' }]);
  assert.equal(scopeOf(session.state, '003'), 'private');

  assert.throws(() => deleteCard(session, '003'), /内置卡|不可删/);
});

test('对照：普通卡照删不误，软删除标记生效', () => {
  const session = makeSession();
  withBuiltins(session);
  const mine = createCard(session, { parentId: null, title: '我的卡' });

  assert.doesNotThrow(() => deleteCard(session, mine));
  assert.equal(session.state.cards.get(mine)?.deleted, true);
});

test('builtinOf 对非内置 id 返回 undefined', () => {
  assert.equal(builtinOf('001')?.name, 'board');
  assert.equal(builtinOf('c9'), undefined);
});
