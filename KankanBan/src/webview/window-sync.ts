/**
 * 写者专用的"**该有哪些卡片窗口**" —— §2.8 W′ 落到真窗口上的那一步。
 *
 * 真实窗口集合是 `view-state.json` 的**结果**，不是它的来源：写者每次算出目标集合，
 * 交给 Rust 的 `sync_card_windows` 去多退少补。于是"开窗 / 关窗 / 上次崩溃留下的残留"
 * 三种情况走同一条路径收敛，前端不需要自己记"上一轮开了哪些"。
 */

import type { CoreState } from '../core/state.ts';
import type { CardId } from '../core/types.ts';
import { MAIN_ID, openWindowSet } from '../core/windows.ts';

/**
 * 目标卡片窗口集合 = `openWindowSet` 去掉两扇不该重复出现的：
 *
 *   - `MAIN_ID`：main 窗口本身就是那一扇，不必再开一扇 `card-000`
 *   - `renderedId`：main 正在**显示**的那张卡 —— 它已经在屏幕上了，
 *     再给它开一扇窗就是"同一张卡两个窗口"。
 *     （`tabs` 语义未定的权宜：定案后 main 渲染 000 的标签页，这一项自然消失，§14 待决 #1）
 */
export function wantedCardWindows(
  state: CoreState,
  openIds: readonly CardId[],
  renderedId: CardId | null,
): CardId[] {
  return openWindowSet(state, openIds).filter((id) => id !== MAIN_ID && id !== renderedId);
}
