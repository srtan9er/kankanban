import {uiText} from '../i18n/text.ts';
/**
 * 渲染分派 —— ARCHITECTURE.md §2.5 的第 1、2 步。
 *
 * 【为什么单独一个模块】`rendererOf` 有两个消费者，分处不同层：
 *   - **视图层**（`view-model.ts`）：决定摊成什么形状
 *   - **操作层**（`workspace.ts`）：判断"这个目标是不是看板"，从而拒绝
 *     "把任务卡直接移到看板层级"（§2.5.1）
 *
 * 如果 `rendererOf` 留在视图层，操作层 import 视图层就是**层次倒置** ——
 * 阶段二的窗口管理器会立刻踩到。放在这里，两层都往下依赖，方向就正了。
 */

import { builtinOf } from './builtins.ts';
import type { CoreState } from './state.ts';
import type { CardId, Layout } from './types.ts';

/**
 * §2.5.1 的终止规则：
 *   1. 内置 id → 内置渲染器
 *   2. 否则 `type` 非空 → 读 **`type` 指向的那张卡** 的 `layout`
 *   3. 否则 → 卡片自身的 layout。
 *
 * 第一轮迭代允许直接选择呈现方式；旧数据的单层 type 引用继续兼容。
 */
export function rendererOf(state: CoreState, cardId: CardId): Layout {
  const builtin = builtinOf(cardId)?.layout;
  if (builtin !== undefined) return builtin;

  const card = state.cards.get(cardId);
  if (card === undefined) throw new Error(uiText("core/renderer.text001", {arg0: (cardId)}));
  if (card.type === null) return card.layout;

  const template = state.cards.get(card.type);
  if (template === undefined) {
    throw new Error(uiText("core/renderer.text002", {arg0: (card.type), arg1: (cardId)}));
  }
  if (template.type !== null) {
    // §2.5 的终止规则被破坏：链长必须恒为 1，否则渲染要跟着递归。
    throw new Error(
      uiText("core/renderer.text003", {arg0: (card.type), arg1: (template.type), arg2: (cardId)}),
    );
  }
  return template.layout;
}

/** 这张卡是不是"看板"（§2.5.1：直接子节点必须是列卡）。 */
export function isBoard(state: CoreState, cardId: CardId): boolean {
  return rendererOf(state, cardId) === 'columns';
}
