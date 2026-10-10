import {uiText} from '../i18n/text.ts';
/** Current window eligibility: all live cards can be expanded on the desktop.
 * Expanded windows preserve tree locations; desktopCards still means tree roots.
 * Historical W-prime notes below describe ordinary cards.
 */
/**
 * 窗口集合 —— ARCHITECTURE.md §2.8 的**不变量 W′**、§10 阶段二的验收标准。
 *
 * v7 修订（用户定案：「**关闭卡片不影响任何结构！可以在 main 中重新打开！**」）：
 *
 * ```
 * openWindows ⊆ desktopCards(state)     desktopCards = { card | parent === null ∧ ¬deleted }
 * 桌面卡片里有 main 时，openWindows 必须含 main
 * ```
 *
 * v6 的旧 W 是**等价**（窗口集合 ≡ 未删除的根卡），那意味着"关窗"只能靠改树实现 ——
 * 而用户要的是"关掉窗口、卡还在"。所以权威拆成两半：
 *
 *   - 树（`desktopCards`）说"这张卡**能不能**有窗口"：有父卡就不能，因为窗口 id 就是根卡 id
 *   - `view-state.json` 的 `openWindows` 说"它**现在**有没有窗口"
 *
 * 旧 W 的两条推论因此一条保留、一条改掉：
 *
 *   - 把根卡拖进容器 → 它有了父 → **仍然必然**从窗口集合里消失（子集关系自动滤掉）
 *   - 把子卡浮动到桌面 → 它成为桌面卡片，但**不再自动开窗**
 *     —— 要显式「提出到屏幕窗口」，见 §2.8 的"候选 ≠ 已开"
 *
 * `windowTransition` 只负责把"前后差集"算出来给平台层去开/关真窗口。
 * 这一层不碰 React、不碰 DOM、也不碰 Tauri —— 所以能在命令行里验完（§9.1）。
 */

import type { CoreState } from './state.ts';
import type { CardId } from './types.ts';

/** §7.1：强制存在的主控板窗口。它也是单写者方案（§14）里唯一的写者。 */
export const MAIN_ID: CardId = '000';

/**
 * **桌面卡片**：有窗口资格的卡（= 未删除的根卡），按 id 排序以保证结果稳定。
 *
 * 排序是刻意的：窗口集合会被拿去与前后状态做差集，
 * 不排序的话同一个集合会产出不同的数组，diff 出来一堆假变化。
 *
 * 注意它只是**候选**，不是"现在开着哪些" —— 后者见 `openWindowSet`。
 */
export function desktopCards(state: CoreState): CardId[] {
  const childIds = new Set<CardId>();
  for (const list of state.children.values()) {
    for (const entry of list) childIds.add(entry.id);
  }

  return [...state.cards.values()]
    .filter((card) => !card.deleted && !childIds.has(card.id))
    .map((card) => card.id)
    .sort();
}

/** Desktop expansions represent cards independently of their tree position. */
export function windowCards(state: CoreState): CardId[] {
  return [...state.cards.values()].filter(card=>!card.deleted).map(card=>card.id).sort();
}

/**
 * **现在真的有窗口的那些卡** —— W′ 的左手边。
 *
 * 两件事一起做：
 *   1. 把 `remembered`（`view-state.json` 记的"上次开着哪些"）**与桌面卡片求交** ——
 *      被拖进容器或已删除的卡自动失效，不需要另写判断，也不会"复活"一个不该有的窗口
 *   2. main 强制在结果里 —— 它是门面（§7.1），也是唯一写者（§14）
 *
 * 于是"关窗"不需要任何额外机制：把它从 `remembered` 里去掉即可，树一动不动。
 */
export function openWindowSet(state: CoreState, remembered: readonly CardId[]): CardId[] {
  const live = new Set(windowCards(state));
  const open = new Set([...new Set(remembered)].filter((id) => live.has(id)));

  if (live.has(MAIN_ID)) open.add(MAIN_ID);

  return [...open].sort();
}

/**
 * §7.3：这次启动该打开哪些窗口。
 *
 * ```
 * 总是打开 main（000）；其余按 view-state 记下的集合恢复；
 * 恢复时校验 —— 那些卡若已经 parent !== null（被拖进容器），就不恢复。
 * ```
 *
 * 校验直接落在 `desktopCards` 上：它已经是"未删除的根卡"，
 * 所以"被拖进容器"与"已删除"两种失效情形**自动被过滤掉**，不需要另写判断。
 *
 * `restore: false`（设置里关掉恢复）时只开 main。
 */
export function restorableWindows(
  state: CoreState,
  remembered: readonly CardId[],
  options: { restore?: boolean | undefined; mainId?: CardId | undefined } = {},
): CardId[] {
  if (options.restore === false) {
    const live = new Set(windowCards(state));
    const main = options.mainId ?? MAIN_ID;
    return live.has(main) ? [main] : [];
  }
  return openWindowSet(state, remembered);
}

export type WindowTransition = {
  /** 需要新建的窗口 */
  opened: CardId[];
  /** 需要关闭的窗口 */
  closed: CardId[];
};

/** 两次状态之间的窗口增减。 */
export function windowTransition(before: readonly CardId[], after: readonly CardId[]): WindowTransition {
  const wasOpen = new Set(before);
  const nowOpen = new Set(after);

  return {
    opened: after.filter((id) => !wasOpen.has(id)),
    closed: before.filter((id) => !nowOpen.has(id)),
  };
}

/**
 * 校验不变量 W′。
 *
 * 传了 `open` 就连"开着的窗口必须是桌面卡片、且不丢 main"一起验；不传则只验树那一半
 * （热路径上很多调用点没有视图状态，不需要为它们硬凑一个）。
 *
 * 与 `workspace-io` 的加载期校验有重叠，但**角度不同**：那边防的是磁盘上的坏数据，
 * 这边防的是"core 自己算错了"。所以两处都要有 —— 一条不变量只在入口校验，
 * 中间被写坏就没人管了。
 */
export function assertInvariantW(
  state: CoreState,
  context = uiText("core/windows.text001"),
  open?: readonly CardId[] | undefined,
): void {
  const childIds = new Set<CardId>();

  for (const [parentId, list] of state.children) {
    const parent = state.cards.get(parentId);
    if (parent === undefined) {
      throw new Error(uiText("core/windows.text002", {arg0: (context), arg1: (parentId)}));
    }
    if (parent.deleted) {
      throw new Error(uiText("core/windows.text003", {arg0: (context), arg1: (parentId)}));
    }

    for (const entry of list) {
      const child = state.cards.get(entry.id);
      if (child === undefined) {
        throw new Error(uiText("core/windows.text004", {arg0: (context), arg1: (entry.id), arg2: (parentId)}));
      }
      if (child.deleted) {
        throw new Error(uiText("core/windows.text005", {arg0: (context), arg1: (entry.id), arg2: (parentId)}));
      }
      if (childIds.has(entry.id)) {
        throw new Error(uiText("core/windows.text006", {arg0: (context), arg1: (entry.id)}));
      }
      childIds.add(entry.id);
    }
  }

  if (open === undefined) return;

  const desktop = new Set(windowCards(state));
  for (const id of open) {
    if (!desktop.has(id)) {
      throw new Error(uiText("core/windows.text007", {arg0: (context), arg1: (id)}));
    }
  }

  if (desktop.has(MAIN_ID) && !open.includes(MAIN_ID)) {
    throw new Error(uiText("core/windows.text008", {arg0: (context)}));
  }
}
