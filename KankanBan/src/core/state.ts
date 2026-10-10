import {validInk} from './drawing.ts';
import {uiText} from '../i18n/text.ts';
/**
 * 内存状态与事件应用（ARCHITECTURE.md §4.2 第 2 步、§4.3 重放一致性）。
 *
 * 【桩】本文件目前只定义形状，`applyEvent` 尚未实现 —— 用于取得断言级失败。
 */

import type { CardEvent, CardFields, CardId, ChildEntry, Layout } from './types.ts';
import { assertEntryShape } from './entries.ts';
import { assertSnapshotMatches, collectSubtree } from './subtree.ts';

/**
 * 内存状态。
 *
 * 权威来源见 §2.3：
 *   - `children` 来自 `tree.json`
 *   - `cards`    来自 `cards/*.md`
 *   - `parent`   是**派生索引**、不落盘（§2.1），需要时由 children 重建
 */
export type CoreState = {
  cards: Map<CardId, CardFields>;
  children: Map<CardId, ChildEntry[]>;
  /** 已应用到的最大 seq，对应 tree.json 的 lastAppliedSeq */
  lastAppliedSeq: number;
};

export function emptyState(): CoreState {
  return { cards: new Map(), children: new Map(), lastAppliedSeq: 0 };
}

/**
 * 可被 `field_set` 写入的字段。
 *
 * 刻意**不含 `id`**：卡片身份一旦可改，`children` 里的引用、`prefabRef`、事件里的
 * `cardId` 全部会指向不存在的东西。§2.2 也只允许内置卡保护 `id`，这里把它收紧到全部卡片。
 */
export const SETTABLE_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'content',
  'doodle',
  'type',
  'layout',
  'isPrefab',
  'prefabRef',
  'overrides',
  'prefabBase',
  'createdAt',
  'updatedAt',
  'createdBy',
  'editingBy',
]);

export function fieldKeyOf(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

type FieldKind = 'string' | 'string|null' | 'number' | 'boolean' | 'string[]' | 'ink|null';

/**
 * 可写字段的**值类型**。
 *
 * 【为什么写侧也要校验类型】`SETTABLE_FIELDS` 只管**字段名**，值原来是不看的。
 * 读侧的 `parseCard` 却是严格的（frontmatter 里的值必须是对应类型的 JSON），
 * 两边不一致的后果**实测过一次**：`set_field('/title', 123)` 顺利写进 `cards/*.md`，
 * 然后整个工作区再也打不开 —— 连 `undo` 都跑不了，因为读不出工作区就没有会话。
 * **一次误写就能把工作区写死**，所以这条线必须在这里堵。
 *
 * 与 `frontmatter.ts` 的读取校验刻意**分成两份**：这边管"不许写坏"，
 * 那边管"读到坏的也要说清楚"。两份表不许漂移 —— 有一条"写→盘→读"往返断言钉着
 * （`test/field-types.test.ts`）。
 */
const FIELD_KINDS: Readonly<Record<string, FieldKind>> = {
  title: 'string',
  content: 'string',
  doodle: 'ink|null',
  createdBy: 'string',
  type: 'string|null',
  prefabRef: 'string|null',
  prefabBase: 'string|null',
  editingBy: 'string|null',
  createdAt: 'number',
  updatedAt: 'number',
  isPrefab: 'boolean',
  overrides: 'string[]',
};

const KIND_LABEL: Readonly<Record<FieldKind, string>> = {
  'ink|null':uiText('drawing.attributeType'),
  string: uiText("core/state.text001"),
  'string|null': uiText("core/state.text002"),
  number: uiText("core/state.text003"),
  boolean: uiText("core/state.text004"),
  'string[]': uiText("core/state.text005"),
};

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return uiText("core/state.text006", {arg0: (value.length)});
  return typeof value;
}

/** 写入前校验值的类型。未知字段不在这里管（`SETTABLE_FIELDS` 会先挡掉）。 */
export function assertFieldValue(path: string, value: unknown): void {
  const kind = FIELD_KINDS[fieldKeyOf(path)];
  if (kind === undefined) return;

  const ok = ((): boolean => {
    switch (kind) {
      case 'ink|null':return value===null || validInk(value);
      case 'string':
        return typeof value === 'string';
      case 'string|null':
        return value === null || typeof value === 'string';
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'string[]':
        return Array.isArray(value) && value.every((item) => typeof item === 'string');
    }
  })();

  if (!ok) {
    throw new Error(uiText("core/state.text007", {arg0: (path), arg1: (KIND_LABEL[kind]), arg2: (describeValue(value))}));
  }
}

/**
 * 取某父卡的 children 副本（不存在则视为空），保证不改动入参。
 *
 * 【规范形态】`children` **不允许出现空数组**：有键 ⟺ 至少有一个子卡。
 * 这条不变量不是洁癖 —— 没有它，`card_create`/`child_remove`/`card_delete` 的撤销
 * 会在 Map 里留下空壳，导致 `undo(events)` 与"前缀重放"在**语义相同但形状不同**上分叉，
 * §4.3 断言二就永远差一点点。规范形态让重放与撤销成为严格互逆。
 */
export function listOf(state: CoreState, parentId: CardId): ChildEntry[] {
  return [...(state.children.get(parentId) ?? [])];
}

/** 把一份 children 写回 Map，并维持"不留空数组"的规范形态。 */
export function putList(children: Map<CardId, ChildEntry[]>, parentId: CardId, list: ChildEntry[]): void {
  if (list.length === 0) children.delete(parentId);
  else children.set(parentId, list);
}

/** 写回某父卡的 children，并维持"不留空数组"的规范形态。 */
export function withChildren(state: CoreState, parentId: CardId, list: ChildEntry[]): Map<CardId, ChildEntry[]> {
  const children = new Map(state.children);
  putList(children, parentId, list);
  return children;
}

/**
 * 把一个事件应用到状态，返回**新**状态（纯函数，不改入参）。
 *
 * 纯函数是刻意的：§4.3 的三条断言都要用它在无 GUI 环境里重放。
 * **实时应用与重放走的是同一个函数** —— 这是"重放一致性"能结构性成立的原因，
 * 而不是靠两套代码互相看齐。
 *
 * 它在 `applyOne` 之外只多做一件事：把 `updatedAt` 推到这条事件的时间（见 `withUpdatedAt`）。
 */
export function applyEvent(state: CoreState, event: CardEvent): CoreState {
  return withUpdatedAt(applyOne(state, event), event);
}

/**
 * 一张卡的 `updatedAt` ≡ **指向它的最后一条事件的时间**（派生量，不是自由字段）。
 *
 * 【为什么要现在补】它原来只在建卡时被写一次，之后**再也没有人动过** ——
 * 于是卡片文件里"创建时间"与"更新时间"永远相同，这个字段等于骗人。
 *
 * 【这条定义顺带回答了"什么算一次改动"】事件里 `cardId` 指谁，就是谁被改了 ——
 * 不需要给每种事件单独判断一次，也不会出现"某类改动忘了更新时间"。
 *
 * 【为什么不许倒退】时钟回拨、或同一毫秒内的两条事件，都不该让"最后改动时间"往回走。
 *
 * 【撤销要一起对回去】这个值进入"撤销 == 前缀重放"的比较范围，
 * 而 `undoEvent` 看不到日志 —— 所以 `undoLast` 里按剩余事件重算一次，
 * 否则 `check` 的重放一致性会当场报红。
 */
function withUpdatedAt(state: CoreState, event: CardEvent): CoreState {
  const card = state.cards.get(event.cardId);
  if (card === undefined) return state;
  if (card.updatedAt >= event.timestamp) return state;

  const cards = new Map(state.cards);
  cards.set(event.cardId, { ...card, updatedAt: event.timestamp });
  return { ...state, cards };
}

/**
 * 按**整条日志**把每张卡的 `updatedAt` 重新物化一遍 —— 派生量的定义，直接照做。
 *
 * 【为什么需要它】上面那条规则只管"从现在起"。而**旧日志 + 旧卡片文件**里
 * `updatedAt` 还是老语义下的值（老代码从来不推进它，于是永远等于 `createdAt`）。
 * 打开工作区时不重算，`check` 的重放一致性就会对一堆**其实没坏**的卡报红 ——
 * 实测在你那份工作区上有 5 张卡对不上，全部是这一条。
 *
 * 只动这一个字段、且完全由日志推出，所以它**幂等**，也不会掩盖别的损坏
 * （其他字段仍然由 tree.json + cards/*.md 说了算，坏数据照样在 `validateState` 里炸）。
 */
export function materializeUpdatedAt(state: CoreState, events: readonly CardEvent[]): CoreState {
  const latest = new Map<CardId, number>();
  for (const event of events) {
    latest.set(event.cardId, Math.max(latest.get(event.cardId) ?? 0, event.timestamp));
  }

  let changed = false;
  const cards = new Map(state.cards);

  for (const [id, card] of state.cards) {
    // 没有任何事件指向它时退回 `createdAt`：那时"创建"就是它唯一的时间。
    const updatedAt = Math.max(card.createdAt, latest.get(id) ?? 0);
    if (updatedAt !== card.updatedAt) {
      cards.set(id, { ...card, updatedAt });
      changed = true;
    }
  }

  return changed ? { ...state, cards } : state;
}

function applyOne(state: CoreState, event: CardEvent): CoreState {
  const lastAppliedSeq = Math.max(state.lastAppliedSeq, event.seq);

  switch (event.type) {
    case 'card_create': {
      const cards = new Map(state.cards);
      cards.set(event.cardId, event.fields);

      if (event.parentId === null || event.entry === null) {
        return { cards, children: state.children, lastAppliedSeq };
      }

      // `card_create` 不带插入下标，挂在父卡下时一律**追加到末尾**。
      // 需要插到中间就再发一条 `child_update` 修顺序。
      const list = listOf(state, event.parentId);
      list.push(event.entry);
      return { cards, children: withChildren(state, event.parentId, list), lastAppliedSeq };
    }

    case 'field_set': {
      const key = fieldKeyOf(event.path);
      if (key === 'updatedAt') {
        // 它是**派生**的（= 指向这张卡的最后一条事件的时间，见 withUpdatedAt）。
        // 允许直接写只会得到一个"看着成功、实际被事件时间覆盖"的假动作 ——
        // 与其留一个静默失效的旋钮，不如直接挡住。
        throw new Error(uiText("core/state.text008"));
      }
      if (key === 'id' || key === 'deleted' || key === 'layout') {
        // 这三个字段只由专门的事件与撤销写：
        //   /id      —— 改了就与 children 里的引用、事件里的 cardId 全部脱钩
        //   /deleted —— 允许直接改会出现"卡没被删、子树却已被摘掉"的半删除态
        //   /layout  —— 条目形状由它决定，**裸改会让子卡条目形状对不上，下次加载即数据损坏**
        //               （实测过一次：改完 layout 工作区就打不开了）。要走 `setLayout`
        throw new Error(uiText("core/state.text009", {arg0: (key)}));
      }
      if (!SETTABLE_FIELDS.has(key)) {
        throw new Error(uiText("core/state.text010", {arg0: (event.path)}));
      }
      // 类型也要看：写侧放进去一个读侧不认的值，等于把工作区写死（见 `FIELD_KINDS` 的注释）
      assertFieldValue(event.path, event.to);

      const prev = state.cards.get(event.cardId);
      if (prev === undefined) {
        throw new Error(uiText("core/state.text011", {arg0: (event.cardId)}));
      }

      const cards = new Map(state.cards);
      // 计算键名的展开会被 TS 放宽成索引签名，这里显式收回 CardFields。
      cards.set(event.cardId, { ...prev, [key]: event.to } as CardFields);
      return { cards, children: state.children, lastAppliedSeq };
    }

    case 'child_add': {
      const list = listOf(state, event.parentId);
      if (event.index < 0 || event.index > list.length) {
        throw new Error(
          uiText("core/state.text012", {arg0: (event.parentId), arg1: (event.index), arg2: (list.length)}),
        );
      }
      list.splice(event.index, 0, event.entry);
      return { cards: state.cards, children: withChildren(state, event.parentId, list), lastAppliedSeq };
    }

    case 'child_remove': {
      const list = listOf(state, event.parentId);
      assertEntryAt(list, event.parentId, event.index, event.entry.id);
      list.splice(event.index, 1);
      return { cards: state.cards, children: withChildren(state, event.parentId, list), lastAppliedSeq };
    }

    case 'child_update': {
      const list = listOf(state, event.parentId);
      assertEntryAt(list, event.parentId, event.index, event.entry.id);
      list[event.index] = event.entry;
      return { cards: state.cards, children: withChildren(state, event.parentId, list), lastAppliedSeq };
    }

    case 'card_move': {
      const { fromParent, toParent } = event;
      const children = new Map(state.children);

      // 同父重排：两条下标作用在**同一个数组**上，且 `index` 指"摘除之后"的位置。
      // 这一点必须明确，否则同父拖动会在边界上错一位。
      if (fromParent !== null && fromParent === toParent) {
        const { fromIndex, index, addedEntry } = event;
        if (fromIndex === null || index === null || addedEntry === null) {
          throw new Error(uiText("core/state.text013", {arg0: (fromParent)}));
        }
        const list = listOf(state, fromParent);
        assertEntryAt(list, fromParent, fromIndex, event.cardId);
        list.splice(fromIndex, 1);
        if (index < 0 || index > list.length) {
          throw new Error(uiText("core/state.text014", {arg0: (fromParent), arg1: (index), arg2: (list.length)}));
        }
        list.splice(index, 0, addedEntry);
        putList(children, fromParent, list);
        return { cards: state.cards, children, lastAppliedSeq };
      }

      // 摘除（根卡没有父，跳过）
      if (fromParent !== null) {
        const { fromIndex, removedEntry } = event;
        if (fromIndex === null || removedEntry === null) {
          throw new Error(uiText("core/state.text015", {arg0: (fromParent)}));
        }
        const list = listOf(state, fromParent);
        assertEntryAt(list, fromParent, fromIndex, event.cardId);
        list.splice(fromIndex, 1);
        putList(children, fromParent, list);
      }

      // 插入（浮动到桌面时没有新父卡，跳过）
      if (toParent !== null) {
        const { index, addedEntry } = event;
        if (index === null || addedEntry === null) {
          throw new Error(uiText("core/state.text016", {arg0: (toParent)}));
        }
        const list = listOf(state, toParent);
        if (index < 0 || index > list.length) {
          throw new Error(uiText("core/state.text014", {arg0: (toParent), arg1: (index), arg2: (list.length)}));
        }
        list.splice(index, 0, addedEntry);
        putList(children, toParent, list);
      }

      return { cards: state.cards, children, lastAppliedSeq };
    }

    case 'card_delete': {
      // 1) 走一遍真实子树，并与事件自带的快照核对 —— 快照错了就没有可信的撤销依据。
      const walk = collectSubtree(state, event.cardId);
      assertSnapshotMatches(walk, event.subtree, event.cardId);

      // 2) 整棵子树打上软删除标记（**字段保留**，文件也保留在 cards/ 里，
      //    否则重启后卡片会复活），并从 children 里移除，使其不再被任何父卡引用。
      //
      //    【这里刻意不检查"是不是已经删过了"】replay 必须对"部分写入"幂等：
      //    writeState 先写卡片文件、最后写 tree.json，崩在中间时卡片已带 deleted:true
      //    而结构文件还停在删除前，重放这条事件就会再删一次。
      //    面向用户的重复删除由操作层（workspace.deleteCard）拦，不靠 reducer。
      const cards = new Map(state.cards);
      const children = new Map(state.children);
      for (const id of walk.ids) {
        const fields = cards.get(id);
        if (fields !== undefined) cards.set(id, { ...fields, deleted: true });
        children.delete(id);
      }

      // 3) 从父卡按 removedIndex 摘除条目（根卡没有父）
      if (event.parentId !== null) {
        if (event.removedIndex === null) {
          throw new Error(uiText("core/state.text017", {arg0: (event.parentId)}));
        }
        const list = listOf(state, event.parentId);
        assertEntryAt(list, event.parentId, event.removedIndex, event.cardId);
        list.splice(event.removedIndex, 1);
        putList(children, event.parentId, list);
      }

      return { cards, children, lastAppliedSeq };
    }

    case 'layout_change': {
      const card = state.cards.get(event.cardId);
      if (card === undefined) {
        throw new Error(uiText("core/state.text018", {arg0: (event.cardId)}));
      }
      // `from` 与实际不符说明事件序列错位了 —— 静默改下去会一路歪，当场炸
      if (card.layout !== event.from) {
        throw new Error(
          uiText("core/state.text019", {arg0: (event.cardId), arg1: (card.layout), arg2: (event.from)}),
        );
      }
      // 新条目必须真的符合新布局，否则等于亲手写坏数据
      for (const entry of event.after) {
        assertEntryShape(event.to, entry, uiText("core/state.text020", {arg0: (event.cardId)}));
      }

      const cards = new Map(state.cards);
      cards.set(event.cardId, { ...card, layout: event.to });

      return {
        cards,
        children: withChildren(state, event.cardId, [...event.after]),
        lastAppliedSeq,
      };
    }

    default:
      throw new Error(uiText("core/state.text021", {arg0: ((event as CardEvent).type)}));
  }
}

/**
 * 下标处的条目必须是事件声称的那一张。
 *
 * 这条检查是**故意**加的：§4.1 的修正 2 说过"下标在插入/删除后会指向错误的卡"，
 * 而静默写错卡是最难查的一类损坏。宁可在重放时当场炸掉。
 */
export function assertEntryAt(list: ChildEntry[], parentId: CardId, index: number, expectedId: CardId): void {
  const found = list[index];
  if (found === undefined) {
    throw new Error(uiText("core/state.text022", {arg0: (parentId), arg1: (index), arg2: (list.length)}));
  }
  if (found.id !== expectedId) {
    throw new Error(
      uiText("core/state.text023", {arg0: (parentId), arg1: (index), arg2: (found.id), arg3: (expectedId)}),
    );
  }
}
