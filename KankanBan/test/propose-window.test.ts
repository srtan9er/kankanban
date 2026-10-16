/**
 * 「提出到屏幕窗口」+「关闭窗口不改结构 + 可从 main 重新打开」的**端到端断言**。
 *
 * 这是用户这一轮提的那件事的验收标准，逐条对上原话：
 *   1. 右键一张子卡 → 菜单里有「提出到屏幕窗口」
 *   2. 点了之后 → 它**真的**变成桌面卡片（`parent === null`），而且**开了窗口**
 *      （窗口集合落在 `view-state.json` 的 `openWindows` 里 —— 真窗口由写者对账后由 Rust 开）
 *   3. 关掉它的窗口 → **树一字未动**，卡片还在
 *   4. 从 main 顶部的「桌面卡片」条点一下 → 窗口回来了
 *
 * 真窗口是真的开不出来（jsdom 里没有 Tauri），所以第 2 步验的是**模型侧**的"该开窗"：
 * `syncCardWindows` 在非 Tauri 环境下是空操作，这让这条断言可以在命令行里跑完。
 */

import './dom-setup.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import '../src/node/bootstrap.ts';
import { stableStringify } from '../src/core/subtree.ts';
import { openWindowsOf, readViewState, emptyViewState, windowViewFor } from '../src/core/view-state.ts';
import { desktopCards } from '../src/core/windows.ts';
import { parentIndexOf } from '../src/core/indexes.ts';
import { wantedCardWindows } from '../src/webview/window-sync.ts';
import { createCard, openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { toAsync } from '../src/platform/async-fs-ops.ts';
import { createBufferedFs, type BufferedFs } from '../src/platform/buffered-fs-ops.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { WebviewApp } from '../src/webview/WebviewApp.tsx';

type Fixture = {
  session: Session;
  buffered: BufferedFs;
  container: HTMLElement;
  unmount: () => void;
};

/** 一棵最小的树：容器（本窗口的根） + 一张子卡 —— 子卡就是待「提出」的那张。 */
function fixture(): Fixture {
  const buffered = createBufferedFs();
  let counter = 0;
  const session = openSession('/app', {
    builtins: false,
    clientId: 'ui',
    ops: buffered.ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
  });
  const rootId = createCard(session, { parentId: null, title: '容器' });
  createCard(session, { parentId: rootId, title: '要提出的卡' });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const reactRoot: Root = createRoot(container);
  act(() => {
    reactRoot.render(
      createElement(WebviewApp, {
        session,
        buffered,
        backend: toAsync(createMemoryFs().ops),
        windowId: rootId,
        initialView: emptyViewState(),
      }),
    );
  });

  return {
    session,
    buffered,
    container,
    unmount: () => {
      act(() => reactRoot.unmount());
      container.remove();
    },
  };
}

function queryAll(container: HTMLElement, selector: string): Element[] {
  return [...container.querySelectorAll(selector)];
}

function fire(target: Element, type: string): void {
  act(() => {
    target.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  });
}

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** 树的快照：用来断言"关窗一个字都没改"。 */
function treeSnapshot(session: Session): string {
  const byId = (a: readonly [string, unknown], b: readonly [string, unknown]): number =>
    a[0] < b[0] ? -1 : 1;
  return stableStringify({
    cards: [...session.state.cards.entries()].sort(byId),
    children: [...session.state.children.entries()]
      .map(([id, list]) => [id, list] as const)
      .sort(byId),
    events: session.events.length,
  });
}

/** 打开子卡的右键菜单，返回菜单条目文案。 */
function openChildMenu(mounted: Fixture): string[] {
  fire(queryAll(mounted.container, '.compact-card')[0] as Element, 'contextmenu');
  return queryAll(mounted.container, '.menu-item').map((el) => el.textContent ?? '');
}

function clickMenuItem(mounted: Fixture, label: string): void {
  const item = queryAll(mounted.container, '.menu-item').find((el) => el.textContent === label);
  assert.ok(item !== undefined, `菜单里应当有「${label}」`);
  click(item);
}

test('右键子卡 → 菜单里有「提出到屏幕窗口」', () => {
  const mounted = fixture();
  try {
    assert.ok(
      openChildMenu(mounted).includes('提出到屏幕窗口'),
      '菜单里必须有这一项（这就是这一轮要的功能入口）',
    );
  } finally {
    mounted.unmount();
  }
});

test('本窗口正在显示的那张卡不给这一项 —— 它已经在屏幕上了', () => {
  const mounted = fixture();
  try {
    // 落在窗口空白处 → 菜单针对**当前聚焦的卡**（= 本窗口的根卡）
    fire(queryAll(mounted.container, '.card-window')[0] as Element, 'contextmenu');
    const labels = queryAll(mounted.container, '.menu-item').map((el) => el.textContent ?? '');

    assert.ok(!labels.includes('提出到屏幕窗口'), '否则同一张卡会同时出现在 main 和一扇卡片窗口里');
  } finally {
    mounted.unmount();
  }
});

test('点「提出到屏幕窗口」→ 卡变桌面卡片，并且真的进了 openWindows', async () => {
  const mounted = fixture();
  try {
    assert.deepEqual(desktopCards(mounted.session.state), ['c1'], '一开始只有容器那张是桌面卡片');

    openChildMenu(mounted);
    clickMenuItem(mounted, '提出到屏幕窗口');
    await settle();

    const roots = desktopCards(mounted.session.state);
    assert.deepEqual(roots, ['c1', 'c2'], '子卡被摘出来，成了桌面卡片');

    // 窗口集合落在 view-state.json 里（真窗口由写者交给 Rust 对账）
    const view = readViewState('/app', mounted.buffered.ops);
    assert.deepEqual(openWindowsOf(view), ['c2'], '提出 = 改树 + 开窗，一步做完');

    // main 顶部的「桌面卡片」条应当把这张卡列出来，并标成"开着"
    const chips = queryAll(mounted.container, '.desktop-chip');
    assert.deepEqual(
      chips.map((el) => el.textContent),
      ['要提出的卡'],
    );
    assert.ok(chips[0]?.classList.contains('is-open'), '它现在有窗口，应当标成打开态');
  } finally {
    mounted.unmount();
  }
});

test('关掉卡片窗口 → 树一字未动，卡片还在，只是没窗口了', async () => {
  const mounted = fixture();
  try {
    openChildMenu(mounted);
    clickMenuItem(mounted, '提出到屏幕窗口');
    await settle();

    const before = treeSnapshot(mounted.session);

    click(queryAll(mounted.container, '.desktop-chip')[0] as Element);
    await settle();

    assert.equal(treeSnapshot(mounted.session), before, '关窗不许碰卡片字段、children、也不许产生事件');
    assert.deepEqual(desktopCards(mounted.session.state), ['c1', 'c2'], '卡还在桌面卡片里');
    assert.deepEqual(openWindowsOf(readViewState('/app', mounted.buffered.ops)), [], '只是没有窗口了');
    assert.ok(
      !(queryAll(mounted.container, '.desktop-chip')[0] as Element).classList.contains('is-open'),
      '状态条上应当变成"没开"',
    );
  } finally {
    mounted.unmount();
  }
});

test('从 main 的桌面卡片条点一下 → 窗口回来了（用户要的"可以重新打开"）', async () => {
  const mounted = fixture();
  try {
    openChildMenu(mounted);
    clickMenuItem(mounted, '提出到屏幕窗口');
    await settle();
    click(queryAll(mounted.container, '.desktop-chip')[0] as Element); // 关掉
    await settle();

    click(queryAll(mounted.container, '.desktop-chip')[0] as Element); // 再打开
    await settle();

    assert.deepEqual(openWindowsOf(readViewState('/app', mounted.buffered.ops)), ['c2']);
    assert.ok((queryAll(mounted.container, '.desktop-chip')[0] as Element).classList.contains('is-open'));
  } finally {
    mounted.unmount();
  }
});

test('撤销「提出」只恢复树上归属，仍存活子卡的独立窗口继续保留', async () => {
  const mounted = fixture();
  try {
    openChildMenu(mounted);
    clickMenuItem(mounted, '提出到屏幕窗口');
    await settle();
    assert.deepEqual(openWindowsOf(readViewState('/app', mounted.buffered.ops)), ['c2']);

    click(queryAll(mounted.container, '.undo-button')[0] as Element);
    await settle();

    assert.deepEqual(desktopCards(mounted.session.state), ['c1'], '树撤回去了');
    assert.equal(parentIndexOf(mounted.session.state).get('c2'), 'c1');
    assert.equal(mounted.session.state.cards.get('c2')?.deleted, false);
    const restoredView = readViewState('/app', mounted.buffered.ops);
    assert.deepEqual(
      openWindowsOf(restoredView),
      ['c2'],
      '独立窗口的存在不依赖卡片是否位于树上根级',
    );
    assert.equal(windowViewFor(restoredView, 'c2').focusId, 'c2');
    assert.deepEqual(wantedCardWindows(mounted.session.state, restoredView.openWindows, 'c1'), ['c2'], '原生窗口对账也必须继续保留这张子卡的窗口');
    assert.equal(queryAll(mounted.container, '.desktop-chip').length, 0, '根卡导航隐藏回到树下的子卡，但不等于关闭它的独立窗口');
  } finally {
    mounted.unmount();
  }
});
