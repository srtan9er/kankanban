import {discardLegacyInk} from './drawing.ts';
import {uiText} from '../i18n/text.ts';
/**
 * core 操作层 —— ARCHITECTURE.md §9.1 的"唯一权威操作层"。
 *
 * 这是 UI 与 MCP **共享**的那一层。约束（§9.1 硬约束）：
 * **不得 import React，也不得依赖任何浏览器/DOM 全局。**
 *
 * 每次操作**立刻落盘**（一条操作 = 一条事件 = 一次 commit）。理由：§4.2 的 WAL 承诺是
 * "事件一旦落盘，重启后一定被重做到文件里"，批量攒着会把这个承诺变成"可能丢最后几条"。
 */

import { defaultNewId } from './ids.ts';

import { replay } from './replay.ts';
import { applyEvent, materializeUpdatedAt, type CoreState } from './state.ts';
import { collectSubtree, stableStringify } from './subtree.ts';
import { defaultFsOps, type FsOps } from './storage/fs-ops.ts';
import { ensureGitignoreEntry } from './storage/gitignore.ts';
import { KKB_DIR, appendEvents, openWorkspace, rewriteLog, writeState } from './storage/workspace-io.ts';
import { undoEvent } from './undo.ts';
import type { CardEvent, CardFields, CardId, ChildEntry, FieldPath, Layout } from './types.ts';
import { joinPath } from './paths.ts';
import { locateEntry, isInSubtree } from './indexes.ts';
import { BUILTIN_CARDS, isDeletable } from './builtins.ts';
import { reshapeEntries, type Placement } from './entries.ts';
import { isBoard } from './renderer.ts';
import { scopeOf, type Scope } from './scope.ts';
import { assertInvariantW, desktopCards } from './windows.ts';

export type Session = {
  /** Internal compound-action staging; never serialized. */
  staging?:boolean;
  root: string;
  state: CoreState;
  /** 当前有效的事件序列（撤销会把末尾一条去掉） */
  events: CardEvent[];
  clientId: string;
  clock: () => number;
  newId: () => string;
  ops: FsOps;
};

export type SessionOptions = {
  clientId?: string;
  ops?: FsOps;
  clock?: () => number;
  newId?: () => string;
  /**
   * 是否确保四张内置卡存在（§2.2「强制存在」）。**默认 `true`**。
   *
   * 只有一种情况该关掉：想构造一棵**最小树**来测 core 本身的机制
   * （那时四张内置卡只是噪音）。真实入口一律不传，于是"工作区里一定有内置卡"成立。
   */
  builtins?: boolean | undefined;
};

export type PlanePlacement = { x: number; y: number; w: number; h: number; z: number };

export type CreateCardSpec = {
  doodle?:CardFields['doodle'];
  parentId: CardId | null;
  title?: string | undefined;
  /** 显式指定 id（内置卡 000–003 与导入场景需要）；省略则自动生成 */
  id?: CardId | undefined;
  // 显式带上 `| undefined`：`exactOptionalPropertyTypes` 下"不传"与"传 undefined"是两回事，
  // 而工具层是程序化拼装参数的，必须允许后者。
  content?: string | undefined;
  layout?: Layout | undefined;
  type?: CardId | null | undefined;
  isPrefab?: boolean | undefined;
  /** 父卡是 plane 布局时必填 */
  plane?: PlanePlacement | undefined;
};

// ── 会话 ───────────────────────────────────────────────────────────────────────

/**
 * 打开工作区；`.kkb` 不存在时**就地创建**（空树 + 空日志）。
 *
 * 增量恢复走的是 `openWorkspace`：读 tree.json 与 cards/，再重放 `seq > lastAppliedSeq`
 * 的尾部事件。所以"文件是被谁改坏的"不影响这里 —— 磁盘即权威。
 */
export function openSession(root: string, options: SessionOptions = {}): Session {
  const ops = options.ops ?? defaultFsOps();
  // 在写任何东西之前先判断"是不是全新工作区" —— 只有全新时才去碰 .gitignore，
  // 免得每次开会话都去读一遍、也免得覆盖用户后续的手动修改。
  const brandNew = !ops.exists(joinPath(root, KKB_DIR, 'tree.json')) && !ops.exists(joinPath(root, KKB_DIR, 'events.jsonl'));

  const { state, events, droppedTailLines } = openWorkspace(root, ops);
  if (droppedTailLines > 0) rewriteLog(root, events, ops);

  const session: Session = {
    root,
    state,
    events,
    clientId: options.clientId ?? 'local',
    clock: options.clock ?? (() => Date.now()),
    newId: options.newId ?? defaultNewId,
    ops,
  };

  // 空工作区：立刻把空树与空日志落到磁盘，让目录结构完整可读。
  if (events.length === 0 && state.cards.size === 0) writeState(root, state, ops);

  // §2.2「强制存在」：四张内置卡必须在。默认开，测试可以关掉来构造最小树。
  if (options.builtins !== false) {
    ensureBuiltins(session);
    transact(session,s=>{for(const card of s.state.cards.values()){if(card.deleted)continue;const content=discardLegacyInk(card.content);if(content!==card.content)setField(s,card.id,'/content',content);}});
  }

  // §8：`.kkb` 默认进 .gitignore。只在全新工作区做一次。
  if (brandNew) ensureGitignoreEntry(root, ops);

  return session;
}

/**
 * 确保四张内置卡存在 —— ARCHITECTURE.md §2.2「强制存在」。
 *
 * 用**普通事件**创建（`card_create` + 固定 id），不做任何"内置卡另存一处"的特殊处理：
 * 它们就是普通卡片，因此照样进日志、照样能被 `replay` 重建、照样走同一套落盘路径（§9.1）。
 *
 * 返回本次**新建**了哪些（已经存在的不动），方便调用方与测试判断。
 */
export function ensureBuiltins(session: Session): CardId[] {
  const created: CardId[] = [];

  for (const builtin of BUILTIN_CARDS) {
    // 已经存在就跳过。软删的内置卡理论上不该出现（§2.7 禁止删内置卡），
    // 真出现了也**不在这里偷偷复活** —— 那属于修复动作，不该混在"确保存在"里。
    if (session.state.cards.has(builtin.id)) {
      const existing=session.state.cards.get(builtin.id)!;
      // The old prefab-library grid and the new mode use the same ordered entries.
      if(builtin.id==='003' && !existing.deleted && existing.layout==='grid')setLayout(session,builtin.id,'library');
      continue;
    }

    createCard(session, {
      id: builtin.id,
      parentId: null,
      title: uiText(builtin.id==='000'?'app.builtinMain':builtin.id==='001'?'app.builtinBoard':builtin.id==='002'?'app.builtinInspiration':'app.builtinPrefabs'),
      layout: builtin.layout,
    });
    created.push(builtin.id);
  }

  return created;
}

// ── 条目形状（§2.4.1） ─────────────────────────────────────────────────────────

/** 把 `layout` 映射成条目形状。形状由**父卡的 layout** 决定，条目自己不带判别字段。 */
export function entryFor(layout: Layout, id: CardId, order: number, plane?: PlanePlacement): ChildEntry {
  switch (layout) {
    case 'plain':
      return { id };
    case 'plane':
      if (plane === undefined) {
        // 编一个默认坐标会让"卡跑到了我没放的地方"，不如直接拒绝。
        throw new Error(uiText("core/workspace.text001", {arg0: (id)}));
      }
      return { id, x: plane.x, y: plane.y, w: plane.w, h: plane.h, z: plane.z };
    default:
      // tabs / columns / ordered / grid —— 全部是顺序型
      return { id, order };
  }
}

// ── 写操作 ─────────────────────────────────────────────────────────────────────

export function createCard(session: Session, spec: CreateCardSpec): CardId {
  if (spec.parentId !== null && isBoard(session.state, spec.parentId) && childList(session.state, spec.parentId).length >= 3) {
    throw new Error(uiText("core/workspace.text002"));
  }
  const id = spec.id ?? session.newId();
  if (session.state.cards.has(id)) {
    throw new Error(uiText("core/workspace.text003", {arg0: (id)}));
  }

  // 【时钟只读一次】事件的 `timestamp` 就是"这一刻"，`createdAt` 取自它。
  // 读两次会拿到两个值，新建的卡一出生就是 `updatedAt > createdAt` ——
  // 而 `updatedAt` 的定义正是"指向它的最后一条事件的时间"（见 state.ts），
  // 建卡那条事件就是它唯一的事件，两者必须完全相等。
  const env = envelope(session, id);

  const fields: CardFields = {
    id,
    title: spec.title ?? uiText("app.newCardTitle", {arg0:id}),
    content: spec.content ?? '',
    doodle:spec.doodle ?? null,
    type: spec.type ?? null,
    layout: spec.layout ?? 'plain',
    isPrefab: spec.isPrefab ?? false,
    prefabRef: null,
    overrides: [],
    prefabBase: null,
    createdAt: env.timestamp,
    updatedAt: env.timestamp,
    createdBy: session.clientId,
    editingBy: null,
    deleted: false,
  };

  let entry: ChildEntry | null = null;
  if (spec.parentId !== null) {
    const parent = mustCard(session, spec.parentId);
    entry = entryFor(parent.layout, id, appendOrder(session.state, spec.parentId), spec.plane);
  }

  emit(session, {
    ...env,
    type: 'card_create',
    cardId: id,
    parentId: spec.parentId,
    entry,
    fields,
  });

  return id;
}

/**
 * 改一张卡的 `layout`（§2.4.1）—— **必须连带重写它的子卡条目**。
 *
 * 【为什么不走 `setField`】条目形状由父卡的 `layout` 决定，而加载时要按 `layout` 校验形状。
 * 裸改字段会让子卡条目形状对不上，**下次打开工作区直接报数据损坏** ——
 * 实测踩过一次，而且 MCP 的 `set_field` 也能触发，等于 AI 一句调用就能把工作区写死。
 * 所以 `/layout` 与 `/id`、`/deleted` 一样被 `field_set` 挡在外面，只能走这里。
 *
 * 【一条事件】把 `before` / `after` 都塞进一条 `layout_change` 里，撤销因此仍然只需**一步**；
 * 也正因为重写有损（`plane → 其它` 丢坐标），撤销必须靠事件里带的旧条目，不能靠反推。
 */
export function setLayout(
  session: Session,
  cardId: CardId,
  to: Layout,
  options: { placements?: readonly Placement[] | undefined } = {},
): void {
  const card = mustCard(session, cardId);
  if (card.layout === to) return; // 没变就不发事件

  const before = childList(session.state, cardId);
  const after = reshapeEntries(to, before, options.placements);

  emit(session, {
    ...envelope(session, cardId),
    type: 'layout_change',
    cardId,
    from: card.layout,
    to,
    before,
    after,
  });
}

export function setField(session: Session, cardId: CardId, path: FieldPath, value: unknown): void {
  const fields = mustCard(session, cardId);
  const key = path.startsWith('/') ? path.slice(1) : path;
  const previous = (fields as unknown as Record<string, unknown>)[key];
  const from = (key === 'prefabBase' || key === 'doodle') ? previous ?? null : previous;

  // 值没变就不发事件：日志里全是空操作会让"最近改动"这种读法失效，也让撤销变得没用。
  if (stableStringify(from) === stableStringify(value)) return;

  emit(session, { ...envelope(session, cardId), type: 'field_set', cardId, path, from, to: value });
}

/** 移动一张卡。`toParentId` 为 `null` 表示浮动到桌面（§2.8 不变量 W）。 */
export function moveCard(
  session: Session,
  cardId: CardId,
  toParentId: CardId | null,
  index: number,
  plane?: PlanePlacement,
): void {
  mustCard(session, cardId);

  const containsPrefab = collectSubtree(session.state, cardId).ids.some(
    (id) => {const card=session.state.cards.get(id);return !!card?.isPrefab && card.prefabRef===null;},
  );
  if ((containsPrefab || cardId==='003') && (toParentId === null ||
    (toParentId !== '003' && !session.state.cards.get(toParentId)?.isPrefab && !isInSubtree(session.state, '003', toParentId)))) {
    throw new Error(uiText("core/workspace.text004"));
  }

  if (toParentId !== null && toParentId === cardId) {
    throw new Error(uiText("core/workspace.text005", {arg0: (cardId)}));
  }
  if (toParentId !== null && isInSubtree(session.state, cardId, toParentId)) {
    throw new Error(uiText("core/workspace.text006", {arg0: (cardId), arg1: (toParentId)}));
  }

  const from = locateEntry(session.state, cardId);

  if (from && from.parentId !== toParentId && isBoard(session.state, from.parentId) && childList(session.state, from.parentId).length === 3) {
    throw new Error(uiText("core/workspace.text007"));
  }

  // §2.5.1：**不允许任务卡直接落在 board 层级上**（那会让它变成一列）。
  // 只管"从外面移进来"的情况 —— 已经在看板下的列卡本身重排序是允许的。
  if (toParentId !== null && from?.parentId !== toParentId && isBoard(session.state, toParentId)) {
    throw new Error(
      uiText("core/workspace.text008", {arg0: (cardId), arg1: (toParentId)}),
    );
  }

  let addedEntry: ChildEntry | null = null;
  let reducerIndex: number | null = null;

  if (toParentId !== null) {
    const layout = mustCard(session, toParentId).layout;

    // `index` 一律是"被移动的那张卡在**最终**列表里的位置"，UI 拖放的直觉。
    // 同父重排与跨父移动在这里**不需要分开换算**：最终位置恰好等于
    // "在摘除之后的列表里插入的下标"（后者就是前者的定义）。
    // 唯一的差别是合法范围 —— 同父时摘除后列表短一个，所以直接用 `remaining.length` 夹即可。
    const sameParent = from?.parentId === toParentId;
    const remaining = sameParent
      ? withoutIndex(session.state, toParentId, from?.index ?? -1)
      : childList(session.state, toParentId);

    const requested = clamp(index, 0, remaining.length);
    reducerIndex = requested;

    addedEntry = entryForMove(layout, cardId, remaining, requested, plane, from?.entry);
  }

  emit(session, {
    ...envelope(session, cardId),
    type: 'card_move',
    cardId,
    fromParent: from?.parentId ?? null,
    toParent: toParentId,
    fromIndex: from?.index ?? null,
    removedEntry: from?.entry ?? null,
    addedEntry,
    index: reducerIndex,
  });
}

/** 删除一张卡连同它的整棵子树。返回**将被删除的卡片数**（含自身）—— 级联删除前人要能看到量。 */
export function deleteCard(session: Session, cardId: CardId, syncing = false): number {
  const card = mustCard(session, cardId);
  if (card.deleted) throw new Error(uiText("core/workspace.text009", {arg0: (cardId)}));
  // §2.7：内置卡不可删。按 **id** 判定，不看它挂在哪 ——
  // 否则把 003 拖到别的卡下面就能绕过去。
  if (!isDeletable(cardId)) {
    throw new Error(uiText("core/workspace.text010", {arg0: (cardId)}));
  }

  const from = locateEntry(session.state, cardId);
  if (from && isBoard(session.state, from.parentId) && childList(session.state, from.parentId).length === 3) {
    throw new Error(uiText("core/workspace.text011"));
  }
  const walked = collectSubtree(session.state, cardId);
  const deletingIds = new Set(walked.ids);
  for (const candidate of session.state.cards.values()) {
    if (!candidate.deleted && candidate.type !== null && deletingIds.has(candidate.type) && !deletingIds.has(candidate.id)) {
      throw new Error(uiText("core/workspace.text012"));
    }
    if (!syncing && !session.state.cards.get(from?.parentId ?? '')?.isPrefab && !candidate.deleted && candidate.prefabRef !== null && deletingIds.has(candidate.prefabRef) && !deletingIds.has(candidate.id)) {
      throw new Error(uiText("core/workspace.text013"));
    }
  }

  emit(session, {
    ...envelope(session, cardId),
    type: 'card_delete',
    cardId,
    parentId: from?.parentId ?? null,
    removedEntry: from?.entry ?? null,
    removedIndex: from?.index ?? null,
    subtree: walked.snapshot,
  });

  return walked.ids.length;
}

/**
 * 只数不删：这张卡连同它的整棵子树有多少张。
 *
 * §2.7 要求"UI 必须显示将删除的卡片数并要求确认"，而确认发生在**删除之前** ——
 * 所以需要一个不带副作用的预览。`deleteCard` 的返回值只能事后知道，来不及。
 *
 * 也刻意不做成"先删了看返回值再撤销"：那会在日志里留两条事件、撤销栈白多两步，
 * 而且真删了就有副作用。
 */
export function subtreeSize(session: Session, cardId: CardId): number {
  return collectSubtree(session.state, cardId).ids.length;
}

/**
 * 撤销最后一次操作。返回是否真的撤销了东西。
 *
 * 【写入次序与正向操作相反：状态先写、日志后截断】
 * 崩在中间时最坏结果是"这次撤销丢了"（日志还留着那条事件，重启会重放它），
 * 磁盘状态与日志始终互相自洽；反过来则会留下"水位线已经退回、日志却更短"的矛盾状态。
 *
 * 【已知取舍】这是把日志末尾**截掉**，不是追加补偿事件。追加补偿事件需要一个新的
 * `card_restore` 之类的事件类型（`card_delete` 的撤销无法用现有事件表达），
 * 而那属于事件模型的扩充，本轮没做。
 */
export function undoLast(session: Session): boolean {
  const last = session.events.at(-1);
  if (last === undefined) return false;

  let rolled = undoEvent(session.state, last);
  let first = session.events.length - 1;
  if (last.transactionId !== undefined) {
    while (first > 0 && session.events[first - 1]?.transactionId === last.transactionId) {
      first -= 1;
      rolled = undoEvent(rolled, session.events[first]!);
    }
  }
  const remaining = session.events.slice(0, first);

  // 新事件的旧值由它自己带着（`Envelope.prevUpdatedAt`），`undoEvent` 已经处理好了。
  // 但**旧日志**没记这个字段，撤销就推不回来 —— 那里按剩余日志把派生量重新物化一次
  // （这正是 `updatedAt` 的定义）。对已有新事件的卡是幂等的空操作。
  const restored = materializeUpdatedAt(rolled, remaining);
  for (const card of session.state.cards.values()) {
    if (!card.deleted && isBoard(session.state, card.id) && childList(session.state, card.id).length === 3 &&
      restored.cards.has(card.id) && !restored.cards.get(card.id)!.deleted && isBoard(restored, card.id) &&
      (restored.children.get(card.id)?.length ?? 0) !== 3) {
      throw new Error(uiText("core/workspace.text014"));
    }
  }

  writeState(session.root, restored, session.ops);
  rewriteLog(session.root, remaining, session.ops);

  session.state = restored;
  session.events = remaining;
  return true;
}

// ── 读模型（§9.2） ─────────────────────────────────────────────────────────────

export type CardSummary = { id: CardId; title: string; layout: Layout; deleted: boolean };

export type TreeNode = CardSummary & { children: TreeNode[]; truncated: boolean };

/** §9.2 的 `read_card(id, includeChildren?)`。 */
export type CardSnapshot = CardFields & { children?: ChildEntry[] };

const DEFAULT_DEPTH = 2;
const DEFAULT_LIMIT = 50;

/** 解析分页游标。所有分页读都走这一个，口径不会各写各的。 */
function parseCursor(cursor: string | undefined, where: string): number {
  if (cursor === undefined) return 0;
  const value = Number.parseInt(cursor, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(uiText("core/workspace.text015", {arg0: (where), arg1: (cursor)}));
  }
  return value;
}

/** 切一页并给出下一页游标。 */
function paginate<T>(all: readonly T[], start: number, limit: number): { page: T[]; nextCursor?: string } {
  const page = all.slice(start, start + limit);
  const consumed = start + page.length;
  return consumed < all.length ? { page, nextCursor: String(consumed) } : { page };
}

export function readCard(
  session: Session,
  cardId: CardId,
  options: { includeChildren?: boolean | undefined } = {},
): CardSnapshot {
  const fields = mustCard(session, cardId);
  if (options.includeChildren !== true) return fields;
  return { ...fields, children: [...(session.state.children.get(cardId) ?? [])] };
}

/** 子卡列表。**强制分页**：AI 一次读完整棵大树会直接爆上下文（§9.2）。 */
export function listChildren(
  session: Session,
  parentId: CardId,
  options: { cursor?: string | undefined; limit?: number | undefined } = {},
): { entries: ChildEntry[]; nextCursor?: string | undefined } {
  mustCard(session, parentId);

  const { page, nextCursor } = paginate(
    session.state.children.get(parentId) ?? [],
    parseCursor(options.cursor, 'listChildren'),
    options.limit ?? DEFAULT_LIMIT,
  );

  return nextCursor === undefined ? { entries: page } : { entries: page, nextCursor };
}

/**
 * 读树。默认只展到浅深度（2 层），深读必须显式指定 —— 见 §9.2 的"强制分页"。
 *
 * **只返回未删除的卡**（§2.8 不变量 W 的 `¬deleted`）。
 *
 * `scope` 过滤（§9.2 的 `read_tree(scope?)`）：因为 `scope` 由**深度 0 祖先**决定，
 * 按根卡过滤就等于按整棵子树过滤 —— 不需要逐节点判断。
 */
export function readTree(
  session: Session,
  options: {
    scope?: Scope | undefined;
    maxDepth?: number | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  } = {},
): { nodes: TreeNode[]; nextCursor?: string | undefined } {
  const maxDepth = options.maxDepth ?? DEFAULT_DEPTH;

  // 根卡集合就是 §2.8 不变量 W′ 的**桌面卡片** —— 两处必须用同一个定义，不各写一份。
  const roots = desktopCards(session.state).filter(
    (id) => options.scope === undefined || scopeOf(session.state, id) === options.scope,
  );

  const { page, nextCursor } = paginate(roots, parseCursor(options.cursor, 'readTree'), options.limit ?? DEFAULT_LIMIT);
  const nodes = page.map((id) => buildNode(session.state, id, maxDepth));

  return nextCursor === undefined ? { nodes } : { nodes, nextCursor };
}

function buildNode(state: CoreState, id: CardId, remainingDepth: number): TreeNode {
  const fields = state.cards.get(id);
  if (fields === undefined) throw new Error(uiText("core/workspace.text016", {arg0: (id)}));

  const childIds = (state.children.get(id) ?? []).map((entry) => entry.id);

  // 还有子卡但已经到深度上限 —— 明确标出来，别让调用方以为这就是全部。
  if (remainingDepth <= 0) {
    return { ...summarize(fields), children: [], truncated: childIds.length > 0 };
  }

  return {
    ...summarize(fields),
    children: childIds.map((childId) => buildNode(state, childId, remainingDepth - 1)),
    truncated: false,
  };
}

/**
 * 标题与正文的子串搜索，不区分大小写，不含已删除的卡。
 *
 * **也要分页**（§9.2 的 `search(query, limit?, cursor?)`）：搜索结果可能上千条，
 * 不分页的话 AI 一次拿回来照样爆上下文。结果按 id 排序 —— 否则分页会在两次调用之间漂移。
 */
export function search(
  session: Session,
  query: string,
  options: { limit?: number | undefined; cursor?: string | undefined } = {},
): { items: CardSummary[]; nextCursor?: string | undefined } {
  const needle = query.toLowerCase();

  const hits = [...session.state.cards.values()]
    .filter((fields) => !fields.deleted)
    .filter((fields) => fields.title.toLowerCase().includes(needle) || fields.content.toLowerCase().includes(needle))
    .map((fields) => summarize(fields))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const { page, nextCursor } = paginate(hits, parseCursor(options.cursor, 'search'), options.limit ?? DEFAULT_LIMIT);
  return nextCursor === undefined ? { items: page } : { items: page, nextCursor };
}

// ── 内部 ───────────────────────────────────────────────────────────────────────

function summarize(fields: CardFields): CardSummary {
  return { id: fields.id, title: fields.title, layout: fields.layout, deleted: fields.deleted };
}

/**
 * 追加到某父卡末尾时的 order。
 *
 * 走的是和插入同一套 `insertOrder`，所以"追加"与"插到末尾"给出同一个值。
 */
function appendOrder(state: CoreState, parentId: CardId): number {
  const list = childList(state, parentId);
  return insertOrder(list, list.length);
}

function childList(state: CoreState, parentId: CardId): ChildEntry[] {
  return [...(state.children.get(parentId) ?? [])];
}

/**
 * 移动时新条目该长什么样。
 *
 * 【坐标型父卡的特殊之处】`PlaneEntry` 带 x/y/w/h/z，而"同父重排"**不该改坐标** ——
 * 只是数组里的位置变了。所以：
 *   - 提供了新坐标 → 用新坐标
 *   - 没提供，但旧条目就是坐标型 → **沿用旧坐标**（只换个 id）
 *   - 没提供，且从别处移进来 → 抛错。编一个默认坐标会让"卡跑到了我没放的地方"
 *
 * 一开始没有这一层，症状是"在灵感台里拖一下卡片就报缺坐标" —— 而这本来是合法的重排。
 */
function entryForMove(
  layout: Layout,
  cardId: CardId,
  remaining: ChildEntry[],
  index: number,
  plane: PlanePlacement | undefined,
  previous: ChildEntry | undefined,
): ChildEntry {
  if (layout === 'plane' && plane === undefined) {
    if (previous !== undefined && 'x' in previous) return { ...previous, id: cardId };
    throw new Error(uiText("core/workspace.text017", {arg0: (cardId)}));
  }
  return entryFor(layout, cardId, layout === 'plane' || layout === 'plain' ? 0 : insertOrder(remaining, index), plane);
}

function withoutIndex(state: CoreState, parentId: CardId, index: number): ChildEntry[] {
  const list = childList(state, parentId);
  if (index >= 0 && index < list.length) list.splice(index, 1);
  return list;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) throw new Error(uiText("core/workspace.text018", {arg0: (value)}));
  return Math.min(Math.max(Math.trunc(value), low), high);
}

/**
 * 在 `list` 的第 `index` 位插入时，新条目该拿什么 `order`。
 *
 * 【为什么用**分数**而不是"下标即 order"】
 * `order = 插入下标` 看着最直白，但**会坏**：往 `[A@0, X@1, Y@2]` 插入得到 `[A,X,B@1]`，
 * 此时再插到第 2 位就得到 `[0,1,2,1]` —— 按 order 稳定排序会变成 `[A,X,B,Y]`，
 * **与数组顺序分叉**。这条是随机化测试（`test/order-invariant.test.ts`）真的跑出来的。
 *
 * 取相邻两个 order 的中点则天然维持"数组内非递减"，因此
 * **按 order 稳定排序 == 数组顺序**永远成立，且一次插入只产生**一条事件**
 * （若改成"插入后给整列重新编号"，一次拖动会炸出 O(n) 条事件，
 * 撤销就不再是"一步"了）。
 *
 * `order` 因此是**为多人同步预留的可合并排序键**（§11 优先级一），
 * 数组下标只负责本地寻址 —— 两者是两件事，不是同一事实存两遍。
 */
function insertOrder(list: ChildEntry[], index: number): number {
  const orders = list.map(orderOf);
  const previous = index > 0 ? orders[index - 1] : undefined;
  const next = index < orders.length ? orders[index] : undefined;

  if (previous === undefined && next === undefined) return 0;
  if (previous === undefined) return (next as number) - 1;
  if (next === undefined) return previous + 1;

  const mid = (previous + next) / 2;
  // 不加这条就是**静默**产出两个相等的 order，渲染顺序会变得取决于排序是否稳定。
  if (!(mid > previous && mid < next)) {
    throw new Error(
      uiText("core/workspace.text019", {arg0: (previous), arg1: (next)}),
    );
  }
  return mid;
}

function orderOf(entry: ChildEntry): number {
  return 'order' in entry && typeof (entry as { order: unknown }).order === 'number'
    ? (entry as { order: number }).order
    : 0;
}

function mustCard(session: Session, cardId: CardId): CardFields {
  const fields = session.state.cards.get(cardId);
  if (fields === undefined) throw new Error(uiText("core/workspace.text020", {arg0: (cardId)}));
  return fields;
}

function envelope(session: Session, cardId: CardId): Omit<CardEvent, 'type'> {
  const seq = session.state.lastAppliedSeq + 1;
  return {
    id: `e${seq}`,
    seq,
    clientId: session.clientId,
    timestamp: session.clock(),
    cardId,
    // 撤销要把 `updatedAt` 放回原值，而 `undoEvent` 看不到日志 —— 所以由事件自己带上，
    // 与 `from` / `fromIndex` / `removedEntry` 同一类（§4.3 断言二）。这里读的是**事件之前**的状态。
    prevUpdatedAt: session.state.cards.get(cardId)?.updatedAt,
  };
}

/** 会改变**树结构**的事件类型。只有这些之后才值得校验不变量 W。 */
const STRUCTURAL_EVENTS: ReadonlySet<CardEvent['type']> = new Set([
  'card_create',
  'card_move',
  'card_delete',
  'child_add',
  'child_remove',
]);

/** 应用事件 → 校验 → 立刻落盘 → 更新会话。**一条操作一条事件一次提交。** */
function emit(session: Session, event: CardEvent): void {
  const next = applyEvent(session.state, event);
  if(session.staging){session.state=next;session.events.push(event);return;}

  // 结构变了就验一次不变量 W。
  // 与 `assertEntryAt` / `validateState` / `assertSnapshotMatches` 同一个态度：
  // **当场炸**，而不是等到下次加载才发现 core 自己算错了。
  // 只在结构事件上做 —— `field_set` 不可能破坏 W，没必要为它多走一遍全量扫描。
  if (STRUCTURAL_EVENTS.has(event.type)) {
    assertInvariantW(next, uiText("core/workspace.text021", {arg0: (event.type)}));
  }

  appendEvents(session.root, [event], session.ops);
  writeState(session.root, next, session.ops);
  session.state = next;
  session.events = [...session.events, event];
}

/** 供测试与 MCP 用：把当前日志整体重放一遍，验证会话状态没有跑偏。 */
export function replayedState(session: Session): CoreState {
  return replay(session.events);
}

/** Stage a compound action without I/O, then append its events in a single write. */
export function transact<T>(session: Session, action: (draft: Session) => T): T {
  const noop = (): void => undefined;
  const draft: Session = { ...session, staging:true, events:[...session.events], ops: { ...session.ops, mkdirp: noop, writeFile: noop,
    appendFile: noop, rename: noop, remove: noop, fsync: noop } };
  const result = action(draft);
  const delta = draft.events.slice(session.events.length);
  if (delta.length === 0) return result;
  if(delta.some(event=>STRUCTURAL_EVENTS.has(event.type)))assertInvariantW(draft.state,uiText('core/workspace.text021',{arg0:'transaction'}));
  if(session.staging){session.state=draft.state;session.events=draft.events;return result;}
  const changedCards=new Set([...draft.state.cards].filter(([id,card])=>session.state.cards.get(id)!==card).map(([id])=>id));
  const transactionId = session.newId();
  const grouped = delta.map(event => ({ ...event, transactionId, transactionSize: delta.length }));
  appendEvents(session.root, grouped, session.ops);
  writeState(session.root, draft.state, session.ops,changedCards);
  session.state = draft.state;
  session.events = [...session.events, ...grouped];
  return result;
}
