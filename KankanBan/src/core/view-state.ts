import {isSkin,type SkinId} from './skins.ts';
import {windowAnchor,newExpansionId} from './window-identity.ts';
import {uiText} from '../i18n/text.ts';
import {validCanvasBindings,type CanvasDragBindings} from './canvas-drag.ts';
/**
 * `view-state.json` —— ARCHITECTURE.md §8 的文件布局、§2.3 的权威边界、§3.4 的聚焦状态。
 *
 * 【权威边界】窗口位置/大小、折叠比例、聚焦 id **纯本机**：
 * 不进事件日志、不进 git、不进 `tree.json`。换台机器看同一份工作区，
 * 窗口摆在哪、看到哪一层，本来就不该跟着走。
 *
 * Window IDs identify desktop expansions, independently of tree nodes.
 * The default view uses the card ID; additional views use cardID__nonce.
 *
 * 这里的文件**不是** WAL 的一部分：它随时可以丢，丢了只是窗口回到默认位置。
 * 所以写坏了不阻塞启动（读不动就退回空状态），与 `tree.json` 的严格校验刻意不同。
 */

import { joinPath } from './paths.ts';
import { defaultFsOps, writeAtomic, type FsOps } from './storage/fs-ops.ts';
import { KKB_DIR } from './storage/workspace-io.ts';
import type { CardId } from './types.ts';
import { MAIN_ID } from './windows.ts';

const VIEW_FILE = 'view-state.json';

const viewPath = (root: string): string => joinPath(root, KKB_DIR, VIEW_FILE);

/** §3.1 三区域。 */
export type Region = 'breadcrumb' | 'content' | 'children';

export type Bounds = { x: number; y: number; width: number; height: number };

export type WindowView = {
  childArea?: { width: number; height: number };
  /** §3.4 当前聚焦的卡；默认是窗口的根卡 */
  focusId: CardId;
  /** 三区域尺寸（逻辑像素） */
  regions: Record<Region, number>;
  /** 拖到零 = 折叠 */
  collapsed: Record<Region, boolean>;
  /** 窗口位置与大小；null 表示还没定过 */
  bounds: Bounds | null;
};

export const DEFAULT_CARD_RADIUS = 10;
export const MAX_CARD_RADIUS = 40;

export type ViewState = {
  extensions?:Record<string,import('../extensions/registry.ts').ExtensionConfig>;
  userSignature?: string;
  tutorialCardId?:string;
  skin?: SkinId;
  cardRadius?: number;
  canvasSwapButtons?: boolean;
  canvasDragBindings?: CanvasDragBindings;
  version: 2;
  windows: Record<CardId, WindowView>;
  /** Dedicated desktop view IDs, independent of parentage.
   * Their anchor cards must remain live; several views may share one anchor.
   */
  openWindows: CardId[];
};

export const REGIONS: Region[] = ['breadcrumb', 'content', 'children'];

export function defaultRegions(): Record<Region, number> {
  return { breadcrumb: 32, content: 200, children: 240 };
}

export function emptyViewState(): ViewState {
  return { version: 2, windows: {}, openWindows: [] };
}
/** Active opening creates a new desktop view; restore/sync use stored IDs instead. */
export function freshWindow(view:ViewState,cardId:string):{view:ViewState;windowId:string}{
 const windowId=newExpansionId(cardId);
 return {windowId,view:{...openWindow(view,windowId),windows:{...view.windows,[windowId]:{...windowViewFor(view,cardId),focusId:cardId,bounds:null}}}};
}

function noRegionCollapsed(): Record<Region, boolean> {
  return { breadcrumb: false, content: false, children: false };
}

/** 取某窗口的视图状态，没有就给一份默认（focus = 根卡自身）。 */
export function windowViewFor(view: ViewState, windowId: CardId): WindowView {
  const existing = view.windows[windowId];
  if (existing !== undefined) return existing;
  return {
    focusId: windowAnchor(windowId),
    regions: defaultRegions(),
    collapsed: noRegionCollapsed(),
    bounds: null,
  };
}

function withWindow(
  view: ViewState,
  windowId: CardId,
  update: (current: WindowView) => WindowView,
): ViewState {
  return {
    ...view,
    windows: { ...view.windows, [windowId]: update(windowViewFor(view, windowId)) },
  };
}

export function setFocus(view: ViewState, windowId: CardId, focusId: CardId): ViewState {
  return withWindow(view, windowId, (current) => ({ ...current, focusId }));
}

export function setRegionSize(
  view: ViewState,
  windowId: CardId,
  region: Region,
  size: number,
): ViewState {
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(uiText("core/view-state.text001", {arg0: (String(size))}));
  }
  return withWindow(view, windowId, (current) => ({
    ...current,
    regions: { ...current.regions, [region]: size },
    // §3.1：拖到零就是折叠。两处状态由同一个输入源推出，不需要分别设置。
    collapsed: { ...current.collapsed, [region]: size === 0 },
  }));
}

export function setBounds(view: ViewState, windowId: CardId, bounds: Bounds): ViewState {
  return withWindow(view, windowId, (current) => ({ ...current, bounds }));
}

/** 窗口被关掉（或根卡被删）时清掉它的视图状态 —— 否则文件会一直长大。 */
export function forgetWindow(view: ViewState, windowId: CardId): ViewState {
  const windows = { ...view.windows };
  delete windows[windowId];
  return {
    ...view,
    windows,
    openWindows: view.openWindows.filter((id) => id !== windowId),
  };
}

// ── §7.3 窗口生命周期：上次会话的恢复集合 ──────────────────────────────────────

/** 上次会话记下的窗口集合（去重 + 排序，保证稳定）。 */
export function openWindowsOf(view: ViewState): CardId[] {
  return [...new Set(view.openWindows)].sort();
}

/**
 * 把当前的窗口集合记进视图状态（§7.3 的"恢复集合"）。
 *
 * **集合没变时返回原对象（同一个引用）** —— 调用方多半是 React 的 `setState`，
 * 每次操作都返回新对象会让它白重渲染一次。
 */
export function rememberOpenWindows(view: ViewState, windowIds: readonly CardId[]): ViewState {
  const next = [...new Set(windowIds)].sort();
  const current = openWindowsOf(view);

  if (next.length === current.length && next.every((id, index) => id === current[index])) {
    return view;
  }
  return { ...view, openWindows: next };
}

// ── 开窗 / 关窗：纯视图动作，树一动不动（v7，§2.8） ──────────────────────────

/**
 * 打开一张桌面卡片的窗口（`openWindowSet` 求值时会把 main 补上，这里不用管）。
 *
 * 幂等：已经开着就返回**同一个引用** —— 调用方多是 React 的 `setState`。
 */
export function openWindow(view: ViewState, windowId: CardId): ViewState {
  return rememberOpenWindows(view, [...view.openWindows, windowId]);
}

/**
 * 关闭一张桌面卡片的窗口。
 *
 * 【用户定案】「关闭卡片不影响任何结构！可以在 main 中重新打开！」
 * 所以这里**只**把它从 `openWindows` 里去掉：
 *   - 不改 `parent`、不产生事件、不进 `tree.json`、也不撤销
 *   - **不清 `windows[windowId]`** —— 位置 / 尺寸 / 聚焦是这个窗口在桌面上的记忆，
 *     重开时应当回到原地（清理由 `forgetWindow` 负责，那是"卡没了"的情形）
 *
 * `MAIN_ID` 拒绝关闭：单写者方案（§14 决定 A）下 main 是唯一写盘的那个 webview，
 * 关掉它需要先定"谁来接管"，本轮没有这个机制，所以宁可直接报错而不是让工作区变哑。
 */
export function closeWindow(view: ViewState, windowId: CardId): ViewState {
  if (windowId === MAIN_ID) {
    throw new Error(uiText("core/view-state.text002", {arg0: (MAIN_ID)}));
  }
  if (!view.openWindows.includes(windowId)) return view;
  return { ...view, openWindows: view.openWindows.filter((id) => id !== windowId) };
}

/** 这张卡的窗口现在开着吗。 */
export function isWindowOpen(view: ViewState, windowId: CardId): boolean {
  return view.openWindows.includes(windowId);
}

/** 磁盘上的形状 —— 用宽松类型读，因为要容忍**旧版本**的文件。 */
type StoredViewState = {
  extensions?:ViewState['extensions'];
  userSignature?: string;
  tutorialCardId?:unknown;
  skin?: unknown;
  cardRadius?: number;
  canvasSwapButtons?: boolean;
  canvasDragBindings?: CanvasDragBindings;
  version?: number | undefined;
  windows?: Record<CardId, WindowView> | undefined;
  openWindows?: CardId[] | undefined;
};

export function readViewState(root: string, ops: FsOps = defaultFsOps()): ViewState {
  const path = viewPath(root);
  if (!ops.exists(path)) return emptyViewState();

  const text = ops.readFile(path).trim();
  if (text === '') return emptyViewState();

  const parsed = JSON.parse(text) as StoredViewState;
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(uiText("core/view-state.text003", {arg0: (VIEW_FILE), arg1: (String(parsed.version))}));
  }
  if (parsed.windows === undefined || parsed.windows === null) {
    throw new Error(uiText("core/view-state.text004", {arg0: (VIEW_FILE)}));
  }

  // 【v1 的 `openWindows` 必须丢掉】它的**语义变了**：
  // v1 时代不变量 W 是"等价"（窗口集合 ≡ 未删除的根卡），`persist` 每次改动都把
  // 整个根卡集合记进去，所以那份数据表达的是"**候选**有哪些"，不是"用户真的开着哪些"。
  // 照单恢复会出现"一启动弹出好几扇从没人开过的窗口"（真实工作区上实测到）。
  //
  // 丢掉的代价很小：这个文件本来就"随时可以丢，丢了只是窗口回到默认位置"。
  const trusted = parsed.version === 2 && Array.isArray(parsed.openWindows);

  return {
    version: 2,
    ...(parsed.extensions && typeof parsed.extensions==='object' && !Array.isArray(parsed.extensions)?{extensions:Object.fromEntries(Object.entries(parsed.extensions).filter(([id,value])=>/^[a-z][a-z0-9-]{0,63}$/.test(id) && value && typeof value.installed==='boolean' && typeof value.enabled==='boolean' && value.config && typeof value.config==='object' && !Array.isArray(value.config)))}:{}),
    ...(typeof parsed.userSignature==='string'?{userSignature:parsed.userSignature}:{}),
    ...(typeof parsed.tutorialCardId==='string'?{tutorialCardId:parsed.tutorialCardId}:{}),
    skin:isSkin(parsed.skin)?parsed.skin:'light',
    canvasSwapButtons: parsed.canvasSwapButtons !== false,
    ...(parsed.canvasDragBindings && validCanvasBindings(parsed.canvasDragBindings)?{canvasDragBindings:parsed.canvasDragBindings}:{}),
    cardRadius: typeof parsed.cardRadius === "number" && Number.isFinite(parsed.cardRadius) ? Math.min(MAX_CARD_RADIUS, Math.max(0, parsed.cardRadius)) : DEFAULT_CARD_RADIUS,
    windows: parsed.windows,
    openWindows: trusted ? (parsed.openWindows ?? []) : [],
  };
}

export function writeViewState(root: string, view: ViewState, ops: FsOps = defaultFsOps()): void {
  ops.mkdirp(joinPath(root, KKB_DIR));
  writeAtomic(ops, viewPath(root), `${JSON.stringify(view, null, 2)}\n`);
}
