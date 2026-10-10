/**
 * 从 `children` 反查出来的派生索引（ARCHITECTURE.md §2.1）。
 *
 * `parent` **不落盘** —— 它是加载时构建的内存索引，只用于 O(1) 反查。
 * 之所以单独一个模块：视图模型、段落（scope）、窗口集合都要它，
 * 而它们互相之间不该有依赖关系。
 */

import type { CoreState } from './state.ts';
import type { CardId, ChildEntry } from './types.ts';

/** 子卡 id → 父卡 id。 */
export function parentIndexOf(state: CoreState): Map<CardId, CardId> {
  const parentOf = new Map<CardId, CardId>();
  for (const [parentId, list] of state.children) {
    for (const entry of list) parentOf.set(entry.id, parentId);
  }
  return parentOf;
}

/** 某张卡在父卡 children 里的下标与条目；根卡返回 `undefined`。 */
export function locateEntry(
  state: CoreState,
  cardId: CardId,
): { parentId: CardId; index: number; entry: ChildEntry } | undefined {
  for (const [parentId, list] of state.children) {
    const index = list.findIndex((entry) => entry.id === cardId);
    if (index >= 0) {
      const entry = list[index];
      if (entry !== undefined) return { parentId, index, entry };
    }
  }
  return undefined;
}

/** `candidateId` 是否在 `rootId` 的子树里（含自身）。 */
export function isInSubtree(state: CoreState, rootId: CardId, candidateId: CardId): boolean {
  if (rootId === candidateId) return true;

  const stack: CardId[] = [rootId];
  const seen = new Set<CardId>();
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    if (seen.has(id)) continue;
    seen.add(id);

    for (const entry of state.children.get(id) ?? []) {
      if (entry.id === candidateId) return true;
      stack.push(entry.id);
    }
  }
  return false;
}
