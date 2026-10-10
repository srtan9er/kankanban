/**
 * 多窗口（§2.8 W′ / §14 方案 A）的**可无头验证**部分：
 *
 *   1. `roleOfLabel` —— 一个 webview 靠自己的标签判断"我是谁"（照参考项目的 `note-{id}`）
 *   2. `runIntent`   —— 写者与镜像**共用同一份操作实现**，保证"卡片窗口发的意图"
 *                       与"main 本地点的操作"语义完全一致（否则两边会漂移）
 *
 * 真开窗 / 真关窗属于 GUI，按项目规则交给用户实机验；这里只保证这两块纯逻辑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { CARD_LABEL_PREFIX, labelOfCard, roleOfLabel } from '../src/webview/window-role.ts';
import { runIntent } from '../src/webview/operations.ts';
import { wantedCardWindows } from '../src/webview/window-sync.ts';
import { planBoot } from '../src/webview/boot-plan.ts';
import { desktopCards } from '../src/core/windows.ts';
import { openWindowsOf, openWindow, emptyViewState } from '../src/core/view-state.ts';
import { openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

function makeSession(): Session {
  let counter = 0;
  return openSession('/w', {
    builtins: false,
    clientId: 'mirror',
    ops: createMemoryFs().ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
  });
}

// ── 我是谁：标签就是身份 ─────────────────────────────────────────────────────

test('main 标签认成写者', () => {
  assert.deepEqual(roleOfLabel('main'), { kind: 'main' });
});

test('card-{id} 标签认成该卡的镜像窗口', () => {
  assert.deepEqual(roleOfLabel(`${CARD_LABEL_PREFIX}000`), { kind: 'card', cardId: '000' });
  assert.deepEqual(roleOfLabel(`${CARD_LABEL_PREFIX}c1abc-def`), {
    kind: 'card',
    cardId: 'c1abc-def',
  });
});

test('不是 Tauri（浏览器里跑）或标签不认识 → preview，退回单窗口预览', () => {
  assert.deepEqual(roleOfLabel(null), { kind: 'preview' });
  assert.deepEqual(roleOfLabel(undefined), { kind: 'preview' });
  assert.deepEqual(roleOfLabel(''), { kind: 'preview' });
  assert.deepEqual(roleOfLabel('some-other-window'), { kind: 'preview' });
});

test('card- 后面是空的 → 不是有效身份，别认成一张叫 "" 的卡', () => {
  assert.deepEqual(roleOfLabel(CARD_LABEL_PREFIX), { kind: 'preview' });
});

test('labelOfCard 与 roleOfLabel 互为逆运算', () => {
  for (const id of ['000', '001', 'c1', 'c1abc-def']) {
    const label = labelOfCard(id);
    assert.equal(label, `${CARD_LABEL_PREFIX}${id}`);
    assert.deepEqual(roleOfLabel(label), { kind: 'card', cardId: id });
  }
});

// ── 意图：写者与镜像共用同一份实现 ───────────────────────────────────────────

test('setField 意图改到标题，并回一个 ok', () => {
  const session = makeSession();
  const id = runIntent(session, { kind: 'createCard', parentId: null, title: '卡' });
  assert.equal(id.ok, true);

  const result = runIntent(session, { kind: 'setField', cardId: 'c1', path: '/title', value: '改过' });
  assert.deepEqual(result, { ok: true });
  assert.equal(session.state.cards.get('c1')?.title, '改过');
});

test('createCard 意图把新卡的 id 带回来（镜像要靠它进标题编辑）', () => {
  const session = makeSession();
  const root = runIntent(session, { kind: 'createCard', parentId: null, title: '父' });
  assert.equal(root.ok && root.createdId, 'c1');

  const child = runIntent(session, { kind: 'createCard', parentId: 'c1', title: '子' });
  assert.equal(child.ok && child.createdId, 'c2');
  assert.deepEqual(
    (session.state.children.get('c1') ?? []).map((entry) => entry.id),
    ['c2'],
  );
});

test('moveCard 意图能浮动到桌面（这就是"提出"要改的那一半树）', () => {
  const session = makeSession();
  runIntent(session, { kind: 'createCard', parentId: null, title: '容器' });
  runIntent(session, { kind: 'createCard', parentId: 'c1', title: '子' });

  const result = runIntent(session, { kind: 'moveCard', cardId: 'c2', parentId: null, index: 0 });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(desktopCards(session.state), ['c1', 'c2']);
});

test('deleteCard 意图回"删了几张"（界面要用它报数）', () => {
  const session = makeSession();
  runIntent(session, { kind: 'createCard', parentId: null, title: '容器' });
  runIntent(session, { kind: 'createCard', parentId: 'c1', title: '子1' });
  runIntent(session, { kind: 'createCard', parentId: 'c1', title: '子2' });

  assert.deepEqual(runIntent(session, { kind: 'deleteCard', cardId: 'c1' }), {
    ok: true,
    removed: 3,
  });
});

test('setLayout 意图走的是 setLayout，不是 setField(/layout)', () => {
  const session = makeSession();
  runIntent(session, { kind: 'createCard', parentId: null, title: '卡' });

  assert.deepEqual(runIntent(session, { kind: 'setLayout', cardId: 'c1', layout: 'ordered' }), {
    ok: true,
  });
  assert.equal(session.state.cards.get('c1')?.layout, 'ordered');
});

test('undo 意图：有得撤就撤，没得撤也不报错', () => {
  const session = makeSession();
  runIntent(session, { kind: 'createCard', parentId: null, title: '卡' });

  assert.deepEqual(runIntent(session, { kind: 'undo' }), { ok: true, undone: true });
  assert.deepEqual(runIntent(session, { kind: 'undo' }), { ok: true, undone: false });
  assert.deepEqual(desktopCards(session.state), []);
});

test('意图失败**不抛异常**，而是把消息带回来 —— 镜像那边不能因为一条坏意图就白屏', () => {
  const session = makeSession();

  const missing = runIntent(session, { kind: 'setField', cardId: '没有这张卡', path: '/title', value: 'x' });
  assert.equal(missing.ok, false);
  assert.match(missing.ok === false ? missing.message : '', /没有这张卡|不存在/);

  const cycle = runIntent(session, { kind: 'moveCard', cardId: 'nope', parentId: 'nope', index: 0 });
  assert.equal(cycle.ok, false);
});

test('意图不会顺手改视图状态 —— 开不开窗是写者的事，不是操作的事', () => {
  const session = makeSession();
  runIntent(session, { kind: 'createCard', parentId: null, title: '卡' });

  const view = openWindow(emptyViewState(), 'c1');
  assert.deepEqual(openWindowsOf(view), ['c1']);
  // 新建一张根卡不会自动出现在 openWindows 里（候选 ≠ 已开）
  runIntent(session, { kind: 'createCard', parentId: null, title: '另一张' });
  assert.deepEqual(openWindowsOf(view), ['c1']);
  assert.deepEqual(desktopCards(session.state), ['c1', 'c2']);
});

// ── 写者算"该有哪些真窗口" ───────────────────────────────────────────────────

test('wantedCardWindows：没记过就一个都不开', () => {
  const session = makeSession();
  runIntent(session, { kind: 'createCard', parentId: null, title: 'A' });

  assert.deepEqual(wantedCardWindows(session.state, [], null), []);
});

test('wantedCardWindows 去掉本窗口正在显示的那张卡 —— 否则同一张卡两个窗口', () => {
  const session = makeSession();
  runIntent(session, { kind: 'createCard', parentId: null, title: 'A' });
  runIntent(session, { kind: 'createCard', parentId: null, title: 'B' });

  assert.deepEqual(wantedCardWindows(session.state, ['c1', 'c2'], null), ['c1', 'c2']);
  assert.deepEqual(wantedCardWindows(session.state, ['c1', 'c2'], 'c1'), ['c2']);
});

test('wantedCardWindows 去掉 main —— main 那扇窗口本身就是它', () => {
  const session = makeSession();
  runIntent(session, { kind: 'createCard', parentId: null, title: 'A' });

  // 记着的集合里混进 main（真实工作区里一定有）不会多开一扇 card-000
  assert.deepEqual(wantedCardWindows(session.state, ['000', 'c1'], null), ['c1']);
});

test('wantedCardWindows 被子集关系过滤：已拖进容器的卡不再有窗口', () => {
  const session = makeSession();
  runIntent(session, { kind: 'createCard', parentId: null, title: '容器' });
  runIntent(session, { kind: 'createCard', parentId: 'c1', title: '子' });

  assert.deepEqual(wantedCardWindows(session.state, ['c1', 'c2'], null), ['c1']);
});

// ── 启动分流：镜像由标签决定，不做任何决策 ───────────────────────────────────

test('planBoot：卡片窗口只渲染它自己那张卡，不建示例', () => {
  const session = makeSession();
  runIntent(session, { kind: 'createCard', parentId: null, title: 'A' });

  assert.deepEqual(planBoot(session.state, [], { kind: 'card', cardId: 'c1' }), {
    seedDemo: false,
    windowId: 'c1',
  });
});

test('planBoot：写者的决策照旧（role 默认值不改变单窗口行为）', () => {
  const session = makeSession();
  runIntent(session, { kind: 'createCard', parentId: null, title: 'A' });

  // 已有用户卡 → 不再播种；没有记过任何窗口 → 走"退而挑一张用户卡"的权宜
  assert.deepEqual(planBoot(session.state, [], { kind: 'main' }), {
    seedDemo: false,
    windowId: 'c1',
  });
  // 不传 role 时也是同一条路径（旧调用点不受影响）
  assert.deepEqual(planBoot(session.state, []), { seedDemo: false, windowId: 'c1' });
});
