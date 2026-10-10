/**
 * 事件重放（ARCHITECTURE.md §4.3 断言一：`replay(空, events) === 当前状态`）。
 */

import { applyEvent, emptyState, type CoreState } from './state.ts';
import type { CardEvent } from './types.ts';

/**
 * 从空状态出发把事件依次应用一遍。
 *
 * 它和实时编辑**必须**走同一个 `applyEvent`；一旦两边分家，
 * "重放一致性"就退化成两条代码互相看齐，那正是 §4.1 想避免的静默错误。
 */
export function replay(events: readonly CardEvent[]): CoreState {
  return events.reduce(applyEvent, emptyState());
}
