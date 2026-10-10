import {uiText} from '../i18n/text.ts';
/**
 * 有状态的窗口外壳：持有会话与视图状态，把用户手势翻成 core 操作，并负责刷盘。
 *
 * 【为什么用 `useReducer` 的 bump 而不是 `useState(model)`】
 * core 的会话状态是**可变对象**（`emit` 会换掉 `session.state` 引用），
 * 但 React 认的是"我 setState 过没有"。所以这里只在操作之后手动 bump 一次，
 * 渲染时重新调 `viewOf` —— 模型本身是纯函数，不需要被 React 缓存。
 */

import { useCallback, useEffect, useReducer, useState, type JSX } from 'react';

import { isDeletable } from '../core/builtins.ts';
import { parentIndexOf } from '../core/indexes.ts';
import type { Layout } from '../core/types.ts';
import { moveCard, subtreeSize } from '../core/workspace.ts';
import type { Session } from '../core/workspace.ts';
import { viewOf } from '../core/view-model.ts';
import {
  closeWindow,
  isWindowOpen,
  openWindow,
  rememberOpenWindows,
  setFocus as setViewFocus,
  writeViewState,
  type ViewState,
} from '../core/view-state.ts';
import { MAIN_ID, openWindowSet, desktopCards } from '../core/windows.ts';
import type { AsyncFsOps } from '../platform/async-fs-ops.ts';
import type { BufferedFs } from '../platform/buffered-fs-ops.ts';
import { CardWindow, type EditTarget } from './CardWindow.tsx';
import { clampMenuPosition, estimateMenuSize } from './menu-position.ts';
import type { ContextMenuState, MenuItem, PendingDelete } from './ContextMenu.tsx';
import { emitChanged, emitCommand, onChanged, onCommand } from './ipc.ts';
import { isWindowCommand, runIntent, type Intent } from './operations.ts';
import { isTauri, syncCardWindows } from './tauri-backend.ts';
import type { WindowRole } from './window-role.ts';
import { wantedCardWindows } from './window-sync.ts';

/**
 * 菜单里能选的呈现方式。
 *
 * **刻意没有 `plane`**：把它改成平面需要每张子卡一个坐标，而坐标是**数据**，
 * 凭空编一个就是"卡跑到了我没放的地方"（core 的 `reshapeEntries` 也是这么拒绝的）。
 * 界面上要做到这一点得先有"坐标级拖拽"——那是独立的一步。
 */
const LAYOUT_CHOICES: ReadonlyArray<{ layout: Layout; label: string }> = [
  { layout: 'plain', label: uiText("webview/WebviewApp.text001") },
  { layout: 'ordered', label: uiText("webview/WebviewApp.text002") },
  { layout: 'tabs', label: uiText("webview/WebviewApp.text003") },
  { layout: 'columns', label: uiText("webview/WebviewApp.text004") },
  { layout: 'grid', label: uiText("webview/WebviewApp.text005") },
];

const LAYOUT_ITEM_PREFIX = 'layout:';

/** §3.3 菜单里的「提出到屏幕窗口」。 */
const TO_WINDOW_ITEM_ID = 'to-window';

/** 生成"呈现方式"那一组菜单项，并标出当前正在用的那个。 */
export function layoutMenuItems(current: Layout): MenuItem[] {
  return [
    { id: 'layout-heading', label: uiText("webview/WebviewApp.text006"), heading: true },
    ...LAYOUT_CHOICES.map(({ layout, label }) => ({
      id: `${LAYOUT_ITEM_PREFIX}${layout}`,
      label,
      active: layout === current,
    })),
  ];
}

export type WebviewAppProps = {
  session: Session;
  buffered: BufferedFs;
  backend: AsyncFsOps;
  /** 这个窗口是哪个根卡的（§2.8：窗口 id = 根卡 id） */
  windowId: string;
  initialView: ViewState;
  /**
   * **我是谁**（§14 方案 A）：`main`/`preview` 是写者，`card` 是只读镜像。
   * 默认写者，于是单窗口语境的调用点（含既有测试）不用改。
   */
  role?: WindowRole | undefined;
  /** 本窗口标签。镜像转发命令时要带上自己，好让"建完进编辑"这种回执找得回来。 */
  label?: string | null | undefined;
  /** 镜像专用：收到 main 的广播后重新读盘。写者不需要。 */
  reload?: (() => Promise<{ session: Session; view: ViewState }>) | undefined;
};

export function WebviewApp(props: WebviewAppProps): JSX.Element {
  const {
    session: initialSession,
    buffered,
    backend,
    windowId,
    initialView,
    role = { kind: 'main' },
    label = null,
    reload,
  } = props;

  // 会话可以被整体换掉：镜像每次收到 main 的广播都会重新读盘并重建它。
  const [session, setSession] = useState<Session>(initialSession);
  /** 写者持有会话并写盘；镜像只读（§14 方案 A：单一写者）。 */
  const isWriter = role.kind !== 'card';

  const [view, setView] = useState<ViewState>(initialView);
  const [focusOverride, setFocusOverride] = useState<string | undefined>(undefined);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [status, setStatus] = useState<string>(uiText("webview/WebviewApp.text007"));
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const model = viewOf(session.state, view, windowId, focusOverride);
  /** 窗口的根卡可能在撤销之后不复存在（§2.8：那时窗口本身也该关掉）。 */
  const focusCardId = model?.id ?? null;

  /**
   * 每次改动之后刷盘；失败只报状态，不回滚内存（journal 还在，可以重试）。
   *
   * **镜像直接返回**：写盘只有一个写者（§14 方案 A），镜像要是也刷，
   * 两个 webview 就会各写各的 `events.jsonl`，seq 立刻分叉。
   */
  const persist = useCallback(async (): Promise<void> => {
    if (!isWriter) return;

    // §7.3：顺手把**实际开着的窗口集合**记进 view-state，供下次启动恢复。
    // 用 `openWindowSet`（与 `desktopCards` 求交）而不是直接把 `current.openWindows` 写回去：
    // 被拖进容器 / 已删除的卡会在这里被顺手剪掉，不会在文件里越攒越多。
    // `rememberOpenWindows` 在集合没变时返回同一个引用，所以这里多半不会触发重渲染。
    setView((current) => {
      const next = rememberOpenWindows(current, openWindowSet(session.state, current.openWindows));
      if (next !== current) writeViewState(session.root, next, buffered.ops);
      return next;
    });

    try {
      await buffered.flushTo(backend);
      setStatus(uiText("webview/WebviewApp.text008", {arg0: (session.events.length)}));
    } catch (error) {
      setStatus(uiText("webview/WebviewApp.text009", {arg0: (error instanceof Error ? error.message : String(error))}));
    }
  }, [backend, buffered, isWriter, session]);

  /**
   * 跑一条**动树**的命令。写者直接执行，镜像转发给 main。
   *
   * 两边用的是**同一个 `runIntent`**（`operations.ts`），所以"镜像版语义"这种东西不存在。
   * 镜像这里只能乐观地返回成功 —— 真正的结果（尤其是新卡 id）由 main 的广播带回。
   */
  const runCommand = useCallback(
    (intent: Intent): { ok: boolean; createdId?: string; removed?: number; undone?: boolean } => {
      if (!isWriter) {
        setStatus(uiText("webview/WebviewApp.text010"));
        void emitCommand(label ?? '', intent).catch((error: unknown) => {
          setStatus(uiText("webview/WebviewApp.text011", {arg0: (error instanceof Error ? error.message : String(error))}));
        });
        return { ok: true };
      }

      const result = runIntent(session, intent);
      if (!result.ok) {
        setStatus(uiText("webview/WebviewApp.text012", {arg0: (result.message)}));
        return { ok: false };
      }

      bump();
      void persist();
      // 让所有镜像重载 —— 它们的内存副本从这一刻起就旧了。
      void emitChanged(label ?? 'main', result.createdId);
      return result;
    },
    [bump, isWriter, label, persist, session],
  );

  const focusCard = useCallback(
    (cardId: string): void => {
      setEditing(null); // 下钻时退出编辑态
      setFocusOverride(cardId);
      // 镜像的聚焦只活在内存里：写 `view-state.json` 是写者的职责（§14 方案 A）。
      // §3.4 说"聚焦状态是每个窗口自己的"，那说的是**不互相同步**，不是"镜像也要落盘"。
      if (!isWriter) return;
      setView((current) => {
        const next = setViewFocus(current, windowId, cardId);
        writeViewState(session.root, next, buffered.ops);
        return next;
      });
      void persist();
    },
    [buffered, isWriter, persist, session.root, windowId],
  );

  const dropChild = useCallback(
    (cardId: string, index: number): void => {
      if (cardId === '' || focusCardId === null) return;
      setEditing(null);
      // 手势 → 命令。落到**当前聚焦的卡**下面（§3.3：父级只列直接子项）
      runCommand({ kind: 'moveCard', cardId, parentId: focusCardId, index });
      setDraggingId(null);
    },
    [focusCardId, runCommand],
  );

  /** §3.5：右键面板新建子卡。建完**立刻切进标题编辑**，省掉一个"新卡片"改名步骤。 */
  const createChild = useCallback(
    (parentId: string): void => {
      const result = runCommand({ kind: 'createCard', parentId, title: uiText("webview/WebviewApp.text013") });
      // 镜像这一侧 createdId 一定是 undefined —— 新卡 id 由 main 的广播带回来（见下面的 onChanged）。
      if (result.createdId !== undefined) setEditing({ cardId: result.createdId, field: 'title' });
    },
    [runCommand],
  );

  /**
   * 「提出到屏幕窗口」（§2.8）—— 一个动作做完两件事：
   * 把卡从父卡下摘出来变成桌面卡片，再给它开一扇真窗口。
   *
   * 两半合在一个动作里是刻意的：用户在菜单上点的是一个**动作**，
   * 不该出现"树改了但窗没开"的中间态。（"候选 ≠ 已开"是给别的路径留的口子 ——
   * 比如把卡拖到桌面、或者关掉窗口，那时它仍是桌面卡片但没有窗口。）
   */
  const proposeToWindow = useCallback(
    (cardId: string): void => {
      if (!isWriter) {
        void emitCommand(label ?? '', { kind: 'proposeToWindow', cardId }).catch((error: unknown) => {
          setStatus(uiText("webview/WebviewApp.text011", {arg0: (error instanceof Error ? error.message : String(error))}));
        });
        setStatus(uiText("webview/WebviewApp.text010"));
        return;
      }

      try {
        // 已经是桌面卡片就不用改树，只开窗
        if ((parentIndexOf(session.state).get(cardId) ?? null) !== null) {
          moveCard(session, cardId, null, 0);
          bump();
        }
        const next = openWindow(view, cardId);
        setView(next);
        writeViewState(session.root, next, buffered.ops);
        void persist();
        setStatus(uiText("webview/WebviewApp.text014"));
      } catch (error) {
        setStatus(uiText("webview/WebviewApp.text015", {arg0: (error instanceof Error ? error.message : String(error))}));
      }
    },
    [buffered, bump, isWriter, label, persist, session, view],
  );

  /**
   * 把某张卡的窗口开上 / 关上。**只在写者里跑**（列表是 main 的门面）。
   *
   * 关掉窗口不影响任何结构，重新打开就是这一句 —— 用户定案的那条语义全靠这里成立。
   * `closeWindow` 对 main 会抛错（单写者不能自己消失），所以必须接住。
   */
  const setCardWindowOpen = useCallback(
    (cardId: string, open: boolean): void => {
      try {
        const next = open ? openWindow(view, cardId) : closeWindow(view, cardId);
        if (next === view) return;
        setView(next);
        writeViewState(session.root, next, buffered.ops);
        setStatus(open ? uiText("webview/WebviewApp.text016") : uiText("webview/WebviewApp.text017"));
      } catch (error) {
        setStatus(uiText("webview/WebviewApp.text018", {arg0: (error instanceof Error ? error.message : String(error))}));
      }
    },
    [buffered, session.root, view],
  );

  /** main 的「桌面卡片」列表：点一下开 / 关。 */
  const toggleCardWindow = useCallback(
    (cardId: string): void => {
      setCardWindowOpen(cardId, !isWindowOpen(view, cardId));
    },
    [setCardWindowOpen, view],
  );

  /** §3.3 右键菜单：条目按目标卡现算（内置卡不给"删除"）。 */
  const openMenu = useCallback(
    (cardId: string, x: number, y: number): void => {
      const card = session.state.cards.get(cardId);
      const items: MenuItem[] = [{ id: 'new-child', label: uiText("webview/WebviewApp.text019") }];

      if (card !== undefined) {
        // 本窗口正在显示的那张卡不给这一项：它已经在屏幕上了，再开一扇就是同一张卡两个窗口
        if (cardId !== windowId) items.push({ id: TO_WINDOW_ITEM_ID, label: uiText("webview/WebviewApp.text020") });
        items.push(...layoutMenuItems(card.layout));
      }
      if (isDeletable(cardId)) items.push({ id: 'delete', label: uiText("webview/WebviewApp.text021"), danger: true });

      // 夹进视口 —— 否则点在右下角时菜单会被裁掉、条目够不到
      const position = clampMenuPosition(
        { x, y },
        estimateMenuSize(items.length),
        { width: window.innerWidth, height: window.innerHeight },
      );

      setMenu({ cardId, x: position.x, y: position.y, items });
    },
    [session, windowId],
  );

  const pickMenu = useCallback(
    (itemId: string): void => {
      const target = menu;
      setMenu(null);
      if (target === null) return;

      if (itemId === 'new-child') {
        createChild(target.cardId);
        return;
      }
      if (itemId === TO_WINDOW_ITEM_ID) {
        proposeToWindow(target.cardId);
        return;
      }
      if (itemId === 'delete') {
        // §2.7：先把"将删除几张"算出来给用户看，**确认之后才真删**。
        // 这里必须是无副作用的预览 —— 否则确认环节就没有意义了。
        const title = session.state.cards.get(target.cardId)?.title ?? target.cardId;
        setPendingDelete({ cardId: target.cardId, count: subtreeSize(session, target.cardId), title });
        return;
      }
      if (itemId.startsWith(LAYOUT_ITEM_PREFIX)) {
        const layout = itemId.slice(LAYOUT_ITEM_PREFIX.length) as Layout;
        // 走 `setLayout` 而不是 `setField('/layout')`：前者会连带重写子卡条目，
        // 后者会让条目形状对不上、下次打开工作区报数据损坏（§4.1 的 layout_change）。
        // 这一条现在由 `runIntent` 保证 —— 镜像转发出去的是同一个意图。
        runCommand({ kind: 'setLayout', cardId: target.cardId, layout });
      }
    },
    [createChild, menu, proposeToWindow, runCommand, session],
  );

  const confirmDelete = useCallback((): void => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (target === null) return;

    const result = runCommand({ kind: 'deleteCard', cardId: target.cardId });
    if (!result.ok) return;

    // 聚焦的卡可能就在刚删掉的子树里 —— `viewOf` 的 `resolveFocus` 会退回最近的活祖先，
    // 这里只要把"手动聚焦"清掉，交给它去算。
    setFocusOverride(undefined);
    // 镜像这一侧拿不到张数（真实结果是 main 算的），它会停在"已发给主窗口…"。
    if (result.removed !== undefined) setStatus(uiText("webview/WebviewApp.text022", {arg0: (result.removed)}));
  }, [pendingDelete, runCommand]);

  /** §3.3「单击编辑」的落点：提交一个字段。 */
  const commitEdit = useCallback(
    (target: EditTarget, value: string): void => {
      setEditing(null);
      runCommand({
        kind: 'setField',
        cardId: target.cardId,
        path: target.field === 'title' ? '/title' : '/content',
        value,
      });
    },
    [runCommand],
  );

  const cancelEdit = useCallback((): void => setEditing(null), []);

  /**
   * §2.7：删除是**可撤销**的。界面既然有删除入口，就必须有撤销出口 ——
   * 否则"可撤销"只存在于 MCP 工具里，人手删掉的东西找不回来。
   *
   * 【为什么要把浮层也关掉】撤销会改动树，菜单/确认框指着的卡可能已经不在原位；
   * 留着它们就会出现"菜单指向一张已经不存在的卡"。一律先关。
   */
  const undo = useCallback((): void => {
    setEditing(null);
    setMenu(null);
    setPendingDelete(null);

    const result = runCommand({ kind: 'undo' });
    if (!result.ok) return;
    if (result.undone === false) {
      setStatus(uiText("webview/WebviewApp.text023"));
      return;
    }
    // 撤销可能把聚焦的那张卡变没了（比如撤销一次"建卡"）——交给 resolveFocus 去回退
    setFocusOverride(undefined);
    setStatus(uiText("webview/WebviewApp.text024", {arg0: (session.events.length)}));
  }, [runCommand, session.events.length]);

  /**
   * Ctrl/Cmd+Z 撤销。
   *
   * 【焦点在文本框里时不要抢】那时 Ctrl+Z 是"撤销打字"，属于编辑器的本分；
   * 应用把它抢走会让"刚打错一个字想撤回来"变成"整张卡的标题被撤没了"。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as { tagName?: string } | null;
      const tag = target?.tagName?.toLowerCase();
      const inTextField = tag === 'input' || tag === 'textarea';

      // Escape 一律关浮层。输入框里也管 —— 用户按 Esc 就是想"算了"，
      // 而内联编辑框自己也会收到 Esc（它是 bubble 上来的同一次事件）。
      if (event.key === 'Escape') {
        setMenu(null);
        setPendingDelete(null);
        setEditing(null);
        return;
      }

      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;

      // 焦点在文本框里时**不要抢** Ctrl+Z：那时它是"撤销打字"，属于编辑器的本分。
      // 抢走会让"刚打错一个字想撤回来"变成"整张卡的标题被撤没了"。
      if (inTextField) return;

      event.preventDefault();
      undo();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [undo]);

  const canUndo = session.events.length > 0;

  // ── 多窗口（§14 方案 A）────────────────────────────────────────────────────
  //
  // 写者与镜像各注册一条通道，互不重叠：main 听命令，卡片窗口听广播。

  /**
   * **写者**：真实窗口集合是 `view.openWindows` 的**结果**，不是它的来源。
   *
   * 每次 `openWindows` 变了就与 Rust 对一次账（多退少补），于是
   * "开窗 / 关窗 / 上次崩溃留下的残留"三种情况走同一条路径收敛，
   * 前端不需要自己记"上一轮开了哪些"。
   */
  useEffect(() => {
    if (!isWriter || !isTauri()) return;

    const wanted = wantedCardWindows(
      session.state,
      view.openWindows,
      windowId === '' ? null : windowId,
    );
    void syncCardWindows(wanted)
      .then((problems) => {
        if (problems.length > 0) setStatus(uiText("webview/WebviewApp.text025", {arg0: (problems.join('；'))}));
      })
      .catch((error: unknown) => {
        setStatus(uiText("webview/WebviewApp.text026", {arg0: (error instanceof Error ? error.message : String(error))}));
      });
  }, [isWriter, session, view.openWindows, windowId]);

  /**
   * **写者**：接卡片窗口转发的命令，用**同一个 `runIntent`** 执行。
   *
   * 这就是方案 A 的全部：卡片窗口不持有写权限，它只是把意图说出来，
   * 由唯一的写者执行 —— 于是 WAL 的"单一追加者"天然成立，seq 不会分叉。
   */
  useEffect(() => {
    if (!isWriter) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void onCommand((message) => {
      const command = message.command;

      if (isWindowCommand(command)) {
        switch (command.kind) {
          case 'proposeToWindow':
            proposeToWindow(command.cardId);
            break;
          case 'reopenWindow':
            setCardWindowOpen(command.cardId, true);
            break;
          case 'closeWindow':
            // 关就是关，不能走 toggle —— 否则"已经不在 openWindows 里了"会被它反过来打开。
            setCardWindowOpen(command.cardId, false);
            break;
        }
        return;
      }

      const result = runIntent(session, command);
      if (!result.ok) {
        setStatus(uiText("webview/WebviewApp.text027", {arg0: (result.message)}));
        return;
      }
      bump();
      void persist();
      void emitChanged(label ?? 'main', result.createdId);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [bump, isWriter, label, persist, proposeToWindow, session, setCardWindowOpen]);

  /**
   * **镜像**：收到 main 的"工作区变了"就重新读盘、重建会话。
   *
   * 为什么整体重载而不是增量：镜像的内存副本可能落后好几步（它自己的写被拒了、
   * main 又改了别的地方），增量对齐要额外维护"我应用到哪一条了"，
   * 而重载只是把 `hydrate` + `openSession` 再跑一遍 —— 代价小得多，也不会对不上。
   */
  useEffect(() => {
    if (isWriter || reload === undefined) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void onChanged((message) => {
      void reload()
        .then(({ session: next, view: nextView }) => {
          if (cancelled) return;
          setSession(next);
          setView(nextView);
          setFocusOverride(undefined);
          bump();
          // 建卡是**我**发起的 → 建完立刻进标题编辑。别的窗口也重载，但不该抢走输入焦点。
          if (message.createdId !== undefined && message.from === label) {
            setEditing({ cardId: message.createdId, field: 'title' });
          }
        })
        .catch((error: unknown) => {
          setStatus(uiText("webview/WebviewApp.text028", {arg0: (error instanceof Error ? error.message : String(error))}));
        });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [bump, isWriter, label, reload]);

  /**
   * main 的「桌面卡片」列表 —— 关掉的窗口从这里重新打开（用户定案：
   * 「关闭卡片不影响任何结构！可以在 main 中重新打开！」）。
   *
   * 过滤掉三样：main 自己（它就是本窗口）、本窗口正在显示的那张卡（已经在屏幕上了）。
   */
  const desktopStrip = isWriter ? (
    <div className="desktop-strip">
      <span className="desktop-strip-label">{uiText("webview/WebviewApp.text029")}</span>
      {desktopCards(session.state)
        .filter((id) => id !== MAIN_ID && id !== windowId)
        .map((id) => {
          const open = isWindowOpen(view, id);
          const title = session.state.cards.get(id)?.title ?? id;
          return (
            <button
              key={id}
              type="button"
              className={open ? 'desktop-chip is-open' : 'desktop-chip'}
              onClick={() => toggleCardWindow(id)}
              title={open ? uiText("webview/WebviewApp.text030", {arg0: (title)}) : uiText("webview/WebviewApp.text031", {arg0: (title)})}
            >
              {title}
            </button>
          );
        })}
      {desktopCards(session.state).filter((id) => id !== MAIN_ID && id !== windowId).length === 0 ? (
        <span className="desktop-strip-empty">{uiText("webview/WebviewApp.text032")}</span>
      ) : null}
    </div>
  ) : null;

  const footer = (
    <footer className="status">
      <span>{status}</span>
      <span className="status-right">
        <button
          type="button"
          className="undo-button"
          onClick={undo}
          // 没得撤时禁用，而不是点了之后回一句"没得撤"
          disabled={!canUndo}
          title={uiText("webview/WebviewApp.text033")}
        >
          {uiText("webview/WebviewApp.text034")}</button>
        <span>
          {session.root} {uiText("webview/WebviewApp.text035")}{session.events.length} {uiText("webview/WebviewApp.text036")}{buffered.pendingCount()}
        </span>
      </span>
    </footer>
  );

  // 根卡不在了：显示空态而不是崩掉。
  // §2.8 W′：根卡没了窗口本身就不该存在 —— 关它是 main 的 `sync_card_windows` 干的活，
  // 但无边框窗口没有关闭按钮，万一它没关掉，用户得有路可走，所以这里留一个出口。
  if (model === null) {
    return (
      <div className="app">
        <div className="card-window empty-window">
          <p className="empty-title">{uiText("webview/WebviewApp.text037")}</p>
          {isWriter ? (
            <p className="hint">{uiText("webview/WebviewApp.text038")}</p>
          ) : (
            <>
              <p className="hint">{uiText("webview/WebviewApp.text039")}</p>
              <button
                type="button"
                className="empty-close"
                onClick={() => {
                  void emitCommand(label ?? '', { kind: 'closeWindow', cardId: windowId });
                }}
              >
                {uiText("webview/WebviewApp.text040")}</button>
            </>
          )}
        </div>
        {footer}
      </div>
    );
  }

  return (
    <div className="app">
      {desktopStrip}
      <CardWindow
        model={model}
        onFocus={focusCard}
        onDropChild={dropChild}
        onContextMenu={openMenu}
        menu={menu}
        onMenuPick={pickMenu}
        onDismissMenu={() => setMenu(null)}
        pendingDelete={pendingDelete}
        onConfirmDelete={confirmDelete}
        onCancelDelete={() => setPendingDelete(null)}
        editing={editing}
        onBeginEdit={setEditing}
        onCommitEdit={commitEdit}
        onCancelEdit={cancelEdit}
        draggingId={draggingId}
        onDragStart={setDraggingId}
        onDragEnd={() => setDraggingId(null)}
      />
      {footer}
    </div>
  );
}
