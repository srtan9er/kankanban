/**
 * §3.6 预制体视觉区分：**预制体卡片内部发蓝光；由预制体实例化的卡片外圈发蓝光。**
 *
 * 这条写得很死，而 `isPrefab` / `prefabRef` 两个字段从阶段一就在 —— 只是一直没有消费者。
 * 发光标记由 `viewOf` 算出（和折叠、正文可见性、子卡排布一样），渲染层只负责套类名。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import '../src/node/bootstrap.ts';
import { glowOf, viewOf, type CardView } from '../src/core/view-model.ts';
import { emptyViewState } from '../src/core/view-state.ts';
import { createCard, openSession, setField } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { CardWindow } from '../src/webview/CardWindow.tsx';

const noop = (): void => {};

function makeSession(): Session {
  let counter = 0;
  return openSession('/g', {
    clientId: 'g',
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

/** 从 HTML 里数一个 class **恰好**出现的次数（带闭合引号，免得前缀误伤）。 */
function countOf(html: string, className: string): number {
  return html.split(`class="${className}"`).length - 1;
}

// ── glowOf ─────────────────────────────────────────────────────────────────────

test('普通卡不发任何光', () => {
  assert.equal(glowOf({ isPrefab: false, prefabRef: null }), null);
});

test('预制体内部发光、实例外圈发光', () => {
  assert.equal(glowOf({ isPrefab: true, prefabRef: null }), 'prefab');
  assert.equal(glowOf({ isPrefab: false, prefabRef: 'p1' }), 'instance');
});

test('既是预制体又是实例时按预制体算（内发光是更强的身份）', () => {
  assert.equal(glowOf({ isPrefab: true, prefabRef: 'p1' }), 'prefab');
});

// ── viewOf 把标记带出来 ────────────────────────────────────────────────────────

test('viewOf：聚焦卡自己的 glow', () => {
  const session = makeSession();
  const prefab = createCard(session, { id: '003', parentId: null, title: 'prefabs', layout: 'grid' });
  createCard(session, { parentId: prefab, title: '血量条', isPrefab: true });

  const plain = createCard(session, { parentId: null, title: '普通' });

  assert.equal(mustView(session.state, emptyViewState(), plain).glow, null);
});

test('viewOf：子卡的 glow 逐个算对', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: '普通子卡' });
  const prefab = createCard(session, { parentId: root, title: '预制体', isPrefab: true });
  const instance = createCard(session, { parentId: root, title: '实例' });
  setField(session, instance, '/prefabRef', prefab);

  const model = mustView(session.state, emptyViewState(), root);

  assert.deepEqual(
    model.children.map((child) => [child.title, child.glow]),
    [
      ['普通子卡', null],
      ['预制体', 'prefab'],
      ['实例', 'instance'],
    ],
  );
});

// ── 渲染层套上类名 ─────────────────────────────────────────────────────────────

test('普通的子卡不带发光类名', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: '普通' });

  const html = render(mustView(session.state, emptyViewState(), root));

  assert.equal(countOf(html, 'compact-card'), 1);
  assert.equal(countOf(html, 'compact-card glow-prefab'), 0);
  assert.equal(countOf(html, 'compact-card glow-instance'), 0);
  assert.match(html, /data-glow="none"/);
});

test('预制体子卡带 glow-prefab（内部发光）', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: '血量条', isPrefab: true });

  const html = render(mustView(session.state, emptyViewState(), root));

  assert.match(html, /class="compact-card glow-prefab"/);
  assert.match(html, /data-glow="prefab"/);
});

test('实例子卡带 glow-instance（外圈发光）', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  const prefab = createCard(session, { parentId: root, title: '预制体', isPrefab: true });
  const instance = createCard(session, { parentId: root, title: '实例' });
  setField(session, instance, '/prefabRef', prefab);

  const html = render(mustView(session.state, emptyViewState(), root));

  assert.equal(countOf(html, 'compact-card glow-prefab'), 1, '预制体那个');
  assert.equal(countOf(html, 'compact-card glow-instance'), 1, '实例那个');
});

test('聚焦到预制体本身上时，窗口容器也带内发光', () => {
  const session = makeSession();
  const prefab = createCard(session, { parentId: null, title: '预制体', isPrefab: true });

  const html = render(mustView(session.state, emptyViewState(), prefab));

  assert.match(html, /class="card-window glow-prefab"/);
  assert.match(html, /data-glow="prefab"/);
});

test('发光与其它类名共存（拖拽中 + 发光的卡两类都在）', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  const prefab = createCard(session, { parentId: root, title: '预制体', isPrefab: true });

  const model = mustView(session.state, emptyViewState(), root);
  const html = renderToStaticMarkup(
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
      draggingId: prefab,
      onDragStart: noop,
      onDragEnd: noop,
    }),
  );

  assert.match(html, /class="compact-card glow-prefab dragging"/);
});
