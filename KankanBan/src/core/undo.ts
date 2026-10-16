import {uiText} from '../i18n/text.ts';
import {readCardImages} from './card-images.ts';
/**
 * 撤销（ARCHITECTURE.md §4.3 断言二：`undo(events) === 上一状态`）。
 *
 * 刻意做成**逆运算**而不是"丢掉最后一条再整段重放"：后者的正确性是构造出来的、
 * 测不出任何东西；逆运算才会真正暴露"事件里少带了旧状态"这类缺陷
 * （`card_move.fromIndex` / `card_delete.removedIndex` / `child_update.from`
 * 三个字段就是这么发现的）。
 */

import { assertEntryAt, fieldKeyOf, listOf, putList, withChildren, type CoreState } from './state.ts';
import type { CardEvent, CardFields, ChildEntry } from './types.ts';

/**
 * 把一个事件从状态上反向撤销掉，返回新状态。
 *
 * **返回值的 `lastAppliedSeq` 按 `event.seq - 1` 回退。** 这要求 seq 从 1 开始连续，
 * 单客户端单进程下成立；多人同步（优先级一）引入并发 seq 后，
 * 水位线必须改由日志层提供，而不是从事件自己推。
 */
export function undoEvent(state: CoreState, event: CardEvent): CoreState {
  return withPrevUpdatedAt(undoOne(state, event), event);
}

/**
 * 把 `updatedAt` 放回**这条事件带来的旧值**。
 *
 * 它是派生字段，但撤销**推不出来**：`undoEvent` 只看状态与这一条事件、看不到日志，
 * 所以旧值必须由事件自己带上（`Envelope.prevUpdatedAt`）——
 * 这与 `from` / `fromIndex` / `removedEntry` 是同一个道理，
 * 也正是 §4.3 断言二（`undo(events) === 上一状态`）能逐条成立的原因。
 *
 * 旧日志没有这个字段时**不动它**（退化成修复前的行为）：没有更好的选择，
 * 硬编一个值只会让状态与"前缀重放"对不上。
 */
function withPrevUpdatedAt(state: CoreState, event: CardEvent): CoreState {
  const prev = event.prevUpdatedAt;
  if (prev === undefined) return state;

  const card = state.cards.get(event.cardId);
  if (card === undefined || card.updatedAt === prev) return state;

  const cards = new Map(state.cards);
  cards.set(event.cardId, { ...card, updatedAt: prev });
  return { ...state, cards };
}

function undoOne(state: CoreState, event: CardEvent): CoreState {
  const lastAppliedSeq = Math.max(0, event.seq - 1);

  switch (event.type) {
    case 'field_set': {
      const prev = state.cards.get(event.cardId);
      if (prev === undefined) {
        throw new Error(uiText("core/undo.text001", {arg0: (event.cardId)}));
      }
      const key = fieldKeyOf(event.path);
      const cards = new Map(state.cards);
      const next={ ...prev, [key]: key==='images'?readCardImages(event.from ?? []):event.from } as CardFields;
      if(key==='layoutSizes'&&event.from==null)delete next.layoutSizes;
      cards.set(event.cardId,next);
      return { cards, children: state.children, lastAppliedSeq };
    }

    case 'child_add': {
      const list = listOf(state, event.parentId);
      assertEntryAt(list, event.parentId, event.index, event.entry.id);
      list.splice(event.index, 1);
      return { cards: state.cards, children: withChildren(state, event.parentId, list), lastAppliedSeq };
    }

    case 'child_remove': {
      const list = listOf(state, event.parentId);
      list.splice(event.index, 0, event.entry);
      return { cards: state.cards, children: withChildren(state, event.parentId, list), lastAppliedSeq };
    }

    case 'child_update': {
      const list = listOf(state, event.parentId);
      assertEntryAt(list, event.parentId, event.index, event.entry.id);
      list[event.index] = event.from;
      return { cards: state.cards, children: withChildren(state, event.parentId, list), lastAppliedSeq };
    }

    case 'card_move': {
      const { fromParent, toParent, fromIndex, index, removedEntry, addedEntry } = event;
      const children = new Map(state.children);

      // 同父重排的逆：先从 `index` 摘下 `addedEntry`，再把 `removedEntry` 放回 `fromIndex`。
      if (fromParent !== null && fromParent === toParent) {
        if (fromIndex === null || index === null || removedEntry === null || addedEntry === null) {
          throw new Error(uiText("core/undo.text002", {arg0: (fromParent)}));
        }
        const list = listOf(state, fromParent);
        assertEntryAt(list, fromParent, index, event.cardId);
        list.splice(index, 1);
        list.splice(fromIndex, 0, removedEntry);
        putList(children, fromParent, list);
        return { cards: state.cards, children, lastAppliedSeq };
      }

      // 逆序：先从新父卡的新下标处摘下，再按旧形状插回旧父卡的旧下标。
      if (toParent !== null) {
        if (index === null) throw new Error(uiText("core/undo.text003", {arg0: (toParent)}));
        const list = listOf(state, toParent);
        assertEntryAt(list, toParent, index, event.cardId);
        list.splice(index, 1);
        putList(children, toParent, list);
      }

      if (fromParent !== null) {
        if (fromIndex === null || removedEntry === null) {
          throw new Error(uiText("core/undo.text004", {arg0: (fromParent)}));
        }
        const list = listOf(state, fromParent);
        list.splice(fromIndex, 0, removedEntry);
        putList(children, fromParent, list);
      }

      return { cards: state.cards, children, lastAppliedSeq };
    }

    case 'card_create': {
      const cards = new Map(state.cards);
      cards.delete(event.cardId);

      if (event.parentId === null || event.entry === null) {
        return { cards, children: state.children, lastAppliedSeq };
      }

      // 按 id 找下标而不是假定"一定在末尾" —— 假定会掩盖真实的下标漂移。
      const list = listOf(state, event.parentId);
      const index = list.findIndex((entry) => entry.id === event.cardId);
      if (index < 0) {
        throw new Error(uiText("core/undo.text005", {arg0: (event.cardId), arg1: (event.parentId)}));
      }
      list.splice(index, 1);
      return { cards, children: withChildren(state, event.parentId, list), lastAppliedSeq };
    }

    case 'card_delete': {
      // 整棵子树从快照整体放回（快照在 apply 时已与实际子树核对过）。
      const cards = new Map(state.cards);
      for (const [id, fields] of Object.entries(event.subtree.cards)) {
        cards.set(id, fields.images===undefined?fields:{...fields,images:readCardImages(fields.images)});
      }

      const children = new Map(state.children);
      for (const [id, list] of Object.entries(event.subtree.children)) {
        putList(children, id, [...list] as ChildEntry[]);
      }

      if (event.parentId !== null) {
        if (event.removedIndex === null || event.removedEntry === null) {
          throw new Error(uiText("core/undo.text006", {arg0: (event.parentId)}));
        }
        const list = listOf(state, event.parentId);
        list.splice(event.removedIndex, 0, event.removedEntry);
        putList(children, event.parentId, list);
      }

      return { cards, children, lastAppliedSeq };
    }

    case 'layout_change': {
      const card = state.cards.get(event.cardId);
      if (card === undefined) {
        throw new Error(uiText("core/undo.text007", {arg0: (event.cardId)}));
      }
      // 逆运算：布局改回 `from`，条目还原成**事件里带的** `before`。
      // 不能靠"按 from 反推" —— 重写是有损的（plane → 其它会丢坐标），
      // 反推出来的东西跟原来不一样。
      const cards = new Map(state.cards);
      cards.set(event.cardId, { ...card, layout: event.from });

      return {
        cards,
        children: withChildren(state, event.cardId, [...event.before]),
        lastAppliedSeq,
      };
    }

    default: {
      const unreachable = event as never;
      throw new Error(uiText("core/undo.text008", {arg0: (JSON.stringify(unreachable))}));
    }
  }
}
