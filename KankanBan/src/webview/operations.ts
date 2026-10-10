import {uiText} from '../i18n/text.ts';
/**
 * **意图** —— 多窗口（§14 方案 A）里写者与镜像之间唯一被允许的改动表达方式。
 *
 * 【为什么要有这一层】方案 A 定的是"main 单写者"，于是卡片窗口不能直接改会话。
 * 但如果卡片窗口自己另写一套"改字段要调什么"，两边迟早会漂移
 * （参考项目没有这个问题：它的状态在 Rust 里，窗口只是薄视图，只有一个 owner）。
 *
 * 所以把"一次改动的语义"抽成一个**数据**（`Intent`），由**同一份实现**执行：
 *   - main 本地点击 → `runIntent(session, intent)`
 *   - 卡片窗口点击 → 把同一个 `intent` 发给 main，由它跑同一个 `runIntent`
 *
 * 两边跑的是同一个函数、同一组 core 操作，所以不存在"镜像版语义"。
 *
 * 【失败不抛】镜像那边收到 main 的回复才有机会显示原因，抛异常只会让它的界面卡住。
 * 所以一律返回 `{ok:false, message}`，由调用方决定怎么显示。
 *
 * 【不在这里的】开窗 / 关窗 **不是**意图：它们改的是 `view-state.json` 与真窗口，
 * 那是写者独有的职责，见 `WindowCommand`。
 */

import type { CardId, Layout } from '../core/types.ts';
import { createCard, deleteCard, moveCard, setField, setLayout, undoLast } from '../core/workspace.ts';
import type { Session } from '../core/workspace.ts';

/** 会改动**树/卡片**的意图 —— 与写者共用的那一组。 */
export type Intent =
  | { kind: 'setField'; cardId: CardId; path: '/title' | '/content'; value: string }
  | { kind: 'setLayout'; cardId: CardId; layout: Layout }
  | { kind: 'moveCard'; cardId: CardId; parentId: CardId | null; index: number }
  | { kind: 'createCard'; parentId: CardId | null; title: string }
  | { kind: 'deleteCard'; cardId: CardId }
  | { kind: 'undo' };

/**
 * 会动**窗口**的命令 —— 只有写者执行得了。
 *
 * `proposeToWindow` 是「提出到屏幕窗口」：把卡从父卡下摘出来变成桌面卡片，再给它开一扇窗。
 * 两半刻意合在一个命令里：用户在菜单上点的是一个动作，不该出现"树改了但窗没开"的中间态。
 */
export type WindowCommand =
  | { kind: 'proposeToWindow'; cardId: CardId }
  | { kind: 'reopenWindow'; cardId: CardId }
  | { kind: 'closeWindow'; cardId: CardId };

export type Command = Intent | WindowCommand;

export type IntentResult =
  | { ok: true; createdId?: CardId; removed?: number; undone?: boolean }
  | { ok: false; message: string };

/** 在会话上执行一条意图。写者与镜像走的是这同一个函数。 */
export function runIntent(session: Session, intent: Intent): IntentResult {
  try {
    return applyIntent(session, intent);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function applyIntent(session: Session, intent: Intent): IntentResult {
  switch (intent.kind) {
    case 'setField': {
      setField(session, intent.cardId, intent.path, intent.value);
      return { ok: true };
    }
    case 'setLayout': {
      // 必须走 `setLayout` 而不是 `setField('/layout')`：后者会让子卡条目形状对不上，
      // 下次打开工作区直接报数据损坏（实现期踩过，见 §4.1 的 layout_change）。
      setLayout(session, intent.cardId, intent.layout);
      return { ok: true };
    }
    case 'moveCard': {
      moveCard(session, intent.cardId, intent.parentId, intent.index);
      return { ok: true };
    }
    case 'createCard': {
      const createdId = createCard(session, { parentId: intent.parentId, title: intent.title });
      return { ok: true, createdId };
    }
    case 'deleteCard': {
      const removed = deleteCard(session, intent.cardId);
      return { ok: true, removed };
    }
    case 'undo': {
      return { ok: true, undone: undoLast(session) };
    }
  }

  // 新增意图种类时这里会**编译不过**（`intent` 不再是 never），逼着补实现。
  const unhandled: never = intent;
  throw new Error(uiText("webview/operations.text001", {arg0: (JSON.stringify(unhandled))}));
}

/** 这条命令是不是"只有写者做得了"的那一类（开窗 / 关窗 / 提出）。 */
export function isWindowCommand(command: Command): command is WindowCommand {
  switch (command.kind) {
    case 'proposeToWindow':
    case 'reopenWindow':
    case 'closeWindow':
      return true;
    default:
      return false;
  }
}
