/**
 * **我是谁** —— 一个 webview 靠自己的窗口标签判断角色。
 *
 * Labels identify native windows. Additional views append __nonce to the anchor card ID.
 * 前端两侧的字符串必须与 Rust 的 `lib.rs`（`CARD_PREFIX` / `MAIN_LABEL`）一致。
 *
 * 【为什么需要 preview】`vite dev` 直接把页面开在浏览器里时**没有 Tauri 标签**，
 * 那时退回单窗口预览（纯内存后端），UI 仍然能被开发与断言。
 */

import type { CardId } from '../core/types.ts';
import {windowAnchor,windowLabel,windowIdFromLabel,MAIN_WINDOW_LABEL,CARD_WINDOW_PREFIX} from '../core/window-identity.ts';

/** 主窗口标签，与 `tauri.conf.json` 的 `app.windows[0].label` 一致。 */
export const MAIN_LABEL = MAIN_WINDOW_LABEL;

/** 卡片窗口标签前缀，与 Rust 的 `CARD_PREFIX` 一致。 */
export const CARD_LABEL_PREFIX = CARD_WINDOW_PREFIX;

export type WindowRole =
  /** 写者（§14 方案 A）：唯一持有会话、唯一写盘的那扇窗口 */
  | { kind: 'main' }
  /** 镜像：只读渲染某张卡，改动一律转发给 main */
  | { kind: 'card'; cardId: CardId; windowId?:string }
  /** 浏览器里跑（没有 Tauri），退回单窗口预览 */
  | { kind: 'preview' };

export function labelOfCard(cardId: CardId): string {
  return windowLabel(cardId);
}

export function roleOfLabel(label: string | null | undefined): WindowRole {
  if (label === MAIN_LABEL) return { kind: 'main' };

  const cardId=typeof label==='string'?windowIdFromLabel(label):null;
  if (cardId!==null) {
    // `card-` 后面是空的 → 不是有效身份。宁可退回预览，也不要认成一张叫 "" 的卡。
    if (cardId !== '') return { kind: 'card', cardId:windowAnchor(cardId),...(cardId.includes('__')?{windowId:cardId}:{}) };
  }

  return { kind: 'preview' };
}
