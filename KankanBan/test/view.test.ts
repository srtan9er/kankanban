/**
 * 阶段一·五的**模型半场**：视图状态持久化 + 渲染分派 / 面包屑 / 聚焦回退。
 *
 * §10 说阶段一·五要"先压到数据模型的形状"，会同时用到 `ChildEntry` 多形状、
 * `type` 渲染分派、聚焦 id、折叠态存哪里。这四件事**都不需要窗口**就能验完，
 * 所以先在这里钉死；React 外壳下一轮再说。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import '../src/node/bootstrap.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCard, deleteCard, moveCard, openSession, undoLast } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import {
  REGIONS,
  defaultRegions,
  emptyViewState,
  forgetWindow,
  readViewState,
  setBounds,
  setFocus,
  setRegionSize,
  windowViewFor,
  writeViewState,
  type ViewState,
} from '../src/core/view-state.ts';
import {
  breadcrumbTo,
  orderedChildren,
  rendererOf,
  resolveFocus,
  viewOf,
  type CardView,
} from '../src/core/view-model.ts';
import type { Layout, OrderedEntry, PlaneEntry } from '../src/core/types.ts';
/** `viewOf` 现在可能返回 null（根卡没了）。这里测的场景里根卡一直在，所以断言非空。 */
function mustView(...args: Parameters<typeof viewOf>): CardView {
  const model = viewOf(...args);
  assert.ok(model !== null, 'viewOf 不该返回 null：这些场景里窗口根卡一直存在');
  return model;
}

function withSession(body: (session: Session, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'kkb-view-'));
  try {
    let counter = 0;
    body(
      openSession(root, { builtins: false, clientId: 't', clock: () => 0, newId: () => `c${(counter += 1)}` }),
      root,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── view-state.json：纯本机、可往返 ──────────────────────────────────────────

test('view-state 往返：写完读回来逐字段一致', () => {
  withSession((session, root) => {
    let view: ViewState = { ...emptyViewState(), skin: 'dark', theme: 'custom.css', canvasSwapButtons: false, cardRadius: 14 };
    view = setFocus(view, 'c1', 'c3');
    view = setRegionSize(view, 'c1', 'content', 321);
    view = setBounds(view, 'c1', { x: 10, y: 20, width: 400, height: 300 });

    writeViewState(root, view);
    const back = readViewState(root);

    assert.deepEqual(back, view);
  });
});

test('没见过的窗口给一份默认：focus 是窗口自己的根卡', () => {
  const window = windowViewFor(emptyViewState(), 'c9');

  assert.equal(window.focusId, 'c9');
  assert.deepEqual(window.regions, defaultRegions());
  assert.deepEqual(window.collapsed, { breadcrumb: false, content: false, children: false });
  assert.equal(window.bounds, null);
});

test('改视图状态是纯函数，不改动入参', () => {
  const before = emptyViewState();

  const after = setFocus(before, 'c1', 'c2');

  assert.deepEqual(before.windows, {});
  assert.equal(windowViewFor(after, 'c1').focusId, 'c2');
});

test('区域尺寸拖到 0 视为折叠（§3.1）', () => {
  let view = emptyViewState();
  view = setRegionSize(view, 'c1', 'content', 0);

  const window = windowViewFor(view, 'c1');
  assert.equal(window.regions.content, 0);
  assert.equal(window.collapsed.content, true);
});

test('折叠之后再拖回来就取消折叠', () => {
  let view = emptyViewState();
  view = setRegionSize(view, 'c1', 'content', 0);
  view = setRegionSize(view, 'c1', 'content', 180);

  assert.equal(windowViewFor(view, 'c1').collapsed.content, false);
});

test('区域尺寸不接受负数', () => {
  assert.throws(() => setRegionSize(emptyViewState(), 'c1', 'content', -5), /负数|非负|非法/);
});

test('forgetWindow 清掉某窗口，别的窗口不受影响', () => {
  let view = emptyViewState();
  view = setFocus(view, 'c1', 'c2');
  view = setFocus(view, 'c9', 'c9');

  view = forgetWindow(view, 'c1');

  assert.equal(view.windows['c1'], undefined);
  assert.equal(windowViewFor(view, 'c9').focusId, 'c9');
});

test('view-state 文件缺失时读回空状态，不抛错', () => {
  withSession((_session, root) => {
    assert.deepEqual(readViewState(root), emptyViewState());
  });
});

// ── §2.5 渲染分派 ────────────────────────────────────────────────────────────

test('rendererOf：内置 id 用内置渲染器，不看 type', () => {
  withSession((session) => {
    // 内置 id 是**保留**的：即使卡片还没被建出来（阶段三才建），分派也照样成立。
    assert.equal(rendererOf(session.state, '000'), 'tabs');
    assert.equal(rendererOf(session.state, '001'), 'columns');
    assert.equal(rendererOf(session.state, '002'), 'plane');
    assert.equal(rendererOf(session.state, '003'), 'library');

    // 真的把内置卡建出来，结果不变
    const board = createCard(session, { id: '001', parentId: null, title: 'board', layout: 'columns' });
    assert.equal(rendererOf(session.state, board), 'columns');
  });
});

test('rendererOf：普通卡无引用时直接使用自己的 layout', () => {
  withSession((session) => {
    // §2.5.1 第 2 步读的是 **type 指向的那张卡** 的 layout，不是自己的。
    // 所以一张 type 为空的 cards 自己 layout 写什么都不影响它怎么被渲染；
    // 它自己的 layout 只影响两件事：别人的 type 指向它时、以及它的子卡条目形状。
    const card = createCard(session, { parentId: null, title: '自带 columns 的普通卡', layout: 'columns' });

    assert.equal(rendererOf(session.state, card), 'columns');
  });
});

test('rendererOf：type 指向呈现定义卡时，用那张卡的 layout', () => {
  withSession((session) => {
    // 呈现定义卡自己 type 为 null（§2.5 终止规则）
    const template = createCard(session, { parentId: null, title: '横列模板', layout: 'ordered' });
    const card = createCard(session, { parentId: null, title: '实例', type: template });

    assert.equal(rendererOf(session.state, card), 'ordered');
  });
});

test('rendererOf：type 为 null 时是 plain', () => {
  withSession((session) => {
    const card = createCard(session, { parentId: null, title: '普通' });

    assert.equal(rendererOf(session.state, card), 'plain');
  });
});

test('rendererOf：type 指向一张又带 type 的卡时直接抛错（链长恒为 1）', () => {
  withSession((session) => {
    const deep = createCard(session, { parentId: null, title: '深', layout: 'ordered' });
    const middle = createCard(session, { parentId: null, title: '中', type: deep });
    const card = createCard(session, { parentId: null, title: '外', type: middle });

    assert.throws(() => rendererOf(session.state, card), /type|链|终止/);
  });
});

test('rendererOf：type 指向不存在的卡时抛错', () => {
  withSession((session) => {
    const card = createCard(session, { parentId: null, title: 'x', type: 'ghost' });

    assert.throws(() => rendererOf(session.state, card), /不存在|ghost/);
  });
});

// ── 子卡排序（不变量 O 的下游） ──────────────────────────────────────────────

test('orderedChildren 按 order 升序，且等于数组顺序', () => {
  withSession((session) => {
    const parent = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
    const a = createCard(session, { parentId: parent, title: 'A' });
    const b = createCard(session, { parentId: parent, title: 'B' });
    const c = createCard(session, { parentId: parent, title: 'C' });
    const tail = createCard(session, { parentId: null, title: 'T' });

    moveCard(session, tail, parent, 1);

    const ordered = orderedChildren(session.state, parent);
    assert.deepEqual(ordered.map((e) => e.id), [a, tail, b, c]);
    assert.deepEqual(
      ordered.map((e) => (e as OrderedEntry).order),
      [0, 0.5, 1, 2],
    );
  });
});

test('orderedChildren 对 plane 父卡原样返回坐标条目', () => {
  withSession((session) => {
    const plane = createCard(session, { parentId: null, title: '灵', layout: 'plane' });
    const card = createCard(session, {
      parentId: plane,
      title: 'P',
      plane: { x: 5, y: 6, w: 100, h: 80, z: 1 },
    });

    const ordered = orderedChildren(session.state, plane);
    assert.deepEqual(ordered, [{ id: card, x: 5, y: 6, w: 100, h: 80, z: 1 } satisfies PlaneEntry]);
  });
});

// ── §3.4 聚焦与面包屑 ────────────────────────────────────────────────────────

test('面包屑是窗口根卡到聚焦卡的路径', () => {
  withSession((session) => {
    const root = createCard(session, { parentId: null, title: '根' });
    const mid = createCard(session, { parentId: root, title: '中' });
    const leaf = createCard(session, { parentId: mid, title: '叶' });

    const trail = breadcrumbTo(session.state, root, leaf);

    assert.deepEqual(trail.map((c) => c.id), [root, mid, leaf]);
    assert.deepEqual(trail.map((c) => c.title), ['根', '中', '叶']);
  });
});

test('聚焦卡被删掉后退回最近的活祖先', () => {
  withSession((session) => {
    const root = createCard(session, { parentId: null, title: '根' });
    const mid = createCard(session, { parentId: root, title: '中' });
    const leaf = createCard(session, { parentId: mid, title: '叶' });

    deleteCard(session, mid);

    // mid 连同 leaf 一起软删了 → 聚焦回退到根
    assert.equal(resolveFocus(session.state, root, leaf), root);
    assert.equal(resolveFocus(session.state, root, mid), root);
  });
});

test('聚焦 id 指向别的窗口的卡时也退回本窗口的根卡', () => {
  withSession((session) => {
    const windowA = createCard(session, { parentId: null, title: 'A 窗' });
    const windowB = createCard(session, { parentId: null, title: 'B 窗' });
    const otherChild = createCard(session, { parentId: windowB, title: 'B 的子卡' });

    assert.equal(resolveFocus(session.state, windowA, otherChild), windowA);
  });
});

// ── 三区域视图 ───────────────────────────────────────────────────────────────

test('viewOf 给出三区域尺寸、正文可见性与子卡', () => {
  withSession((session) => {
    const root = createCard(session, { parentId: null, title: '根', content: '# 正文' });
    const child = createCard(session, { parentId: root, title: '子' });

    let view = emptyViewState();
    view = setRegionSize(view, root, 'content', 0);

    const card = mustView(session.state, view, root);

    assert.equal(card.form, 'full');
    assert.equal(card.contentShown, true);
    assert.equal(card.content, '# 正文');
    assert.equal(card.regions.content.collapsed, true);
    assert.deepEqual(card.children.map((c) => c.id), [child]);
    assert.equal(card.children[0]?.form, 'compact');
    assert.equal(card.columns, null);
  });
});

test('board（columns）不显示自己的正文，而是跨一层投影孙卡', () => {
  withSession((session) => {
    // 真正的 board 是内置卡 001；这里顺带把"用户自己造一个 columns 呈现"这条路也走了。
    const template = createCard(session, { id: '001', parentId: null, title: '看板模板', layout: 'columns' });
    const board = createCard(session, {
      parentId: null,
      title: '看板',
      type: template,
      content: '不显示',
    });
    // 列卡是普通卡（有 id、有 title、可下钻），只是在本视图里只拿 title 当列头。
    const colTodo = createCard(session, { parentId: board, title: '待办', layout: 'ordered', content: '也不显示' });
    const task = createCard(session, { parentId: colTodo, title: '任务一' });

    const card = mustView(session.state, emptyViewState(), board);

    assert.equal(card.renderer, 'columns');
    assert.equal(card.contentShown, false, 'board 自身不显示正文');
    assert.equal(card.columns?.length, 1);
    assert.equal(card.columns?.[0]?.header, '待办', '列头是列卡的标题');
    assert.deepEqual(card.columns?.[0]?.cards.map((c) => c.id), [task]);
  });
});

test('内置 001 直接用内置渲染器跨一层投影', () => {
  withSession((session) => {
    const board = createCard(session, { id: '001', parentId: null, title: 'board', layout: 'columns' });
    const col = createCard(session, { parentId: board, title: '进行中', layout: 'ordered' });
    const task = createCard(session, { parentId: col, title: '任务' });

    const card = mustView(session.state, emptyViewState(), board);

    assert.equal(card.renderer, 'columns');
    assert.equal(card.contentShown, false);
    assert.deepEqual(card.columns?.[0]?.cards.map((c) => c.id), [task]);
  });
});

test('inspiration（plane）也不显示正文', () => {
  withSession((session) => {
    const plane = createCard(session, { id: '002', parentId: null, title: '灵感台', layout: 'plane', content: '不显示' });

    assert.equal(mustView(session.state, emptyViewState(), plane).contentShown, false);
  });
});

test('viewOf 的聚焦与面包屑跟着 view-state 走', () => {
  withSession((session) => {
    const root = createCard(session, { parentId: null, title: '根' });
    const mid = createCard(session, { parentId: root, title: '中' });
    createCard(session, { parentId: mid, title: '叶' });

    let view = emptyViewState();
    view = setFocus(view, root, mid);

    const card = mustView(session.state, view, root);

    assert.equal(card.id, mid);
    assert.deepEqual(card.breadcrumb.map((c) => c.id), [root, mid]);
  });
});

test('三区域名与 §3.1 一致', () => {
  assert.deepEqual(REGIONS, ['breadcrumb', 'content', 'children']);
});

test('窗口根卡不存在时 viewOf 返回 null，而不是抛错把渲染打断', () => {
  withSession((session) => {
    const root = createCard(session, { parentId: null, title: '根' });

    // 注意：**软删不够** —— 软删的卡仍在 `cards` 里（只是 `deleted: true`），viewOf 照样有内容。
    // 真正让卡从 `cards` 里彻底消失的是**撤销一次建卡**，这也正是实测炸出这个问题的路径。
    assert.equal(undoLast(session), true);

    assert.equal(session.state.cards.has(root), false, '撤销建卡之后卡应当彻底不在');
    assert.equal(viewOf(session.state, emptyViewState(), root), null);
  });
});

test('软删掉根卡时 viewOf 仍然给得出东西（卡还在，只是被标记）', () => {
  withSession((session) => {
    const root = createCard(session, { parentId: null, title: '根' });
    deleteCard(session, root);

    const view = viewOf(session.state, emptyViewState(), root);
    assert.ok(view !== null, '软删不改变"卡是否存在"，viewOf 不该返回 null');
    assert.equal(view.id, root);
  });
});

test('窗口根卡还在、只是聚焦的卡被删了：退回根卡，仍然给得出视图', () => {
  withSession((session) => {
    const root = createCard(session, { parentId: null, title: '根' });
    const child = createCard(session, { parentId: root, title: '子' });

    deleteCard(session, child);

    const view = viewOf(session.state, emptyViewState(), root, child);
    assert.ok(view !== null, '根卡还在，窗口就有内容');
    assert.equal(view.id, root, '聚焦退回根卡');
  });
});

test('紧凑卡不会嵌进紧凑卡：子卡区只列直接子项（§3.3 像文件管理器）', () => {
  withSession((session) => {
    const root = createCard(session, { parentId: null, title: '根' });
    const mid = createCard(session, { parentId: root, title: '中' });
    createCard(session, { parentId: mid, title: '叶' });

    const card = mustView(session.state, emptyViewState(), root);

    assert.deepEqual(card.children.map((c) => c.id), [mid]);
    assert.equal(card.children[0]?.hasChildren, true, '有子卡要标出来，但不再展开');
  });
});

test('每个 layout 都能通过 type 分派到（防止新增 layout 忘了接）', () => {
  const all: Layout[] = ['tabs', 'columns', 'ordered', 'grid', 'plane', 'plain'];
  withSession((session) => {
    for (const layout of all) {
      // 走文档规定的路径：呈现定义卡（type 为空）+ 一张 type 指向它的卡。
      const template = createCard(session, { parentId: null, title: `模板-${layout}`, layout });
      const card = createCard(session, { parentId: null, title: `实例-${layout}`, type: template });

      assert.equal(rendererOf(session.state, card), layout);
    }
  });
});

