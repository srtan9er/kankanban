import {uiText} from '../i18n/text.ts';
/**
 * 条目形状的判定与重写 —— ARCHITECTURE.md §2.4。
 *
 * §2.4 定死两件事：
 *   1. 条目形状由**父卡的 `layout`** 决定，条目自己不带判别字段
 *   2. 加载时必须依据父卡的 `layout` 校验条目，形状不匹配视为数据损坏
 *
 * 于是"改 `layout`"就**必须连带重写子卡条目**，否则下次加载直接报损坏。
 * 把这件事收在这里，是因为它有三个消费者：加载期校验、reducer 的 `layout_change`、
 * 以及操作层的 `setLayout`。
 */

import type { ChildEntry, Layout, OrderedEntry, PlaneEntry, PlainEntry } from './types.ts';

export type EntryKind = 'plain' | 'plane' | 'ordered';

/** 布局 → 条目形态。§2.4.1 那张表的代码形态。 */
export function entryKindOf(layout: Layout): EntryKind {
  if (layout === 'plain') return 'plain';
  if (layout === 'plane') return 'plane';
  // tabs / columns / ordered / grid —— 全部是顺序型
  return 'ordered';
}

/** 条目键集合与形态是否相符。形状不符即数据损坏，**当场吵**。 */
export function assertEntryShape(layout: Layout, entry: ChildEntry, where: string): void {
  const keys = Object.keys(entry).sort();
  const kind = entryKindOf(layout);

  const want = (expected: string): never => {
    throw new Error(
      uiText("core/entries.text001", {arg0: (where), arg1: (layout), arg2: (expected), arg3: (keys.join(','))}),
    );
  };

  if (kind === 'plain') {
    if (keys.length !== 1 || keys[0] !== 'id') want('{ id }');
    return;
  }
  if (kind === 'plane') {
    const expected = ['h', 'id', 'w', 'x', 'y', 'z'];
    if (keys.join(',') !== expected.join(',')) want('{ id, x, y, w, h, z }');
    return;
  }
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'order') want('{ id, order }');
}

export type Placement = { x: number; y: number; w: number; h: number; z: number };

/**
 * 把一批条目重写成某个 `layout` 对应的形状。
 *
 * - 顺序型：`order` 一律按**数组下标**重排（改 layout 等价于"从头排一遍"）
 * - 无布局型：只留 `id`
 * - 坐标型：**必须有坐标** —— 坐标是数据，编不出来。数量对不上也拒绝
 *
 * 【丢数据的情形】`plane → 其它` 会丢掉 x/y/w/h/z。这是有意的：
 * 那些坐标只在平面上有意义，留着反而是形状不符的脏数据。
 * 但**撤销能原样拿回来**，因为 `layout_change` 事件带着改之前的条目（见 §4.1）。
 */
export function reshapeEntries(
  layout: Layout,
  entries: readonly ChildEntry[],
  placements?: readonly Placement[] | undefined,
): ChildEntry[] {
  const kind = entryKindOf(layout);

  if (kind === 'plane') {
    if (placements === undefined) {
      throw new Error(uiText("core/entries.text002", {arg0: (entries.length)}));
    }
    if (placements.length !== entries.length) {
      throw new Error(
        uiText("core/entries.text003", {arg0: (entries.length), arg1: (placements.length)}),
      );
    }
    return entries.map((entry, index) => {
      const spot = placements[index];
      if (spot === undefined) throw new Error(uiText("core/entries.text004", {arg0: (index)}));
      return { id: entry.id, x: spot.x, y: spot.y, w: spot.w, h: spot.h, z: spot.z } satisfies PlaneEntry;
    });
  }

  if (kind === 'plain') {
    return entries.map((entry) => ({ id: entry.id } satisfies PlainEntry));
  }

  return entries.map((entry, index) => ({ id: entry.id, order: index } satisfies OrderedEntry));
}
