import {uiText} from '../i18n/text.ts';
/**
 * 视图模型 —— 把"状态 + 视图状态 + 聚焦 id"折成**可以直接渲染**的形状。
 *
 * 这一层是纯函数、不碰 React、不碰 DOM（§9.1 硬约束）。理由：§10 阶段一·五要压的正是
 * "`type` 分派、面包屑、折叠态、`ChildEntry` 多形状"这些**模型**问题，
 * 它们必须能在命令行里验完，不能等到有窗口了才发现不对。
 */

import type { CoreState } from './state.ts';
import type { CardId, ChildEntry, Layout, OrderedEntry } from './types.ts';
import { rendererOf } from './renderer.ts';
import { isInSubtree, parentIndexOf } from './indexes.ts';
import {
  REGIONS,
  windowViewFor,
  type Region,
  type ViewState,
  type WindowView,
} from './view-state.ts';

/** §3.1 board 与 inspiration 不显示正文。 */
const CONTENT_HIDDEN: ReadonlySet<Layout> = new Set<Layout>(['columns', 'plane', 'grid', 'library']);

export type CardSummary = { id: CardId; title: string; layout: Layout; deleted: boolean };

/**
 * §3.6 的视觉区分：**预制体卡片内部发蓝光；由预制体实例化的卡片外圈发蓝光。**
 *
 * 两者都由已有字段直接推出（§2.3：`isPrefab`、`prefabRef`），不需要额外存储。
 */
export type Glow = 'prefab' | 'instance' | null;

/**
 * 一张卡该发哪种光。
 *
 * **`isPrefab` 优先于 `prefabRef`**：一张卡可以既是预制体又是别人的实例
 * （预制体里嵌预制体），那时"我是预制体"是更强的身份，按内发光处理。
 */
export function glowOf(fields: { isPrefab: boolean; prefabRef: CardId | null }): Glow {
  if (fields.isPrefab) return 'prefab';
  if (fields.prefabRef !== null) return 'instance';
  return null;
}

export type RenderedChild = CardSummary & {
  entry: ChildEntry;
  /** §3.2 看板列内 / 子卡区一律是紧凑形态 */
  form: 'compact';
  hasChildren: boolean;
  /** §3.6 预制体 / 实例的发光标记 */
  glow: Glow;
};

/** §2.5.1 board 的跨一层投影：列头是列卡的标题，列体是列卡的子卡。 */
export type ColumnProjection = { columnId: CardId; header: string; cards: RenderedChild[] };

/** §3.1：子卡区的三种排布。 */
export type ChildrenMode = 'row' | 'grid' | 'plane';

/**
 * 子卡区怎么排，由**这张卡的渲染器**决定（§3.1）：
 *
 * | 渲染器 | 排布 | 出处 |
 * |---|---|---|
 * | `grid` | 格子 | §2.2 prefabs「纯格子排列」 |
 * | `plane` | 二维无限 | §2.2 inspiration「二维无限」 |
 * | 其余 | 底部横排 | §3.1 默认 |
 */
export function childrenModeOf(renderer: Layout): ChildrenMode {
  if (renderer === 'grid' || renderer === 'library') return 'grid';
  if (renderer === 'plane') return 'plane';
  return 'row';
}

export type CardView = {
  id: CardId;
  title: string;
  /** §2.5 分派结果：用哪个渲染器 */
  renderer: Layout;
  /** §3.1 子卡区的排布方式（由 `renderer` 推出） */
  childrenMode: ChildrenMode;
  /** §3.6 这张卡自己的发光标记 */
  glow: Glow;
  form: 'full' | 'compact';
  /** §3.4 面包屑：窗口根卡 → 聚焦卡 */
  breadcrumb: CardSummary[];
  focusId: CardId;
  /** §3.1 board 与 inspiration 不显示正文 */
  contentShown: boolean;
  content: string;
  regions: Record<Region, { size: number; collapsed: boolean }>;
  /** 直接子卡，已按 `order` 排好（不变量 O 保证 == 数组顺序） */
  children: RenderedChild[];
  /** renderer === 'columns' 时才有：跨一层投影的结果 */
  columns: ColumnProjection[] | null;
};

/**
 * 渲染分派本身搬到 `src/core/renderer.ts` 了 —— 操作层也要用它判断"目标是不是看板"，
 * 而操作层 import 视图层是层次倒置。这里转出一次，保持既有调用方不用改。
 */
export { rendererOf };

/** 子卡条目，按 `order` 升序（顺序型）／原样保留（坐标型、无布局型）。 */
export function orderedChildren(state: CoreState, parentId: CardId): ChildEntry[] {
  const list = [...(state.children.get(parentId) ?? [])];
  if (!list.every((entry) => 'order' in entry)) return list;
  return list.sort((a, b) => (a as OrderedEntry).order - (b as OrderedEntry).order);
}

/** 从窗口根卡到 `focusId` 的路径（含两端）。不在本窗口子树里就只给根卡。 */
export function breadcrumbTo(state: CoreState, windowId: CardId, focusId: CardId): CardSummary[] {
  const path: CardId[] = [];

  const walk = (id: CardId): boolean => {
    path.push(id);
    if (id === focusId) return true;
    for (const entry of orderedChildren(state, id)) {
      if (walk(entry.id)) return true;
    }
    path.pop();
    return false;
  };

  if (!walk(windowId)) return [summaryOf(state, windowId)];
  return path.map((id) => summaryOf(state, id));
}

/**
 * 把请求的聚焦 id 解成一个**活着的、且在本窗口子树里的**卡：
 * 卡被删了、不见了、或属于别的窗口，都退回本窗口的根卡。
 *
 * §3.4 的面包屑是"当前窗口的根路径"，所以聚焦必须落在本窗口里 —— 否则面包屑无意义。
 */
export function resolveFocus(state: CoreState, windowId: CardId, requested: CardId): CardId {
  const parentOf = parentIndexOf(state);
  const seen = new Set<CardId>();

  let cursor: CardId | undefined = requested;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);

    const card = state.cards.get(cursor);
    if (card !== undefined && !card.deleted) {
      if (cursor === windowId || isInSubtree(state, windowId, cursor)) return cursor;
      // 活着的卡，但不属于这个窗口 —— 焦点不属于这里，退回根卡。
      return windowId;
    }
    // 已删或不存在：往最近的活祖先上走。软删会把整棵子树的 children 摘掉，
    // 所以这里通常一步就走到 undefined，然后退回根卡。
    cursor = parentOf.get(cursor);
  }

  return windowId;
}

export function viewOf(
  state: CoreState,
  view: ViewState,
  windowId: CardId,
  focusId?: CardId,
): CardView | null {
  // 刻意不叫 `window`：这个名字在 webview 里是 DOM 全局，遮蔽它既容易误读，
  // 也会污染"core 不碰 DOM"那条静态检查的证据。
  const windowView: WindowView = windowViewFor(view, windowId);
  const focus = resolveFocus(state, windowId, focusId ?? windowView.focusId);

  const fields = state.cards.get(focus);
  if (fields === undefined) {
    // 窗口的根卡已经不存在了。`resolveFocus` 在"整棵子树都没了"时会退回 windowId，
    // 而那张卡也已经不在 —— 例如把"建卡"这一步撤销掉了。
    //
    // 按 §2.8 不变量 W，**根卡没了窗口本身就不该存在**，平台层应当关掉它。
    // 在那个机制做好之前，这里返回 `null` 让界面显示空态，
    // 而不是抛错把整次渲染打断（实测就是这里把界面炸掉的）。
    return null;
  }

  const renderer = rendererOf(state, focus);
  const children = orderedChildren(state, focus).map((entry) => renderedChild(state, entry));

  // §2.5.1 跨一层投影：board 自己与列卡的正文都不渲染，铺出来的是孙卡。
  const columns: ColumnProjection[] | null =
    renderer === 'columns'
      ? children.map((column) => ({
          columnId: column.id,
          header: column.title,
          cards: orderedChildren(state, column.id).map((entry) => renderedChild(state, entry)),
        }))
      : null;

  const regions = {} as Record<Region, { size: number; collapsed: boolean }>;
  for (const region of REGIONS) {
    regions[region] = {
      size: windowView.regions[region],
      collapsed: windowView.collapsed[region],
    };
  }

  return {
    id: focus,
    title: fields.title,
    renderer,
    childrenMode: childrenModeOf(renderer),
    glow: glowOf(fields),
    // 聚焦到的那张卡永远是完整形态；子卡一律紧凑（§3.2）。
    form: 'full',
    breadcrumb: breadcrumbTo(state, windowId, focus),
    focusId: focus,
    contentShown: !CONTENT_HIDDEN.has(renderer),
    content: fields.content,
    regions,
    children,
    columns,
  };
}

// ── 内部 ───────────────────────────────────────────────────────────────────────

function summaryOf(state: CoreState, cardId: CardId): CardSummary {
  const fields = state.cards.get(cardId);
  if (fields === undefined) throw new Error(uiText("core/view-model.text001", {arg0: (cardId)}));
  return { id: fields.id, title: fields.title, layout: fields.layout, deleted: fields.deleted };
}

function renderedChild(state: CoreState, entry: ChildEntry): RenderedChild {
  const fields = state.cards.get(entry.id);
  if (fields === undefined) throw new Error(uiText("core/view-model.text001", {arg0: (entry.id)}));

  return {
    id: fields.id,
    title: fields.title,
    layout: fields.layout,
    deleted: fields.deleted,
    entry,
    form: 'compact',
    // 有子卡要标出来（§3.3 像文件管理器：只列直接子项，点进去才看到里面）
    hasChildren: (state.children.get(entry.id)?.length ?? 0) > 0,
    glow: glowOf(fields),
  };
}

/** 由 children 反查出的父索引与子树判定都搬到 `indexes.ts` 了 —— 视图模型、段落、窗口集合共用一份。 */
