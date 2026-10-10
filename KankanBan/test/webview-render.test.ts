/**
 * 界面层的断言。
 *
 * 之前这一层是**零覆盖**的（Node 跑不了 `.tsx`），"UI 就绪"只能靠"编译过"支撑 ——
 * 而编译过不等于渲染对：三区域有没有真的摊开、board 有没有跨层投影、
 * 折叠有没有真的藏起来、面包屑是不是当前路径，这些都是 `viewOf` 的输出，
 * 但**由组件负责摊成 DOM**，所以只有渲染出来才能验。
 *
 * 现在有了 `test/tsx-hooks.mjs`，`react-dom/server` 能把组件渲染成 HTML 字符串，
 * 在命令行里逐条断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import '../src/node/bootstrap.ts';
import { viewOf, type CardView } from '../src/core/view-model.ts';
import { emptyViewState, setFocus, setRegionSize, type ViewState } from '../src/core/view-state.ts';
import { createCard, openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { CardWindow } from '../src/webview/CardWindow.tsx';
/** `viewOf` 现在可能返回 null（根卡没了）。这里测的场景里根卡一直在，所以断言非空。 */
function mustView(...args: Parameters<typeof viewOf>): CardView {
  const model = viewOf(...args);
  assert.ok(model !== null, 'viewOf 不该返回 null：这些场景里窗口根卡一直存在');
  return model;
}

function makeSession(): Session {
  let counter = 0;
  return openSession('/ui', {
      builtins: false,
    clientId: 'ui',
    ops: createMemoryFs().ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
  });
}

const noop = (): void => {};

function render(model: CardView, over: Partial<Parameters<typeof CardWindow>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(CardWindow, {
      model,
      onFocus: noop,
      onDropChild: noop,
      onContextMenu: noop,
      menu: null,
      onMenuPick: noop,
      onDismissMenu: noop,
      pendingDelete: null,
      onConfirmDelete: noop,
      onCancelDelete: noop,
      editing: null,
      onBeginEdit: noop,
      onCommitEdit: noop,
      onCancelEdit: noop,
      draggingId: null,
      onDragStart: noop,
      onDragEnd: noop,
      ...over,
    }),
  );
}

/**
 * 数一个 class **恰好**出现几次。
 *
 * 必须带上闭合引号：早先写成前缀匹配 `class="crumb`，
 * 结果把 `crumb-sep` 和 `crumb current` 一起算了进去（差一点就把错的断言放过去）。
 */
function countOf(html: string, className: string): number {
  return html.split(`class="${className}"`).length - 1;
}

// ── §3.1 三区域 ───────────────────────────────────────────────────────────────

test('三区域都渲染出来了', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根', content: '正文' });

  const html = render(mustView(session.state, emptyViewState(), root));

  assert.match(html, /class="card-window"/);
  assert.match(html, /class="region breadcrumb"/);
  assert.match(html, /class="region content"/);
  assert.match(html, /class="region children"/);
  assert.match(html, /正文/, 'plain 卡应当显示正文');
});

test('折叠的区域用 display:none 藏起来（§3.1 拖到零即折叠）', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根', content: '正文' });

  let view: ViewState = emptyViewState();
  view = setRegionSize(view, root, 'content', 0);

  const html = render(mustView(session.state, view, root));

  assert.match(html, /class="region content" style="display:none"/);
});

test('board 不显示正文：内容区带 hidden，且不出现正文文本（§3.1）', () => {
  const session = makeSession();
  const board = createCard(session, { id: '001', parentId: null, title: '看板', layout: 'columns', content: '不该出现的正文' });
  const col = createCard(session, { parentId: board, title: '待办', layout: 'ordered' });
  createCard(session, { parentId: col, title: '任务一' });

  const html = render(mustView(session.state, emptyViewState(), board));

  assert.match(html, /hidden=""/);
  assert.equal(html.includes('不该出现的正文'), false);
});

// ── §2.5.1 board 的跨一层投影 ─────────────────────────────────────────────────

test('board 渲染成列头 + 列内卡片，而不是把列卡当普通卡横排', () => {
  const session = makeSession();
  const board = createCard(session, { id: '001', parentId: null, title: '看板', layout: 'columns' });
  const todo = createCard(session, { parentId: board, title: '待办', layout: 'ordered' });
  const doing = createCard(session, { parentId: board, title: '进行中', layout: 'ordered' });
  createCard(session, { parentId: todo, title: '任务甲' });
  createCard(session, { parentId: doing, title: '任务乙' });

  const html = render(mustView(session.state, emptyViewState(), board));

  assert.equal(countOf(html, 'board-column'), 2, '两列');
  assert.match(html, /class="column-header"[^>]*>待办</);
  assert.match(html, /class="column-header"[^>]*>进行中</);
  assert.match(html, /任务甲/);
  assert.match(html, /任务乙/);
  // 列卡自己是紧凑卡吗？不是 —— board 视图里它们只当列头，不该出现在子卡横排里
  assert.equal(countOf(html, 'child-row'), 0);
});

test('列内卡片按 order 排列（不变量 O 的下游）', () => {
  const session = makeSession();
  const board = createCard(session, { id: '001', parentId: null, title: '看板', layout: 'columns' });
  const col = createCard(session, { parentId: board, title: '列', layout: 'ordered' });
  createCard(session, { parentId: col, title: '第一' });
  createCard(session, { parentId: col, title: '第二' });
  createCard(session, { parentId: col, title: '第三' });

  const html = render(mustView(session.state, emptyViewState(), board));

  const first = html.indexOf('第一');
  const second = html.indexOf('第二');
  const third = html.indexOf('第三');
  assert.ok(first >= 0 && first < second && second < third, `顺序不对：${first} ${second} ${third}`);
});

// ── §3.2 紧凑卡 ───────────────────────────────────────────────────────────────

test('子卡渲染成紧凑卡；有子卡的带下钻标记，没子卡的不带', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  const mid = createCard(session, { parentId: root, title: '中' });
  createCard(session, { parentId: mid, title: '叶' });
  createCard(session, { parentId: root, title: '光杆' });

  const html = render(mustView(session.state, emptyViewState(), root));

  assert.equal(countOf(html, 'compact-card'), 2);
  assert.equal(countOf(html, 'compact-more'), 1, '只有"中"有子卡');
});

test('正在拖的卡带 dragging 类', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '子' });

  const html = render(mustView(session.state, emptyViewState(), root), { draggingId: child });

  assert.equal(countOf(html, 'compact-card dragging'), 1);
});

// ── §3.4 面包屑 ───────────────────────────────────────────────────────────────

test('面包屑渲染成从根到聚焦卡的路径，当前项带 current 类', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  const mid = createCard(session, { parentId: root, title: '中' });
  const leaf = createCard(session, { parentId: mid, title: '叶' });

  let view: ViewState = emptyViewState();
  view = setFocus(view, root, leaf);

  const html = render(mustView(session.state, view, root));

  assert.equal(countOf(html, 'crumb') + countOf(html, 'crumb current'), 3, '三个层级各一个面包屑按钮');
  assert.equal(countOf(html, 'crumb current'), 1, '只有当前聚焦那一项带 current');
  const order = [html.indexOf('>根<'), html.indexOf('>中<'), html.indexOf('>叶<')];
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, `面包屑顺序不对：${order.join(',')}`);
});

// ── 落区：拖放的落点必须与子卡一一对应 ────────────────────────────────────────

test('每个子卡前面有一个落区，末尾还有一个（拖到最右）', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: 'A' });
  createCard(session, { parentId: root, title: 'B' });

  const html = render(mustView(session.state, emptyViewState(), root));

  assert.equal(countOf(html, 'drop-slot'), 2, '两张卡各一个前置落区');
  assert.equal(countOf(html, 'drop-slot tail'), 1, '末尾落区');
});
