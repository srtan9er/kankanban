/**
 * 交互断言 —— 阶段一·五那四件事里，"拖拽子卡"与"下钻"到这一层才算真的验过。
 *
 * 上一轮的渲染测试只覆盖**静态 HTML**：它能证明三区域摊开了、列头对了，
 * 但证明不了"点一下会发生什么"。这里用 jsdom + `react-dom/client` 派发真事件，
 * 把回调链路一直验到 core 的状态变化。
 */

import './dom-setup.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import '../src/node/bootstrap.ts';
import { viewOf, type CardView } from '../src/core/view-model.ts';
import { openWorkspace } from '../src/core/storage/workspace-io.ts';
import { emptyViewState } from '../src/core/view-state.ts';
import { createCard, ensureBuiltins, openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createBufferedFs, type BufferedFs } from '../src/platform/buffered-fs-ops.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { toAsync } from '../src/platform/async-fs-ops.ts';
import { CardWindow } from '../src/webview/CardWindow.tsx';
import { WebviewApp } from '../src/webview/WebviewApp.tsx';
/** `viewOf` 现在可能返回 null（根卡没了）。这里测的场景里根卡一直在，所以断言非空。 */
function mustView(...args: Parameters<typeof viewOf>): CardView {
  const model = viewOf(...args);
  assert.ok(model !== null, 'viewOf 不该返回 null：这些场景里窗口根卡一直存在');
  return model;
}

// ── 夹具 ───────────────────────────────────────────────────────────────────────

type Mounted = { container: HTMLElement; root: Root; unmount: () => void };

function mount(element: ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
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

/** 双击要发两次 click —— React 的 onDoubleClick 靠 detail 计数。 */
function doubleClick(target: Element): void {
  act(() => {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
    target.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
}

function queryAll(container: HTMLElement, selector: string): Element[] {
  return [...container.querySelectorAll(selector)];
}

/**
 * 等异步副作用落定。
 *
 * `WebviewApp` 的手势处理里有一句 `void persist()`（刷盘），刷完之后才 `setStatus`。
 * 不把它等掉的话，React 会警告"更新没包在 act 里"，更要紧的是
 * **断言会与那次状态更新赛跑** —— 测试就可能时绿时红。
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
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

// ── CardWindow 的回调接线 ─────────────────────────────────────────────────────

test('点面包屑 → 回调拿到那一层的 id', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  const mid = createCard(session, { parentId: root, title: '中' });

  const seen: string[] = [];
  const view = mustView(session.state, emptyViewState(), root, mid);
  const mounted = mount(
    createElement(CardWindow, {
      model: view,
      onFocus: (id: string) => seen.push(id),
      onDropChild: () => {},
            onContextMenu: () => {},
      menu: null,
      onMenuPick: () => {},
      onDismissMenu: () => {},
      pendingDelete: null,
      onConfirmDelete: () => {},
      onCancelDelete: () => {},
      editing: null,
      onBeginEdit: () => {},
      onCommitEdit: () => {},
      onCancelEdit: () => {},
      draggingId: null,
      onDragStart: () => {},
      onDragEnd: () => {},
    }),
  );

  try {
    const crumbs = queryAll(mounted.container, '.crumb');
    assert.equal(crumbs.length, 2);
    click(crumbs[0] as Element);

    assert.deepEqual(seen, [root], '点第一层面包屑应当聚焦回根卡');
  } finally {
    mounted.unmount();
  }
});

test('双击紧凑卡 → 下钻到那张卡', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '子' });

  const seen: string[] = [];
  const mounted = mount(
    createElement(CardWindow, {
      model: mustView(session.state, emptyViewState(), root),
      onFocus: (id: string) => seen.push(id),
      onDropChild: () => {},
            onContextMenu: () => {},
      menu: null,
      onMenuPick: () => {},
      onDismissMenu: () => {},
      pendingDelete: null,
      onConfirmDelete: () => {},
      onCancelDelete: () => {},
      editing: null,
      onBeginEdit: () => {},
      onCommitEdit: () => {},
      onCancelEdit: () => {},
      draggingId: null,
      onDragStart: () => {},
      onDragEnd: () => {},
    }),
  );

  try {
    const card = queryAll(mounted.container, '.compact-card')[0] as Element;
    doubleClick(card);

    assert.deepEqual(seen, [child]);
  } finally {
    mounted.unmount();
  }
});

test('拖起再落到落区 → 回调拿到(被拖的卡, 落点下标)', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: 'A' });
  const b = createCard(session, { parentId: root, title: 'B' });

  const seen: Array<[string, number]> = [];
  let dragging: string | null = null;

  /**
   * 必须用真 state。
   * 第一版把它写成普通变量，`dragstart` 改了它但**不触发重渲染**，
   * 于是落下时组件看到的仍是 `draggingId: null`（守卫正确地拒绝了）——
   * 测试红得没错，但红在夹具上。
   */
  function Harness(): ReactElement {
    const [current, setCurrent] = useState<string | null>(null);
    dragging = current;
    return createElement(CardWindow, {
      model: mustView(session.state, emptyViewState(), root),
      onFocus: () => {},
      onDropChild: (cardId: string, index: number) => seen.push([cardId, index]),
            onContextMenu: () => {},
      menu: null,
      onMenuPick: () => {},
      onDismissMenu: () => {},
      pendingDelete: null,
      onConfirmDelete: () => {},
      onCancelDelete: () => {},
      editing: null,
      onBeginEdit: () => {},
      onCommitEdit: () => {},
      onCancelEdit: () => {},
      draggingId: current,
      onDragStart: setCurrent,
      onDragEnd: () => setCurrent(null),
    });
  }

  const mounted = mount(createElement(Harness));

  try {
    const cards = queryAll(mounted.container, '.compact-card');
    assert.equal(cards.length, 2);

    fire(cards[1] as Element, 'dragstart');
    assert.equal(dragging, b, '拖起之后组件应当知道拖的是哪张');

    // 第一个落区 = 插到第 0 位
    const slots = queryAll(mounted.container, '.drop-slot');
    fire(slots[0] as Element, 'drop');

    assert.deepEqual(seen, [[b, 0]]);
  } finally {
    mounted.unmount();
  }
});

test('空放（没有正在拖的卡）不产生任何回调 —— 否则会白写一条事件', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: 'A' });

  let calls = 0;
  const mounted = mount(
    createElement(CardWindow, {
      model: mustView(session.state, emptyViewState(), root),
      onFocus: () => {},
      onDropChild: () => {
        calls += 1;
      },
            onContextMenu: () => {},
      menu: null,
      onMenuPick: () => {},
      onDismissMenu: () => {},
      pendingDelete: null,
      onConfirmDelete: () => {},
      onCancelDelete: () => {},
      editing: null,
      onBeginEdit: () => {},
      onCommitEdit: () => {},
      onCancelEdit: () => {},
      draggingId: null,
      onDragStart: () => {},
      onDragEnd: () => {},
    }),
  );

  try {
    const slots = queryAll(mounted.container, '.drop-slot');
    fire(slots[0] as Element, 'drop');
    fire(queryAll(mounted.container, '.drop-slot.tail')[0] as Element, 'drop');

    assert.equal(calls, 0);
  } finally {
    mounted.unmount();
  }
});

test('右键落在空白处 → 请求为**当前聚焦的卡**开菜单', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });

  const asked: Array<{ cardId: string; x: number; y: number }> = [];
  const mounted = mount(
    createElement(CardWindow, {
      model: mustView(session.state, emptyViewState(), root),
      onFocus: () => {},
      onDropChild: () => {},
      onContextMenu: (cardId: string, x: number, y: number) => asked.push({ cardId, x, y }),
      menu: null,
      onMenuPick: () => {},
      onDismissMenu: () => {},
      pendingDelete: null,
      onConfirmDelete: () => {},
      onCancelDelete: () => {},
      editing: null,
      onBeginEdit: () => {},
      onCommitEdit: () => {},
      onCancelEdit: () => {},
      draggingId: null,
      onDragStart: () => {},
      onDragEnd: () => {},
    }),
  );

  try {
    fire(queryAll(mounted.container, '.card-window')[0] as Element, 'contextmenu');

    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.cardId, root);
  } finally {
    mounted.unmount();
  }
});

test('右键落在某张子卡上 → 菜单针对那张卡（不是聚焦卡）', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '子' });

  const asked: string[] = [];
  const mounted = mount(
    createElement(CardWindow, {
      model: mustView(session.state, emptyViewState(), root),
      onFocus: () => {},
      onDropChild: () => {},
      onContextMenu: (cardId: string) => asked.push(cardId),
      menu: null,
      onMenuPick: () => {},
      onDismissMenu: () => {},
      pendingDelete: null,
      onConfirmDelete: () => {},
      onCancelDelete: () => {},
      editing: null,
      onBeginEdit: () => {},
      onCommitEdit: () => {},
      onCancelEdit: () => {},
      draggingId: null,
      onDragStart: () => {},
      onDragEnd: () => {},
    }),
  );

  try {
    fire(queryAll(mounted.container, '.compact-card')[0] as Element, 'contextmenu');

    assert.deepEqual(asked, [child], 'stopPropagation 之后窗口那一层不该再开一次菜单');
  } finally {
    mounted.unmount();
  }
});

test('菜单渲染出来时条目按传入的顺序排，危险项带 danger 类', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });

  const mounted = mount(
    createElement(CardWindow, {
      model: mustView(session.state, emptyViewState(), root),
      onFocus: () => {},
      onDropChild: () => {},
      onContextMenu: () => {},
      menu: {
        cardId: root,
        x: 10,
        y: 20,
        items: [
          { id: 'new-child', label: '新建子卡' },
          { id: 'delete', label: '删除这张卡', danger: true },
        ],
      },
      onMenuPick: () => {},
      onDismissMenu: () => {},
      pendingDelete: null,
      onConfirmDelete: () => {},
      onCancelDelete: () => {},
      editing: null,
      onBeginEdit: () => {},
      onCommitEdit: () => {},
      onCancelEdit: () => {},
      draggingId: null,
      onDragStart: () => {},
      onDragEnd: () => {},
    }),
  );

  try {
    const labels = queryAll(mounted.container, '.menu-item').map((el) => el.textContent);
    assert.deepEqual(labels, ['新建子卡', '删除这张卡']);
    assert.equal(queryAll(mounted.container, '.menu-item.danger').length, 1);
  } finally {
    mounted.unmount();
  }
});

// ── WebviewApp：手势一路验到 core 状态 ────────────────────────────────────────

function makeApp(): { session: Session; buffered: BufferedFs } {
  const buffered = createBufferedFs();
  let counter = 0;
  const session = openSession('/app', {
      builtins: false,
    clientId: 'ui',
    ops: buffered.ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
  });
  return { session, buffered };
}

test('在 WebviewApp 里双击子卡 → 聚焦真的变了，并写进 view-state', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '子' });

  const mounted = mount(
    createElement(WebviewApp, {
      session,
      buffered,
      backend,
      windowId: root,
      initialView: emptyViewState(),
    }),
  );

  try {
    doubleClick(queryAll(mounted.container, '.compact-card')[0] as Element);
    await settle();

    // 面包屑应当从 1 层变成 2 层（根 / 子）。
    // 注意 `.crumb` 这个选择器**本身就会匹配** `class="crumb current"`，
    // 所以不能再去加 `.crumb.current` 的数量（第一版就这么重复计了一次）。
    assert.equal(queryAll(mounted.container, '.crumb').length, 2);
    const current = queryAll(mounted.container, '.crumb.current')[0];
    assert.equal(current?.textContent, '子');
  } finally {
    mounted.unmount();
    await buffered.flushTo(backend);
  }
});

test('在 WebviewApp 里拖拽子卡 → core 状态真的重排了，并且落了盘', async () => {
  const { session, buffered } = makeApp();
  const backendFs = createMemoryFs();
  const backend = toAsync(backendFs.ops);
  const root = createCard(session, { parentId: null, title: '根' });
  const a = createCard(session, { parentId: root, title: 'A' });
  const b = createCard(session, { parentId: root, title: 'B' });
  const c = createCard(session, { parentId: root, title: 'C' });

  const orderOf = (): string[] => (session.state.children.get(root) ?? []).map((entry) => entry.id);

  assert.deepEqual(orderOf(), [a, b, c], '起始顺序 A B C');

  const mounted = mount(
    createElement(WebviewApp, {
      session,
      buffered,
      backend,
      windowId: root,
      initialView: emptyViewState(),
    }),
  );

  try {
    // 拖起 C，落到第一个落区（= 插到最前）
    const cards = queryAll(mounted.container, '.compact-card');
    fire(cards[2] as Element, 'dragstart');
    fire(queryAll(mounted.container, '.drop-slot')[0] as Element, 'drop');
    await settle();

    assert.deepEqual(orderOf(), [c, a, b], '拖完之后顺序应当是 C A B');

    // 界面上也真的换了位置
    const titles = queryAll(mounted.container, '.compact-title').map((el) => el.textContent);
    assert.deepEqual(titles, ['C', 'A', 'B']);

    // 手势处理里那句 `void persist()` 已经跑完了 —— 改动**自动**刷到了后端。
    // （这里原本断言"有积压"，加了 settle() 之后反而错了：说明自动刷盘真的生效了。）
    assert.equal(buffered.pendingCount(), 0, '拖完之后应当已经自动刷盘');

    // 从**那个后端**重开，顺序还在 —— 这一步才真的验证了"落盘"
    const reopened = openWorkspace('/app', backendFs.ops);
    assert.deepEqual(
      (reopened.state.children.get(root) ?? []).map((entry) => entry.id),
      [c, a, b],
    );
  } finally {
    mounted.unmount();
  }
});

test('折叠的子卡区在真 DOM 里不渲染内容', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: '子' });

  const view = mustView(session.state, emptyViewState(), root);
  const collapsed = {
    ...view,
    regions: { ...view.regions, children: { size: 0, collapsed: true } },
  };

  const mounted = mount(
    createElement(CardWindow, {
      model: collapsed,
      onFocus: () => {},
      onDropChild: () => {},
            onContextMenu: () => {},
      menu: null,
      onMenuPick: () => {},
      onDismissMenu: () => {},
      pendingDelete: null,
      onConfirmDelete: () => {},
      onCancelDelete: () => {},
      editing: null,
      onBeginEdit: () => {},
      onCommitEdit: () => {},
      onCancelEdit: () => {},
      draggingId: null,
      onDragStart: () => {},
      onDragEnd: () => {},
    }),
  );

  try {
    const region = queryAll(mounted.container, '.region.children')[0] as HTMLElement;
    assert.equal(region.style.display, 'none');
  } finally {
    mounted.unmount();
  }
});

// ── §3.3 单击编辑 / §3.5 右键新建 ──────────────────────────────────────────────

/** 往一个非受控输入框里敲内容并提交。 */
function typeInto(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  key = 'Enter',
  extra: KeyboardEventInit = {},
): void {
  act(() => {
    element.value = value;
    element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  });
}

test('单击紧凑卡 → 变成标题输入框，且不再是纯文本', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '原标题' });

  let editing: { cardId: string; field: 'title' | 'content' } | null = null;
  const mounted = mount(
    createElement(CardWindow, {
      model: mustView(session.state, emptyViewState(), root),
      onFocus: () => {},
      onDropChild: () => {},
            onContextMenu: () => {},
      menu: null,
      onMenuPick: () => {},
      onDismissMenu: () => {},
      pendingDelete: null,
      onConfirmDelete: () => {},
      onCancelDelete: () => {},
      editing,
      onBeginEdit: (target) => {
        editing = target;
      },
      onCommitEdit: () => {},
      onCancelEdit: () => {},
      draggingId: null,
      onDragStart: () => {},
      onDragEnd: () => {},
    }),
  );

  try {
    click(queryAll(mounted.container, '.compact-card')[0] as Element);

    assert.deepEqual(editing, { cardId: child, field: 'title' });
  } finally {
    mounted.unmount();
  }
});

test('单击紧凑卡 → 输入框里是当前标题（不是空的）', () => {
  const session = makeSession();
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '原标题' });

  const mounted = mount(
    createElement(CardWindow, {
      model: mustView(session.state, emptyViewState(), root),
      onFocus: () => {},
      onDropChild: () => {},
            onContextMenu: () => {},
      menu: null,
      onMenuPick: () => {},
      onDismissMenu: () => {},
      pendingDelete: null,
      onConfirmDelete: () => {},
      onCancelDelete: () => {},
      editing: { cardId: child, field: 'title' },
      onBeginEdit: () => {},
      onCommitEdit: () => {},
      onCancelEdit: () => {},
      draggingId: null,
      onDragStart: () => {},
      onDragEnd: () => {},
    }),
  );

  try {
    const input = queryAll(mounted.container, '.title-input')[0] as HTMLInputElement;
    assert.ok(input !== undefined, '应当渲染出标题输入框');
    assert.equal(input.value, '原标题');
    assert.equal(queryAll(mounted.container, '.compact-title').length, 0, '编辑时不再渲染纯文本');
  } finally {
    mounted.unmount();
  }
});

test('在 WebviewApp 里改标题：Enter 提交 → core 变了 → 自动落盘', async () => {
  const { session, buffered } = makeApp();
  const backendFs = createMemoryFs();
  const backend = toAsync(backendFs.ops);
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '旧标题' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    click(queryAll(mounted.container, '.compact-card')[0] as Element);
    await settle();

    const input = queryAll(mounted.container, '.title-input')[0] as HTMLInputElement;
    assert.ok(input !== undefined, '单击之后应当出现输入框');

    typeInto(input, '新标题');
    await settle();

    assert.equal(session.state.cards.get(child)?.title, '新标题');
    assert.equal(queryAll(mounted.container, '.title-input').length, 0, '提交后退出编辑态');
    assert.equal(buffered.pendingCount(), 0, '改动应当已经自动刷盘');

    const reopened = openWorkspace('/app', backendFs.ops);
    assert.equal(reopened.state.cards.get(child)?.title, '新标题');
  } finally {
    mounted.unmount();
  }
});

test('Esc 取消编辑：标题不变', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '原样' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    click(queryAll(mounted.container, '.compact-card')[0] as Element);
    await settle();
    typeInto(queryAll(mounted.container, '.title-input')[0] as HTMLInputElement, '不该保存', 'Escape');
    await settle();

    assert.equal(session.state.cards.get(child)?.title, '原样');
    assert.equal(queryAll(mounted.container, '.title-input').length, 0, 'Esc 也要退出编辑态');
  } finally {
    mounted.unmount();
  }
});

test('点正文区 → 编辑正文；Ctrl+Enter 提交', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  const root = createCard(session, { parentId: null, title: '根', content: '旧正文' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    click(queryAll(mounted.container, '.content-body')[0] as Element);
    await settle();

    const area = queryAll(mounted.container, '.content-input')[0] as HTMLTextAreaElement;
    assert.ok(area !== undefined, '点正文应当出现文本域');
    assert.equal(area.value, '旧正文');

    // 多行编辑：单独 Enter 是换行，Ctrl+Enter 才提交
    typeInto(area, '换行\n也不会提交', 'Enter');
    await settle();
    assert.equal(session.state.cards.get(root)?.content, '旧正文', '单按 Enter 不该提交');

    typeInto(queryAll(mounted.container, '.content-input')[0] as HTMLTextAreaElement, '新正文', 'Enter', {
      ctrlKey: true,
    });
    await settle();

    assert.equal(session.state.cards.get(root)?.content, '新正文');
  } finally {
    mounted.unmount();
  }
});

test('点当前面包屑 → 编辑聚焦卡的标题；点别的层 → 聚焦过去', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  const root = createCard(session, { parentId: null, title: '根' });
  const mid = createCard(session, { parentId: root, title: '中' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    // 先下钻到"中"
    doubleClick(queryAll(mounted.container, '.compact-card')[0] as Element);
    await settle();
    assert.equal(mid !== root, true);

    // 点当前层（"中"）→ 编辑它的标题
    click(queryAll(mounted.container, '.crumb.current')[0] as Element);
    await settle();
    assert.equal(queryAll(mounted.container, '.crumb-input').length, 1, '当前层应当变成输入框');

    typeInto(queryAll(mounted.container, '.crumb-input')[0] as HTMLInputElement, '改名后的中');
    await settle();
    assert.equal(session.state.cards.get(mid)?.title, '改名后的中');

    // 点第一层（"根"）→ 聚焦回去，而不是编辑
    click(queryAll(mounted.container, '.crumb')[0] as Element);
    await settle();
    assert.equal(queryAll(mounted.container, '.crumb-input').length, 0);
    assert.equal(queryAll(mounted.container, '.crumb').length, 1, '回到只显示根卡一层');
  } finally {
    mounted.unmount();
  }
});

test('右键 → 菜单 → 点"新建子卡" → 立刻进入标题编辑态', async () => {
  const { session, buffered } = makeApp();
  const backendFs = createMemoryFs();
  const backend = toAsync(backendFs.ops);
  const root = createCard(session, { parentId: null, title: '根' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    // 右键只是**开菜单**，不该直接建卡（§3.3 右键菜单）
    fire(queryAll(mounted.container, '.card-window')[0] as Element, 'contextmenu');
    await settle();
    assert.equal(queryAll(mounted.container, '.context-menu').length, 1, '应当弹出菜单');
    assert.equal(session.state.cards.size, 1, '仅仅是开菜单，还不该建卡');

    click(queryAll(mounted.container, '.menu-item')[0] as Element);
    await settle();

    const created = [...session.state.cards.values()].filter((card) => card.id !== root);
    assert.equal(created.length, 1, '点了"新建子卡"才建');
    assert.equal(created[0]?.title, '新卡片');
    assert.equal(queryAll(mounted.container, '.context-menu').length, 0, '选完菜单应当收起');

    // 建完直接进编辑态，省掉一次"再点一下改名"
    const input = queryAll(mounted.container, '.title-input')[0] as HTMLInputElement;
    assert.ok(input !== undefined, '新建之后应当已经在改标题');

    typeInto(input, '写点正事');
    await settle();

    assert.equal(session.state.cards.get(created[0]?.id ?? '')?.title, '写点正事');

    const reopened = openWorkspace('/app', backendFs.ops);
    assert.equal(reopened.state.cards.get(created[0]?.id ?? '')?.title, '写点正事');
  } finally {
    mounted.unmount();
  }
});

// ── §2.7：删除前必须显示张数并要求确认 ────────────────────────────────────────

test('删除要**先显示将删除几张**，确认之后才真删（§2.7）', async () => {
  const { session, buffered } = makeApp();
  const backendFs = createMemoryFs();
  const backend = toAsync(backendFs.ops);
  const root = createCard(session, { parentId: null, title: '根' });
  const mid = createCard(session, { parentId: root, title: '中' });
  createCard(session, { parentId: mid, title: '孙一' });
  createCard(session, { parentId: mid, title: '孙二' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    // 对"中"开菜单 → 删除
    fire(queryAll(mounted.container, '.compact-card')[0] as Element, 'contextmenu');
    await settle();
    click(queryAll(mounted.container, '.menu-item.danger')[0] as Element);
    await settle();

    // 确认框出现，并且**说出了张数**（中 + 两个孙 = 3）
    const box = queryAll(mounted.container, '.confirm-box')[0];
    assert.ok(box !== undefined, '应当弹出确认框');
    assert.match(box.textContent ?? '', /3/, '确认框必须显示将删除的卡片数');
    assert.equal(session.state.cards.get(mid)?.deleted, false, '还没确认就不该删');

    // 取消 → 什么都不发生
    click(queryAll(mounted.container, '.confirm-cancel')[0] as Element);
    await settle();
    assert.equal(queryAll(mounted.container, '.confirm-box').length, 0);
    assert.equal(session.state.cards.get(mid)?.deleted, false, '取消之后不该删');

    // 再来一次，这回确认
    fire(queryAll(mounted.container, '.compact-card')[0] as Element, 'contextmenu');
    await settle();
    click(queryAll(mounted.container, '.menu-item.danger')[0] as Element);
    await settle();
    click(queryAll(mounted.container, '.confirm-ok')[0] as Element);
    await settle();

    assert.equal(session.state.cards.get(mid)?.deleted, true, '确认之后才真删');
    assert.equal(queryAll(mounted.container, '.compact-card').length, 0, '界面上也没了');
    assert.equal(buffered.pendingCount(), 0, '删除应当已经自动刷盘');

    const reopened = openWorkspace('/app', backendFs.ops);
    assert.equal(reopened.state.cards.get(mid)?.deleted, true);
  } finally {
    mounted.unmount();
  }
});

test('内置卡的菜单里没有"删除"（§2.7 内置卡不可删）', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  ensureBuiltins(session);
  const mine = createCard(session, { parentId: null, title: '我的卡' });

  // 窗口挂在**内置的 001（看板）**上，右键空白处 = 对 001 开菜单
  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: '001', initialView: emptyViewState() }),
  );

  try {
    fire(queryAll(mounted.container, '.card-window')[0] as Element, 'contextmenu');
    await settle();

    assert.equal(queryAll(mounted.container, '.context-menu').length, 1, '内置卡也该能开菜单（至少能新建子卡）');
    assert.equal(queryAll(mounted.container, '.menu-item.danger').length, 0, '内置卡不该出现"删除"');

    // 菜单里有"新建子卡"与"呈现方式"两组，但没有删除
    const labels = queryAll(mounted.container, '.menu-item').map((el) => el.textContent);
    assert.ok(labels.includes('新建子卡'), `应当有"新建子卡"，实际 ${JSON.stringify(labels)}`);
    assert.equal(queryAll(mounted.container, '.menu-heading').length, 1, '应当有"呈现方式"分组标题');
    assert.equal(
      labels.some((label) => label?.includes('删除')),
      false,
    );
    void mine;
  } finally {
    mounted.unmount();
  }
});

test('普通卡的菜单里有"删除"（与上一条对照）', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  ensureBuiltins(session);
  const mine = createCard(session, { parentId: null, title: '我的卡' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: mine, initialView: emptyViewState() }),
  );

  try {
    fire(queryAll(mounted.container, '.card-window')[0] as Element, 'contextmenu');
    await settle();

    assert.equal(queryAll(mounted.container, '.menu-item.danger').length, 1);
  } finally {
    mounted.unmount();
  }
});

test('删除聚焦的那张卡之后，聚焦自动退回活着的祖先', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '子' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    // 下钻到子卡，再从**面包屑**（当前层）开菜单删掉它
    doubleClick(queryAll(mounted.container, '.compact-card')[0] as Element);
    await settle();
    assert.equal(queryAll(mounted.container, '.crumb').length, 2);

    fire(queryAll(mounted.container, '.card-window')[0] as Element, 'contextmenu');
    await settle();
    click(queryAll(mounted.container, '.menu-item.danger')[0] as Element);
    await settle();
    click(queryAll(mounted.container, '.confirm-ok')[0] as Element);
    await settle();

    assert.equal(session.state.cards.get(child)?.deleted, true);
    // 焦点退回根卡：面包屑只剩一层
    assert.equal(queryAll(mounted.container, '.crumb').length, 1);
  } finally {
    mounted.unmount();
  }
});

test('双击下钻会清掉编辑态（否则会留下一个指向旧视图的输入框）', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: '子' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    // 第一次单击进编辑态，紧接着的双击应当下钻并退出编辑
    doubleClick(queryAll(mounted.container, '.compact-card')[0] as Element);
    await settle();

    assert.equal(queryAll(mounted.container, '.title-input').length, 0);
    assert.equal(queryAll(mounted.container, '.crumb').length, 2, '应当已经下钻到子卡');
  } finally {
    mounted.unmount();
  }
});

// ── UI 侧的撤销（§2.7「删除可撤销」） ─────────────────────────────────────────

/** 在 document 上敲一个组合键 —— 与真实快捷键分发一致。 */
function pressKey(key: string, extra: KeyboardEventInit = {}): void {
  act(() => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  });
}

test('Ctrl+Z 撤销上一次改动：标题回退', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '旧标题' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    click(queryAll(mounted.container, '.compact-card')[0] as Element);
    await settle();
    typeInto(queryAll(mounted.container, '.title-input')[0] as HTMLInputElement, '新标题');
    await settle();
    assert.equal(session.state.cards.get(child)?.title, '新标题');

    pressKey('z', { ctrlKey: true });
    await settle();

    assert.equal(session.state.cards.get(child)?.title, '旧标题', 'Ctrl+Z 应当把标题撤回去');
    assert.equal(buffered.pendingCount(), 0, '撤销也要落盘');
  } finally {
    mounted.unmount();
  }
});

test('撤销一次删除：卡回来，界面也跟着回来', async () => {
  const { session, buffered } = makeApp();
  const backendFs = createMemoryFs();
  const backend = toAsync(backendFs.ops);
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '要删的' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    fire(queryAll(mounted.container, '.compact-card')[0] as Element, 'contextmenu');
    await settle();
    click(queryAll(mounted.container, '.menu-item.danger')[0] as Element);
    await settle();
    click(queryAll(mounted.container, '.confirm-ok')[0] as Element);
    await settle();
    assert.equal(queryAll(mounted.container, '.compact-card').length, 0, '删完界面上没了');

    click(queryAll(mounted.container, '.undo-button')[0] as Element);
    await settle();

    assert.equal(session.state.cards.get(child)?.deleted, false, '撤销删除应当把卡拿回来');
    assert.equal(queryAll(mounted.container, '.compact-card').length, 1, '界面上也回来');

    const reopened = openWorkspace('/app', backendFs.ops);
    assert.equal(reopened.state.cards.get(child)?.deleted, false, '撤销也是落盘的');
  } finally {
    mounted.unmount();
  }
});

test('没得撤时撤销按钮禁用（而不是点了之后回一句"没得撤"）', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  const root = createCard(session, { parentId: null, title: '根' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    // 建了根卡，所以有一条可撤
    assert.equal((queryAll(mounted.container, '.undo-button')[0] as HTMLButtonElement).disabled, false);

    click(queryAll(mounted.container, '.undo-button')[0] as Element);
    await settle();

    // 撤到底之后按钮应当变灰
    assert.equal((queryAll(mounted.container, '.undo-button')[0] as HTMLButtonElement).disabled, true);
    // 而且界面**没有崩**：根卡被撤销掉了，窗口显示空态
    assert.equal(queryAll(mounted.container, '.empty-window').length, 1, '根卡没了应当显示空态而不是抛错');
  } finally {
    mounted.unmount();
  }
});

test('焦点在文本框里时 Ctrl+Z 不被应用抢走（那时它是"撤销打字"）', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  const root = createCard(session, { parentId: null, title: '根' });
  const child = createCard(session, { parentId: root, title: '原标题' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    click(queryAll(mounted.container, '.compact-card')[0] as Element);
    await settle();

    const input = queryAll(mounted.container, '.title-input')[0] as HTMLInputElement;
    // 从输入框内部发出 —— 事件目标就是 input
    act(() => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await settle();

    assert.equal(session.state.cards.get(child)?.title, '原标题', '不该被应用层的撤销动到');
    assert.equal(queryAll(mounted.container, '.title-input').length, 1, '还在编辑态');
  } finally {
    mounted.unmount();
  }
});

test('撤销会关掉浮层：菜单不会指着一张已经不在原位的卡', async () => {
  const { session, buffered } = makeApp();
  const backend = toAsync(createMemoryFs().ops);
  const root = createCard(session, { parentId: null, title: '根' });
  createCard(session, { parentId: root, title: '子' });

  const mounted = mount(
    createElement(WebviewApp, { session, buffered, backend, windowId: root, initialView: emptyViewState() }),
  );

  try {
    fire(queryAll(mounted.container, '.compact-card')[0] as Element, 'contextmenu');
    await settle();
    assert.equal(queryAll(mounted.container, '.context-menu').length, 1);

    pressKey('z', { ctrlKey: true });
    await settle();

    assert.equal(queryAll(mounted.container, '.context-menu').length, 0, '撤销应当把菜单关掉');
  } finally {
    mounted.unmount();
  }
});
