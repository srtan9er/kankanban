/**
 * UI 里改呈现方式 —— §2.4.1 的 layout 从界面可达。
 *
 * 这条入口必须走 `setLayout` 而不是 `setField('/layout')`：后者已经在上一个文件里
 * 被证明会让子卡条目形状对不上、**下次打开工作区报数据损坏**。
 * 所以这里除了"能改"之外，还要断言**改完仍然能重新加载**。
 */

import './dom-setup.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import '../src/node/bootstrap.ts';
import { openWorkspace } from '../src/core/storage/workspace-io.ts';
import type { Layout, OrderedEntry } from '../src/core/types.ts';
import { emptyViewState } from '../src/core/view-state.ts';
import { createCard, openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { toAsync } from '../src/platform/async-fs-ops.ts';
import { createBufferedFs, type BufferedFs } from '../src/platform/buffered-fs-ops.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { WebviewApp, layoutMenuItems } from '../src/webview/WebviewApp.tsx';

type Mounted = { container: HTMLElement; unmount: () => void };

function mount(element: ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
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

function contextMenuAt(element: Element, x = 20, y = 20): void {
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

function makeApp(): { session: Session; buffered: BufferedFs; memory: ReturnType<typeof createMemoryFs> } {
  const memory = createMemoryFs();
  const buffered = createBufferedFs();
  let counter = 0;
  const session = openSession('/lm', {
    clientId: 'lm',
    ops: buffered.ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
    builtins: false,
  });
  return { session, buffered, memory };
}

/** 菜单里能选的呈现方式 —— **不含 `plane`**（见下一条测试）。 */
type MenuLayout = Exclude<Layout, 'plane' | 'library'>;

const LAYOUT_LABELS: Record<MenuLayout, string> = {
  plain: '正文 + 子卡横排',
  ordered: '横列',
  tabs: '标签页',
  columns: '看板',
  grid: '瀑布',
};

/**
 * 按**标签文本**点菜单项。
 *
 * 不要按下标：菜单里第一个 `.menu-item` 是"新建子卡"，之后才是"呈现方式"那一组，
 * 而下标表是从 `layoutMenuItems`（含分组标题）算的 —— 两者差一位，很容易写错。
 */
function clickMenuItemByLabel(container: HTMLElement, text: string): void {
  const target = queryAll(container, '.menu-item').find((el) => (el.textContent ?? '').includes(text));
  assert.ok(target !== undefined, `菜单里找不到「${text}」`);
  act(() => {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

// ── 菜单内容 ───────────────────────────────────────────────────────────────────

test('菜单里有"呈现方式"分组，并把当前那一项标出来', () => {
  const items = layoutMenuItems('ordered');

  assert.equal(items[0]?.heading, true);
  assert.equal(items[0]?.label, '呈现方式');
  assert.equal(items.length, 6, '一个标题 + 五个选项');

  const active = items.filter((item) => item.active === true);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, 'layout:ordered');
});

test('菜单里**没有** plane —— 改成平面需要坐标，界面还没有坐标级拖拽', () => {
  assert.equal(
    layoutMenuItems('plain').some((item) => item.id === 'layout:plane'),
    false,
  );
});

test('从右键菜单能改 layout，而且改完工作区仍然能加载', async () => {
  const { session, buffered, memory } = makeApp();
  const parent = createCard(session, { parentId: null, title: 'P' });
  const a = createCard(session, { parentId: parent, title: 'A' });
  const b = createCard(session, { parentId: parent, title: 'B' });

  const mounted = mount(
    createElement(WebviewApp, {
      session,
      buffered,
      backend: toAsync(createMemoryFs().ops),
      windowId: parent,
      initialView: emptyViewState(),
    }),
  );

  try {
    contextMenuAt(queryAll(mounted.container, '.card-window')[0] as Element);
    await settle();

    clickMenuItemByLabel(mounted.container, '横列');
    await settle();

    assert.equal(session.state.cards.get(parent)?.layout, 'ordered');
    assert.deepEqual(session.state.children.get(parent), [
      { id: a, order: 0 },
      { id: b, order: 1 },
    ] satisfies OrderedEntry[]);

    // 关键：从后端重开时能加载（裸改 layout 的旧毛病就是在这里炸的）
    await buffered.flushTo(toAsync(memory.ops));
    assert.doesNotThrow(() => openWorkspace('/lm', memory.ops));
  } finally {
    mounted.unmount();
  }
});

test('点当前已经在用的那一项不会产生多余事件', async () => {
  const { session, buffered } = makeApp();
  const parent = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });

  const mounted = mount(
    createElement(WebviewApp, {
      session,
      buffered,
      backend: toAsync(createMemoryFs().ops),
      windowId: parent,
      initialView: emptyViewState(),
    }),
  );

  try {
    const before = session.events.length;

    contextMenuAt(queryAll(mounted.container, '.card-window')[0] as Element);
    await settle();
    clickMenuItemByLabel(mounted.container, '横列');
    await settle();

    assert.equal(session.events.length, before, '没变就不该发事件');
  } finally {
    mounted.unmount();
  }
});

test('每个选项都能真的落到 core 上（逐个试一遍）', async () => {
  const choices: MenuLayout[] = ['plain', 'ordered', 'tabs', 'columns', 'grid'];

  for (const layout of choices) {
    const { session, buffered, memory } = makeApp();
    const parent = createCard(session, { parentId: null, title: 'P' });
    const child = createCard(session, { parentId: parent, title: 'A' });

    const mounted = mount(
      createElement(WebviewApp, {
        session,
        buffered,
        backend: toAsync(memory.ops),
        windowId: parent,
        initialView: emptyViewState(),
      }),
    );

    try {
      contextMenuAt(queryAll(mounted.container, '.card-window')[0] as Element);
      await settle();

      clickMenuItemByLabel(mounted.container, LAYOUT_LABELS[layout]);
      await settle();

      assert.equal(session.state.cards.get(parent)?.layout, layout, `${layout} 应当生效`);
      const expected = layout === 'plain' ? [{ id: child }] : [{ id: child, order: 0 }];
      assert.deepEqual(session.state.children.get(parent), expected, `${layout} 必须连同子卡条目形状一起修改`);
      await buffered.flushTo(toAsync(memory.ops));
      const reopened = openWorkspace('/lm', memory.ops);
      assert.equal(reopened.state.cards.get(parent)?.layout, layout, `${layout} 必须保存到后端`);
      assert.deepEqual(reopened.state.children.get(parent), expected);
    } finally {
      mounted.unmount();
    }
  }
});
