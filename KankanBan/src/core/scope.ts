/**
 * 公有与私有 —— ARCHITECTURE.md §2.6。
 *
 * **`scope` 是纯派生函数，不落盘、也没有写入入口。** 文档给的式子就是实现：
 *
 * ```ts
 * function scopeOf(cardId) {
 *   const root = rootAncestorOf(cardId);                    // 深度 0 祖先
 *   return (root === '001' || root === '002') ? 'public' : 'private';
 * }
 * ```
 *
 * 于是"变公有 / 变私有"**完全由树位置决定**（你给的答复："只能靠移动"）：
 * 把卡移到 board / inspiration 子树下就变公有，移回私有树就变私有 ——
 * 没有第三个入口，也就不存在"存了又能被推导出来"的字段。
 */

import { publicRootIds } from './builtins.ts';
import { parentIndexOf } from './indexes.ts';
import type { CoreState } from './state.ts';
import type { CardId } from './types.ts';

export type Scope = 'public' | 'private';

/**
 * 一路往上走到深度 0 祖先。
 *
 * 父链由 `children` 反查（§2.1：`parent` 不落盘）。
 * 遇到环或断链**不抛错**：这条函数会被读路径频繁调用（列表、权限判断），
 * 在那儿因为一棵坏子树整体报错，代价太大。走到头的那张卡就是它自己的根。
 */
export function rootAncestorOf(state: CoreState, cardId: CardId): CardId {
  const parentOf = parentIndexOf(state);
  const seen = new Set<CardId>();

  let cursor = cardId;
  for (;;) {
    const parent = parentOf.get(cursor);
    if (parent === undefined || seen.has(parent)) return cursor;
    seen.add(cursor);
    cursor = parent;
  }
}

export function scopeOf(state: CoreState, cardId: CardId): Scope {
  return publicRootIds().has(rootAncestorOf(state, cardId)) ? 'public' : 'private';
}

/** 从深度 0 祖先到这张卡的路径（含两端）。面包屑之外也用得到。 */
export function pathFromRoot(state: CoreState, cardId: CardId): CardId[] {
  const parentOf = parentIndexOf(state);
  const trail: CardId[] = [cardId];
  const seen = new Set<CardId>([cardId]);

  let cursor = cardId;
  for (;;) {
    const parent = parentOf.get(cursor);
    if (parent === undefined || seen.has(parent)) break;
    seen.add(parent);
    trail.unshift(parent);
    cursor = parent;
  }
  return trail;
}
