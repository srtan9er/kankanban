/**
 * 启动决策 —— 从 `main.tsx` 抽出来的**纯函数**。
 *
 * 抽出来是为了能测：原来这段逻辑内联在 `boot()` 里，而那个函数一上来就 `createRoot`，
 * 于是"第一次打开该播示例吗、先挂哪个窗口"这两件事从来没被任何断言覆盖过。
 *
 * 注意它**只做决策，不做副作用**：真正建卡/落盘仍在入口里。
 */

import { BUILTIN_CARDS } from '../core/builtins.ts';
import type { CoreState } from '../core/state.ts';
import type { CardId } from '../core/types.ts';
import { desktopCards, MAIN_ID, restorableWindows } from '../core/windows.ts';
import type { WindowRole } from './window-role.ts';

export type BootPlan = {
  /** 要不要建一张最初的卡（第一次打开时给点东西看） */
  seedDemo: boolean;
  /**
   * 单窗口阶段先把界面挂在哪张卡上。
   *
   * `null` 有两种含义，由 `seedDemo` 区分：
   *   - `seedDemo: true` —— 卡还没建，等建完才知道 id，调用方自己填
   *   - `seedDemo: false` —— 一张可用的根卡都没有
   */
  windowId: CardId | null;
};

/**
 * 决定启动时做什么。
 *
 * **"空工作区"的判据是"除了内置卡，一张用户卡都没有"**。
 *
 * 原来那句判据是"看板（001）还没有列"，在**单卡示例之前**它等价于"没播过示例"
 * （示例会在 001 里建列）。改成只建一张普通卡之后这个等价关系断了：
 * 示例永远不建列，于是"看板没有列"永远为真 —— **每次启动都会再播一遍示例**。
 * 真实工作区上实测到了这一点（两次启动后出现两张"第一张卡"）。
 *
 * 【`role` 默认是写者】多窗口落地后新增：卡片窗口（`card-{id}`）只渲染它自己那张卡，
 * 既不建示例也不同步窗口集合 —— 同步真窗口是**写者**的职责（§14 方案 A）。
 * 默认值让旧调用点（单窗口语境）继续成立。
 */
export function planBoot(
  state: CoreState,
  rememberedWindows: readonly CardId[],
  role: WindowRole = { kind: 'main' },
): BootPlan {
  // 镜像窗口：我是谁由标签决定，不需要任何决策
  if (role.kind === 'card') {
    return { seedDemo: false, windowId: role.cardId };
  }

  const builtinIds = new Set(BUILTIN_CARDS.map((card) => card.id));
  const hasUserCards = [...state.cards.values()].some(
    (card) => !card.deleted && !builtinIds.has(card.id),
  );
  if (!hasUserCards) {
    // 空工作区：调用方会建一张卡，窗口 id 到那时才确定
    return { seedDemo: true, windowId: null };
  }

  const restorable = restorableWindows(state, rememberedWindows);
  const rememberedOther = restorable.filter((id) => id !== MAIN_ID);
  if (rememberedOther.length > 0) {
    return { seedDemo: false, windowId: rememberedOther[0] ?? null };
  }

  // 【单窗口的权宜】恢复集合里只有 main —— 首次启动（什么都没记）就是这样。
  //
  // §7.3 说"启动总是打开 main"，那是在**多窗口**语境下的：main 是其中之一，另外几扇
  // 按 view-state 恢复。可现在只有一扇窗口，而 `tabs` 的呈现语义仍未定（§14），
  // main 会渲染成一张**空白卡** —— 用户看到的就是"这应用坏了"。
  //
  // 所以退而挑一张当前存在的非 main 根卡，**优先用户自己的卡**（内置卡此刻都是空壳，
  // 按 id 排序它们还会排在前面，先显示看板等于显示一块白板）。
  // 这不是"不开 main"，而是"单窗口时先展示哪个"。
  const otherRoots = desktopCards(state).filter((id) => id !== MAIN_ID);
  const userRoot = otherRoots.find((id) => !builtinIds.has(id));
  return { seedDemo: false, windowId: userRoot ?? otherRoots[0] ?? restorable[0] ?? null };
}

/** 内置卡是否齐全 —— 入口用它做一次自检，缺了就说明工作区初始化没跑对。 */
export function missingBuiltins(state: CoreState): CardId[] {
  return BUILTIN_CARDS.filter((card) => !state.cards.has(card.id)).map((card) => card.id);
}
