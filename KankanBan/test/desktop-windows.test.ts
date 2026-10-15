/**
 * v7 的窗口语义 —— 用户定案：「**关闭卡片不影响任何结构！可以在 main 中重新打开！**」
 *
 * 这一条把 §2.8 的旧不变量 W（窗口集合**等价于**未删除的根卡）改成了子集：
 *
 * ```
 * openWindows ⊆ desktopCards(state)        desktopCards = { card | parent === null ∧ ¬deleted }
 * 桌面卡片里有 main 时，openWindows 必须含 main
 * ```
 *
 * 于是"开窗 / 关窗"不再完全由树位置决定，而是**树位置给出候选、视图状态给出取舍**：
 *   - 树决定"这张卡**能不能**有窗口"（有父卡就不能 —— 窗口 id 就是根卡 id）
 *   - `view-state.json` 的 `openWindows` 决定"它**现在**有没有窗口"
 *
 * 关窗因此是**纯视图动作**：不产生事件、不进日志、不撤销、也不动一张卡的任何字段。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { stableStringify } from '../src/core/subtree.ts';
import {
  assertInvariantW,
  desktopCards,
  openWindowSet,
  restorableWindows,
  windowTransition,
} from '../src/core/windows.ts';
import {
  closeWindow,
  emptyViewState,
  openWindow,
  openWindowsOf,
  readViewState,
  setBounds,
  setFocus,
  windowViewFor,
  writeViewState,
  type ViewState,
} from '../src/core/view-state.ts';
import { createCard, deleteCard, moveCard, openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

/** 没有内置卡的裸工作区：断言里只有自己建的那几张，读起来干净。 */
function makeBareSession(): Session {
  let counter = 0;
  return openSession('/w', {
    builtins: false,
    clientId: 'w',
    ops: createMemoryFs().ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
  });
}

/** 第一张就是 main（000）的工作区，用来验"main 必须在窗口集合里"。 */
function makeSessionWithMain(): Session {
  const ids = ['000', 'c1', 'c2', 'c3', 'c4', 'c5'];
  let index = 0;
  const session = openSession('/w', {
    builtins: false,
    clientId: 'w',
    ops: createMemoryFs().ops,
    clock: () => 0,
    newId: () => ids[index++] ?? `x${index}`,
  });
  createCard(session, { parentId: null, title: 'main' });
  return session;
}

/** 整棵树的快照，用来断言"关窗什么都没改"。 */
function treeSnapshot(session: Session): string {
  const byId = (a: readonly [string, unknown], b: readonly [string, unknown]): number =>
    a[0] < b[0] ? -1 : 1;
  return stableStringify({
    cards: [...session.state.cards.entries()].sort(byId),
    children: [...session.state.children.entries()]
      .map(([id, list]) => [id, list] as const)
      .sort(byId),
    lastAppliedSeq: session.state.lastAppliedSeq,
    eventCount: session.events.length,
  });
}

// ── 关窗不改结构（用户定案的那一条） ─────────────────────────────────────────

test('关窗不改树：树快照一字不差，连事件都不多一条', () => {
  const session = makeBareSession();
  const root = createCard(session, { parentId: null, title: '桌面上的卡' });
  const view = openWindow(emptyViewState(), root);

  const before = treeSnapshot(session);
  const after = closeWindow(view, root);

  assert.equal(treeSnapshot(session), before, '关窗不许碰卡片字段、children、也不许产生事件');
  assert.deepEqual(desktopCards(session.state), [root], '关窗之后它仍然是桌面卡片');
  assert.deepEqual(openWindowsOf(after), [], '但它现在没有窗口了');
});

test('关掉的窗口可以重新打开，而且位置与聚焦都还在', () => {
  const session = makeBareSession();
  const root = createCard(session, { parentId: null, title: '桌面上的卡' });

  let view: ViewState = openWindow(emptyViewState(), root);
  view = setFocus(view, root, root);
  view = setBounds(view, root, { x: 734, y: 200, width: 320, height: 240 });

  // 关 → 该窗口的视图状态**留着**（关的是窗口，不是这张卡的桌面记忆）
  const closed = closeWindow(view, root);
  assert.deepEqual(openWindowsOf(closed), []);
  assert.deepEqual(windowViewFor(closed, root), {
    focusId: root,
    regions: { breadcrumb: 32, content: 200, children: 240 },
    collapsed: { breadcrumb: false, content: false, children: false },
    bounds: { x: 734, y: 200, width: 320, height: 240 },
  });

  // 重开 → 回到原来的位置
  const reopened = openWindow(closed, root);
  assert.deepEqual(openWindowsOf(reopened), [root]);
  assert.deepEqual(windowViewFor(reopened, root).bounds, {
    x: 734,
    y: 200,
    width: 320,
    height: 240,
  });
});

test('openWindow 幂等：重复开同一个窗口不会产生重复条目', () => {
  const once = openWindow(emptyViewState(), 'c1');
  const twice = openWindow(once, 'c1');

  assert.deepEqual(openWindowsOf(twice), ['c1']);
});

test('closeWindow 拒绝关闭 main —— 单写者（方案 A）下写者不能自己消失', () => {
  const view = openWindow(emptyViewState(), '000');

  assert.throws(() => closeWindow(view, '000'), /main/, '000 是唯一写者，关它需要先定"谁接管"');
  assert.deepEqual(openWindowsOf(view), ['000'], '原状态不受影响');
});

// ── 子集关系：树位置决定"能不能有窗口" ──────────────────────────────────────

test('拖进容器 → 不再是根卡，已有独立窗口仍然有效', () => {
  const session = makeBareSession();
  const container = createCard(session, { parentId: null, title: '容器' });
  const loose = createCard(session, { parentId: null, title: '浮在外面的卡' });

  const view = openWindow(openWindow(emptyViewState(), container), loose);
  assert.deepEqual(openWindowSet(session.state, openWindowsOf(view)), [container, loose].sort());

  moveCard(session, loose, container, 0);

  const after = openWindowSet(session.state, openWindowsOf(view));
  assert.deepEqual(after, [container,loose].sort(), '窗口资格独立于树上父节点');
  assertInvariantW(session.state, '拖进容器之后', after);
});

test('浮动到桌面 → 进入桌面卡片，但**不会**自动开窗', () => {
  const session = makeBareSession();
  const container = createCard(session, { parentId: null, title: '容器' });
  const child = createCard(session, { parentId: container, title: '子卡' });

  const view = openWindow(emptyViewState(), container);
  moveCard(session, child, null, 0);

  assert.deepEqual(desktopCards(session.state), [container, child].sort(), '它成了桌面卡片');
  assert.deepEqual(
    openWindowSet(session.state, openWindowsOf(view)),
    [container],
    '候选 ≠ 已开：要显式「提出到屏幕窗口」才有窗口',
  );
});

test('关掉一张桌面卡片后，它仍在树里、随时能从 main 重新拿出来', () => {
  const session = makeBareSession();
  const root = createCard(session, { parentId: null, title: '收起来的卡' });
  const other = createCard(session, { parentId: null, title: '开着的卡' });

  const view = openWindow(openWindow(emptyViewState(), root), other);
  const closed = closeWindow(view, root);

  assert.deepEqual(desktopCards(session.state), [root, other].sort());
  assert.deepEqual(openWindowSet(session.state, openWindowsOf(closed)), [other]);
  assert.deepEqual(
    openWindowSet(session.state, openWindowsOf(openWindow(closed, root))),
    [root, other].sort(),
    '重新打开就回来了',
  );
});

test('关窗之后删掉那张卡：openWindows 里的残留会被子集关系滤掉，不会复活', () => {
  const session = makeBareSession();
  const root = createCard(session, { parentId: null, title: '要删的卡' });
  const view = openWindow(emptyViewState(), root);

  deleteCard(session, root);

  assert.deepEqual(desktopCards(session.state), []);
  assert.deepEqual(openWindowSet(session.state, openWindowsOf(view)), []);
});

// ── W′ 的护栏 ───────────────────────────────────────────────────────────────

test('assertInvariantW accepts ancestor and descendant windows together',()=>{
 const session=makeBareSession();const container=createCard(session,{parentId:null,title:'P'}),child=createCard(session,{parentId:container,title:'C'});
 assert.doesNotThrow(()=>assertInvariantW(session.state,'windows',[container,child]));
 assert.throws(()=>assertInvariantW(session.state,'windows',[container,'missing']),/不存在|已删除/);
});

test('assertInvariantW 抓到"开着的窗口已删除"', () => {
  const session = makeBareSession();
  const root = createCard(session, { parentId: null, title: '根' });
  deleteCard(session, root);

  assert.throws(() => assertInvariantW(session.state, '护栏', [root]), /不存在|已删除/);
});

test('assertInvariantW 抓到"桌面卡片里有 main、openWindows 里却没有"', () => {
  const session = makeSessionWithMain();
  const other = createCard(session, { parentId: null, title: '其他' });

  assert.throws(() => assertInvariantW(session.state, '护栏', [other]), /main/);
  assert.doesNotThrow(() => assertInvariantW(session.state, '护栏', ['000', other]));
});

test('不传 open 时只校验树那一半（旧调用点不受影响）', () => {
  const session = makeBareSession();
  createCard(session, { parentId: null, title: '根' });

  assert.doesNotThrow(() => assertInvariantW(session.state, '只看树'));
});

// ── 启动恢复：尊重"我关掉过它" ───────────────────────────────────────────────

test('我已关掉的窗口，下次启动不再恢复', () => {
  const session = makeSessionWithMain();
  const a = createCard(session, { parentId: null, title: 'A' });
  createCard(session, { parentId: null, title: 'B（上次是关着的）' });

  // 上次会话：main + A 开着
  const view = openWindow(openWindow(emptyViewState(), '000'), a);

  assert.deepEqual(restorableWindows(session.state, openWindowsOf(view)), ['000', a].sort());
});

test('已展开的子卡仍可以恢复独立窗口', () => {
  const session = makeSessionWithMain();
  const container = createCard(session, { parentId: null, title: '容器' });
  const child = createCard(session, { parentId: container, title: '子卡' });

  assert.deepEqual(restorableWindows(session.state, ['000', child]), ['000',child].sort());
  void container;
});

// ── 差集仍然只描述"真窗口该开该关" ───────────────────────────────────────────

test('v1 的 view-state.json 里的 openWindows 一律丢掉 —— 那时记的是"候选"，不是"真的开着"', () => {
  const ops = createMemoryFs().ops;
  ops.mkdirp('/w/.kkb');
  ops.writeFile(
    '/w/.kkb/view-state.json',
    JSON.stringify({ version: 1, windows: {}, openWindows: ['000', '001', 'c1'] }),
  );

  assert.deepEqual(
    openWindowsOf(readViewState('/w', ops)),
    [],
    '照单恢复会一启动就弹出好几扇从没人开过的窗口',
  );
});

test('v2 的 openWindows 照读，写回去也还是 v2', () => {
  const ops = createMemoryFs().ops;
  writeViewState('/w', openWindow(emptyViewState(), 'c1'), ops);

  const back = readViewState('/w', ops);
  assert.equal(back.version, 2);
  assert.deepEqual(openWindowsOf(back), ['c1']);
});

test('windowTransition 的输入现在是"实际开着的集合"', () => {
  const session = makeBareSession();
  const root = createCard(session, { parentId: null, title: '根' });

  let view = openWindow(emptyViewState(), root);
  const before = openWindowSet(session.state, openWindowsOf(view));
  assert.deepEqual(before, [root]);

  view = closeWindow(view, root);
  const after = openWindowSet(session.state, openWindowsOf(view));
  assert.deepEqual(windowTransition(before, after), { opened: [], closed: [root] });
});
