/**
 * §3.1 的子卡区三种排布（底部横排 / 格子 / 二维无限），以及坐标型父卡的**同父重排**。
 *
 * 后者是实现这轮时撞出来的一个真问题：`PlaneEntry` 带 x/y/w/h，而 `moveCard` 一直在
 * 无条件地要求"移到 plane 父卡下必须给坐标" —— 可是**同父重排本来就不改坐标**，
 * 症状是"在灵感台里拖一下卡片就报缺坐标"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import '../src/node/bootstrap.ts';
import { moveCard, createCard, openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { childrenModeOf, viewOf, type CardView } from '../src/core/view-model.ts';
import { emptyViewState } from '../src/core/view-state.ts';
import type { Layout, PlaneEntry } from '../src/core/types.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { CardWindow } from '../src/webview/CardWindow.tsx';

const noop = (): void => {};

function makeSession(): Session {
  let counter = 0;
  return openSession('/p', {
    clientId: 'p',
    ops: createMemoryFs().ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
    builtins: false,
  });
}

function mustView(...args: Parameters<typeof viewOf>): CardView {
  const model = viewOf(...args);
  assert.ok(model !== null, 'viewOf 不该返回 null：这些场景里窗口根卡一直存在');
  return model;
}

function render(model: CardView): string {
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
    }),
  );
}

// ── childrenModeOf ─────────────────────────────────────────────────────────────

test('子卡区排布由渲染器推出：grid → 格子、plane → 二维无限、其余 → 横排', () => {
  assert.equal(childrenModeOf('grid'), 'grid');
  assert.equal(childrenModeOf('plane'), 'plane');

  for (const layout of ['plain', 'ordered', 'tabs', 'columns'] satisfies Layout[]) {
    assert.equal(childrenModeOf(layout), 'row', `${layout} 应当是横排`);
  }
});

test('viewOf 把 childrenMode 带出来（prefabs 格子、inspiration 二维）', () => {
  const session = makeSession();
  const grid = createCard(session, { id: '003', parentId: null, title: 'prefabs', layout: 'grid' });
  const plane = createCard(session, { id: '002', parentId: null, title: 'inspiration', layout: 'plane' });
  const plain = createCard(session, { parentId: null, title: '普通' });

  assert.equal(mustView(session.state, emptyViewState(), grid).childrenMode, 'grid');
  assert.equal(mustView(session.state, emptyViewState(), plane).childrenMode, 'plane');
  assert.equal(mustView(session.state, emptyViewState(), plain).childrenMode, 'row');
});

// ── 渲染出三种容器 ─────────────────────────────────────────────────────────────

test('横排用 .child-row（旧行为不变）', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: '子' });

  const html = render(mustView(session.state, emptyViewState(), root));

  assert.match(html, /class="child-row"/);
  assert.equal(html.includes('child-grid'), false);
  assert.equal(html.includes('child-plane'), false);
});

test('格子用 .child-grid', () => {
  const session = makeSession();
  const grid = createCard(session, { id: '003', parentId: null, title: 'prefabs', layout: 'grid' });
  createCard(session, { parentId: grid, title: '预制体一' });

  const html = render(mustView(session.state, emptyViewState(), grid));

  assert.match(html, /class="child-grid"/);
  assert.equal(html.includes('child-row'), false);
});

test('二维无限平面：每张卡按自己的 x/y/w/h/z 绝对定位', () => {
  const session = makeSession();
  const plane = createCard(session, { id: '002', parentId: null, title: 'inspiration', layout: 'plane' });
  createCard(session, {
    parentId: plane,
    title: '灵感一',
    plane: { x: 24, y: 36, w: 140, h: 90, z: 3 },
  });

  const html = render(mustView(session.state, emptyViewState(), plane));

  assert.match(html, /class="child-plane"/);
  const slot = /<div class="plane-slot" style="([^"]*)"/.exec(html);
  assert.ok(slot !== null, '应当渲染出定位槽');
  const style = slot[1] ?? '';
  for (const piece of ['left:24px', 'top:36px', 'width:140px', 'height:90px', 'z-index:3']) {
    assert.ok(style.includes(piece), `定位样式里应当有 ${piece}，实际是 ${style}`);
  }
});

// ── 坐标型父卡的同父重排 ───────────────────────────────────────────────────────

test('在 plane 父卡里同父重排：不改坐标，也不要求传坐标', () => {
  const session = makeSession();
  const plane = createCard(session, { id: '002', parentId: null, title: 'inspiration', layout: 'plane' });
  const a = createCard(session, { parentId: plane, title: 'A', plane: { x: 10, y: 10, w: 100, h: 60, z: 1 } });
  const b = createCard(session, { parentId: plane, title: 'B', plane: { x: 200, y: 40, w: 120, h: 80, z: 2 } });

  // 关键：不传 plane placement，也应当能重排
  assert.doesNotThrow(() => moveCard(session, a, plane, 1));

  const entries = session.state.children.get(plane) as PlaneEntry[];
  assert.deepEqual(entries.map((e) => e.id), [b, a], '顺序换了');
  assert.deepEqual(
    entries.map((e) => [e.x, e.y, e.w, e.h, e.z]),
    [
      [200, 40, 120, 80, 2],
      [10, 10, 100, 60, 1],
    ],
    '坐标一个都不该变 —— 同父重排只改数组位置',
  );
});

test('从别处移进 plane 父卡则必须给坐标（编一个默认值会让卡跑到没放的地方）', () => {
  const session = makeSession();
  const plane = createCard(session, { id: '002', parentId: null, title: 'inspiration', layout: 'plane' });
  const loose = createCard(session, { parentId: null, title: '散卡' });

  assert.throws(() => moveCard(session, loose, plane, 0), /需要坐标|plane placement/);

  // 给了坐标就行
  assert.doesNotThrow(() => moveCard(session, loose, plane, 0, { x: 5, y: 6, w: 100, h: 60, z: 1 }));
  const entries = session.state.children.get(plane) as PlaneEntry[];
  assert.deepEqual([entries[0]?.x, entries[0]?.y], [5, 6]);
});

test('顺序型父卡的同父重排照旧（这条路径没被上一处改动带坏）', () => {
  const session = makeSession();
  const parent = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
  const a = createCard(session, { parentId: parent, title: 'A' });
  const b = createCard(session, { parentId: parent, title: 'B' });

  moveCard(session, a, parent, 1);

  assert.deepEqual((session.state.children.get(parent) ?? []).map((e) => e.id), [b, a]);
});
