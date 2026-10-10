import {uiText} from '../i18n/text.ts';
/**
 * 子树收集与快照比对（ARCHITECTURE.md §2.7 软删除、§4.1 card_delete）。
 *
 * `card_delete` 要携带整棵子树快照以支持撤销。快照由**操作层**构造、由**重放器**核对，
 * 两边都不能偷懒：只要快照与实际子树不一致，就说明数据已经坏了，宁可在重放时当场炸掉。
 */

import type { CoreState } from './state.ts';
import type { CardFields, CardId, ChildEntry, SubtreeSnapshot } from './types.ts';

export type SubtreeWalk = {
  snapshot: SubtreeSnapshot;
  /** 子树内所有卡片的 id（含根） */
  ids: CardId[];
};

/**
 * 从 `rootId` 出发收集整棵子树。
 *
 * 会检测两类损坏并抛错：
 *   - `children` 指向不存在的卡
 *   - 同一张卡在子树里出现两次（说明共有/成环，不是森林）
 */
export function collectSubtree(state: CoreState, rootId: CardId): SubtreeWalk {
  const root = state.cards.get(rootId);
  if (root === undefined) {
    throw new Error(uiText("core/subtree.text001", {arg0: (rootId)}));
  }

  const cards: Record<CardId, CardFields> = {};
  const children: Record<CardId, ChildEntry[]> = {};
  const ids: CardId[] = [];
  const seen = new Set<CardId>();

  const stack: CardId[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;

    if (seen.has(id)) {
      throw new Error(uiText("core/subtree.text002", {arg0: (id)}));
    }
    seen.add(id);

    const fields = state.cards.get(id);
    if (fields === undefined) {
      throw new Error(uiText("core/subtree.text003", {arg0: (id)}));
    }

    cards[id] = fields;
    ids.push(id);

    // 快照里的 `children` **逐字复制状态的形状**（稀疏：有键 ⟺ 至少一个子卡），
    // 不做补空数组。补空会让撤销多出空壳，使 §4.3 断言二在形状上分叉。
    const list = state.children.get(id);
    if (list !== undefined) {
      const copy = [...list];
      children[id] = copy;
      for (const entry of copy) stack.push(entry.id);
    }
  }

  return { snapshot: { fields: root, cards, children }, ids };
}

/**
 * 稳定序列化：对象键**递归排序**后输出 JSON。
 *
 * 用于比对两份结构是否等价 —— 直接 `JSON.stringify` 会因为键的插入顺序不同而假报不等，
 * 而键顺序在这里没有任何语义。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/**
 * 状态的**内容指纹** —— 只覆盖树（卡片字段 + `children`），**刻意不含 `lastAppliedSeq`**。
 *
 * 用途是比对两份状态是否等价（`check` 的"不变量 U"：`replay(空, events)` ≡ 当前状态）。
 *
 * 【为什么不带 seq】撤销是"状态级逆运算 + 截断日志"（§4.4）：`undoEvent` 把状态滚回去，
 * 但 `lastAppliedSeq` 会停在**被撤销的那条事件**上，而日志里已经没有它了。
 * 把 seq 一起比，每一次正常的撤销都会被判成"重放不一致" —— 那是个假警报，
 * 比没有检查更坏（人会开始忽略它）。
 *
 * 【为什么不能直接 stringify】`state` 里是 `Map`，而 `JSON.stringify(new Map())` 是 `{}` ——
 * 直接比会把两张不同的树判成相同。所以先摊平成**按 id 排序**的数组。
 */
export function stateFingerprint(state: CoreState): string {
  const byId = (a: readonly [string, unknown], b: readonly [string, unknown]): number =>
    a[0] < b[0] ? -1 : 1;

  return stableStringify({
    cards: [...state.cards.entries()].sort(byId),
    children: [...state.children.entries()]
      .map(([id, list]) => [id, list] as const)
      .sort(byId),
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      // Legacy card snapshots omit the optional sync baseline; null means the same thing.
      if ((key === 'prefabBase' || key === 'doodle') && src[key] == null) continue;
      out[key] = canonical(src[key]);
    }
    return out;
  }
  return value;
}

/**
 * 快照必须与真实子树逐字段等价，否则是数据损坏。
 *
 * 【两个字段要归一化掉】`deleted` 与 `updatedAt` —— 理由其实是同一个，
 * 都来自"`writeState` 先写卡片文件、最后才写 tree.json"这条写入顺序：
 *
 *   - `deleted`：崩在中间时卡片**已经**带上 `deleted: true`，而结构文件还停在删除前
 *   - `updatedAt`：它是**派生**的（= 指向这张卡的最后一条事件的时间，见 `state.ts`），
 *     删除事件本身就会把"删除那一刻"写进卡片文件，而快照按定义记的是删除前的值
 *
 * 两种情况下卡片文件都会**领先于**结构文件。按字面比对就会把一次
 * **正常的崩溃恢复**判成数据损坏 —— 所以必须抹平成定值，重放对"部分写入"才幂等。
 *
 * `updatedAt` 还多一层理由：它完全由事件日志推出来，**不是独立证据**。
 * 拿它做一致性检查证明不了任何东西，只会制造假警报。
 */
export function assertSnapshotMatches(walk: SubtreeWalk, claimed: SubtreeSnapshot, rootId: CardId): void {
  const left = stableStringify(asComparableView(walk.snapshot));
  const right = stableStringify(asComparableView(claimed));
  if (left !== right) {
    throw new Error(uiText("core/subtree.text004", {arg0: (rootId)}));
  }
}

/** 投影成"可比视图"：`deleted` 与 `updatedAt` 抹成定值，其余字段逐字照比。 */
function asComparableView(snapshot: SubtreeSnapshot): SubtreeSnapshot {
  const cards: Record<CardId, CardFields> = {};
  const normalize = (fields: CardFields): CardFields => ({ ...fields, deleted: false, updatedAt: 0 });
  for (const [id, fields] of Object.entries(snapshot.cards)) {
    cards[id] = normalize(fields);
  }
  return { fields: normalize(snapshot.fields), cards, children: snapshot.children };
}
