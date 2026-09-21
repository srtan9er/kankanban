import type { Card } from '@kankanban/core'

/**
 * 纯函数派生。
 *
 * 全部接收一个 cards map 当参数，而不是自己去读 store ——
 * 这样在组件里可以只订阅 cards 一个稳定的引用，
 * 派生结果用 useMemo 缓存，不会触发 zustand 的比较陷阱。
 */

export type CardMap = Record<string, Card>

export function getCard(cards: CardMap, id: string | null | undefined): Card | undefined {
  if (id === null || id === undefined) return undefined
  return cards[id]
}

/** 直接子卡，保持 children 的顺序。 */
export function childrenOf(cards: CardMap, id: string): Card[] {
  const card = cards[id]
  if (card === undefined) return []
  return card.children.map((entry) => cards[entry.id]).filter((child): child is Card => child !== undefined)
}

/** [父, 祖父, ..., 根]，不含自己。 */
export function ancestorsOf(cards: CardMap, id: string): Card[] {
  const out: Card[] = []
  const seen = new Set<string>([id])
  let current = cards[id]

  while (current !== undefined && current.parent !== null && !seen.has(current.parent)) {
    seen.add(current.parent)
    const parent = cards[current.parent]
    if (parent === undefined) break
    out.push(parent)
    current = parent
  }

  return out
}

/** 从根到自己的完整路径。 */
export function pathOf(cards: CardMap, id: string): Card[] {
  const card = cards[id]
  if (card === undefined) return []
  return [...ancestorsOf(cards, id)].reverse().concat(card)
}

export function isReserved(id: string): boolean {
  return id === '000' || id === '001' || id === '002' || id === '003'
}

/** 浮卡：挂在桌面上、且不是保留根。 */
export function isFloating(cards: CardMap, id: string): boolean {
  const card = cards[id]
  return card !== undefined && card.parent === null && !isReserved(id)
}

/** 被回收站遮住的卡（自己在回收站，或某个祖先在）。 */
export function isHidden(cards: CardMap, id: string): boolean {
  const card = cards[id]
  if (card === undefined) return false
  if (card.trashed === true) return true
  return ancestorsOf(cards, id).some((ancestor) => ancestor.trashed === true)
}

export function visibleChildrenOf(cards: CardMap, id: string): Card[] {
  return childrenOf(cards, id).filter((child) => !isHidden(cards, child.id))
}

export function allVisible(cards: CardMap): Card[] {
  return Object.values(cards).filter((card) => !isHidden(cards, card.id))
}

/** 所有根卡片（含保留根），按 id 排序。 */
export function roots(cards: CardMap): Card[] {
  return Object.values(cards)
    .filter((card) => card.parent === null && card.trashed !== true)
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function floatingCards(cards: CardMap): Card[] {
  return roots(cards).filter((card) => !isReserved(card.id))
}

export function boardColumns(cards: CardMap): Card[] {
  return visibleChildrenOf(cards, '001')
}

/** 面包屑：从窗口的根卡到当前聚焦的卡。 */
export function crumbsWithin(cards: CardMap, windowRootId: string, focusId: string): Card[] {
  const full = pathOf(cards, focusId)
  const rootIndex = full.findIndex((card) => card.id === windowRootId)
  return rootIndex >= 0 ? full.slice(rootIndex) : full
}
