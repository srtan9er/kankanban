/**
 * 浮层的两个边界：菜单**位置钳制**与 **Escape 关闭**。
 *
 * 位置钳制做成纯函数就是为了能在这里逐条断言 —— jsdom 里 `getBoundingClientRect`
 * 全返回 0，靠渲染后测量是测不出东西的。
 */

import './dom-setup.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import '../src/node/bootstrap.ts';
import { emptyViewState } from '../src/core/view-state.ts';
import { createCard, ensureBuiltins, openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { toAsync } from '../src/platform/async-fs-ops.ts';
import { createBufferedFs, type BufferedFs } from '../src/platform/buffered-fs-ops.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { WebviewApp } from '../src/webview/WebviewApp.tsx';
import {
  MENU_CHROME_HEIGHT,
  MENU_ITEM_HEIGHT,
  MENU_MIN_WIDTH,
  clampMenuPosition,
  estimateMenuSize,
  isClamped,
} from '../src/webview/menu-position.ts';

// ── 纯函数部分 ─────────────────────────────────────────────────────────────────

test('菜单尺寸按条目数估', () => {
  assert.deepEqual(estimateMenuSize(1), { width: MENU_MIN_WIDTH, height: MENU_CHROME_HEIGHT + MENU_ITEM_HEIGHT });
  assert.deepEqual(estimateMenuSize(2), {
    width: MENU_MIN_WIDTH,
    height: MENU_CHROME_HEIGHT + 2 * MENU_ITEM_HEIGHT,
  });
  // 条目数为 0 也按 1 条算，免得估出"零高度"这种没意义的东西
  assert.equal(estimateMenuSize(0).height, MENU_CHROME_HEIGHT + MENU_ITEM_HEIGHT);
});

test('菜单在视口中间时位置不动', () => {
  const pointer = { x: 100, y: 80 };
  const size = { width: 140, height: 60 };

  assert.deepEqual(clampMenuPosition(pointer, size, { width: 1000, height: 800 }), pointer);
  assert.equal(isClamped(pointer, size, { width: 1000, height: 800 }), false);
});

test('点在右下角时菜单被收回视口内（否则条目够不到）', () => {
  const size = { width: 140, height: 60 };

  const position = clampMenuPosition({ x: 990, y: 790 }, size, { width: 1000, height: 800 });

  assert.deepEqual(position, { x: 860, y: 740 });
  assert.equal(isClamped({ x: 990, y: 790 }, size, { width: 1000, height: 800 }), true);
  // 关键性质：整块菜单都在视口内
  assert.ok(position.x + size.width <= 1000);
  assert.ok(position.y + size.height <= 800);
});

test('指针坐标是负数时归零（多屏/缩放下的防御）', () => {
  assert.deepEqual(
    clampMenuPosition({ x: -20, y: -5 }, { width: 140, height: 60 }, { width: 1000, height: 800 }),
    { x: 0, y: 0 },
  );
});

test('视口比菜单还小时归零，而不是给出负数', () => {
  const position = clampMenuPosition({ x: 50, y: 50 }, { width: 140, height: 60 }, { width: 100, height: 40 });

  assert.deepEqual(position, { x: 0, y: 0 });
});

// ── 接进界面 ───────────────────────────────────────────────────────────────────

type Mounted = { container: HTMLElement; unmount: () => void };

function mount(element: ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function queryAll(container: HTMLElement, selector: string): Element[] {
  return [...container.querySelectorAll(selector)];
}

function contextMenuAt(element: Element, x: number, y: number): void {
  act(() => {
    element.dispatchEvent(
      new window.MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true, cancelable: true }),
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

function makeApp(): { session: Session; buffered: BufferedFs } {
  const buffered = createBufferedFs();
  let counter = 0;
  const session = openSession('/o', {
    clientId: 'o',
    ops: buffered.ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
    builtins: false,
  });
  return { session, buffered };
}

function mountApp(session: Session, buffered: BufferedFs, windowId: string): Mounted {
  return mount(
    createElement(WebviewApp, {
      session,
      buffered,
      backend: toAsync(createMemoryFs().ops),
      windowId,
      initialView: emptyViewState(),
    }),
  );
}

test('右下角右键：菜单的 left/top 被夹进视口', async () => {
  const { session, buffered } = makeApp();
  ensureBuiltins(session);
  const root = createCard(session, { parentId: null, title: '根' });

  const mounted = mountApp(session, buffered, root);

  try {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    contextMenuAt(queryAll(mounted.container, '.card-window')[0] as Element, viewport.width + 50, viewport.height + 50);
    await settle();

    const menu = queryAll(mounted.container, '.context-menu')[0] as HTMLElement | undefined;
    assert.ok(menu !== undefined, '菜单应当出现');
    const left = Number.parseFloat(menu.style.left);
    const top = Number.parseFloat(menu.style.top);

    assert.ok(left >= 0 && left <= viewport.width, `left=${left} 应当在视口内`);
    assert.ok(top >= 0 && top <= viewport.height, `top=${top} 应当在视口内`);
    // 而且是"往回收"而不是贴边到 0
    assert.ok(left > 0, '不应当被夹到左上角');
  } finally {
    mounted.unmount();
  }
});

test('Escape 关掉右键菜单', async () => {
  const { session, buffered } = makeApp();
  ensureBuiltins(session);
  const root = createCard(session, { parentId: null, title: '根' });

  const mounted = mountApp(session, buffered, root);

  try {
    contextMenuAt(queryAll(mounted.container, '.card-window')[0] as Element, 20, 20);
    await settle();
    assert.equal(queryAll(mounted.container, '.context-menu').length, 1);

    pressEscape();
    await settle();

    assert.equal(queryAll(mounted.container, '.context-menu').length, 0);
  } finally {
    mounted.unmount();
  }
});

test('Escape 关掉删除确认框，并且不会顺手把卡删掉', async () => {
  const { session, buffered } = makeApp();
  ensureBuiltins(session);
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '要删的' });

  const mounted = mountApp(session, buffered, root);

  try {
    // 对子卡开菜单 —— 内置卡没有"删除"项，普通子卡才有
    contextMenuAt(queryAll(mounted.container, '.compact-card')[0] as Element, 20, 20);
    await settle();

    const danger = queryAll(mounted.container, '.menu-item.danger')[0] as Element | undefined;
    assert.ok(danger !== undefined, '普通卡应当有"删除"项');
    act(() => {
      danger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();

    assert.equal(queryAll(mounted.container, '.confirm-box').length, 1, '确认框应当出现');

    pressEscape();
    await settle();

    assert.equal(queryAll(mounted.container, '.confirm-box').length, 0, 'Escape 应当关掉确认框');
    assert.equal(session.state.cards.get(child)?.deleted, false, 'Escape 绝不该顺手把卡删了');
  } finally {
    mounted.unmount();
  }
});

test('Escape 关掉内联编辑（等于取消）', async () => {
  const { session, buffered } = makeApp();
  ensureBuiltins(session);
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: '子卡' });

  const mounted = mountApp(session, buffered, root);

  try {
    act(() => {
      (queryAll(mounted.container, '.compact-card')[0] as Element).dispatchEvent(
        new window.MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    assert.equal(queryAll(mounted.container, '.title-input').length, 1, '单击应当进入编辑');

    pressEscape();
    await settle();

    assert.equal(queryAll(mounted.container, '.title-input').length, 0, 'Escape 应当退出编辑');
  } finally {
    mounted.unmount();
  }
});
