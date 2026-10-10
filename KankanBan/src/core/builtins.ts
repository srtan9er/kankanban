/**
 * 内置卡表 —— ARCHITECTURE.md §2.2。
 *
 * 四张内置卡**都是普通卡片**，只是带内置渲染器。它们由这张表声明，而不是由用户设置：
 *   - `layout` 决定内置渲染器（§2.5 分派第 1 步）
 *   - `public` 决定"公有区域恰好是哪几棵树"（§2.6）
 *
 * 把这两件事收进一张表，是为了让 §2.5 与 §2.6 引用**同一个来源** ——
 * 否则"哪些卡是公有的"和"哪些卡有内置渲染器"会各自散落一份，改一处漏一处。
 *
 * 【id 是保留的】即使卡片还没被建出来（阶段三才建），分派与公有判定也照样成立。
 */

import type { CardId, Layout } from './types.ts';

export type BuiltinCard = {
  id: CardId;
  name: string;
  /** 内置渲染器（§2.5 分派第 1 步直接用，不看 `type`） */
  layout: Layout;
  /** 是否为公有区域（§2.6：公有区域**恰好**是 board 与 inspiration） */
  public: boolean;
};

export const BUILTIN_CARDS: readonly BuiltinCard[] = [
  { id: '000', name: 'main', layout: 'tabs', public: false },
  { id: '001', name: 'board', layout: 'columns', public: true },
  { id: '002', name: 'inspiration', layout: 'plane', public: true },
  { id: '003', name: 'prefabs', layout: 'library', public: false },
];

const BY_ID = new Map<CardId, BuiltinCard>(BUILTIN_CARDS.map((card) => [card.id, card]));

const PUBLIC_ROOTS: ReadonlySet<CardId> = new Set(
  BUILTIN_CARDS.filter((card) => card.public).map((card) => card.id),
);

export function builtinOf(cardId: CardId): BuiltinCard | undefined {
  return BY_ID.get(cardId);
}

export function isBuiltin(cardId: CardId): boolean {
  return BY_ID.has(cardId);
}

/** §2.6：公有区域的深度 0 祖先集合。 */
export function publicRootIds(): ReadonlySet<CardId> {
  return PUBLIC_ROOTS;
}

/** 内置卡不可删（§2.7）。 */
export function isDeletable(cardId: CardId): boolean {
  return !BY_ID.has(cardId);
}
