import { KkbError } from './errors.ts'
import type { Card, Scope } from './types.ts'
import { isReservedId } from './types.ts'

/**
 * 纯粹的树操作。全部基于一个查表函数，不碰存储，方便单测。
 *
 * 每个遍历都带 seen 集合：树一旦有环，遍历会变成死循环。
 * 加载时会做完整校验，但遍历本身也要自保——毕竟校验代码本身也可能有 bug。
 */

export type CardLookup = (id: string) => Card | undefined

const MAX_DEPTH = 4096

function treeCorrupt(reason: string, details: Record<string, unknown> = {}): KkbError {
  return new KkbError('TREE_CORRUPT', `树结构有问题：${reason}`, details)
}

/** [父, 祖父, ..., 根]。不含自己。 */
export function ancestorsOf(get: CardLookup, id: string): Card[] {
  const out: Card[] = []
  const seen = new Set<string>([id])

  let current = get(id)
  if (current === undefined) throw new KkbError('CARD_NOT_FOUND', `找不到卡片 ${id}。`, { id })

  while (current.parent !== null) {
    const parentId = current.parent
    if (seen.has(parentId)) {
      throw treeCorrupt(`卡片 ${id} 的祖先链里出现了环`, { id, repeated: parentId })
    }
    seen.add(parentId)

    const parent = get(parentId)
    if (parent === undefined) {
      throw treeCorrupt(`卡片 ${current.id} 的 parent 指向 ${parentId}，但那张卡不存在`, {
        id: current.id,
        missingParent: parentId,
      })
    }
    out.push(parent)
    current = parent

    if (out.length > MAX_DEPTH) {
      throw treeCorrupt(`卡片 ${id} 的祖先链超过 ${MAX_DEPTH} 层，几乎可以肯定有环`, { id })
    }
  }

  return out
}

/** 所在树的根卡片。 */
export function rootOf(get: CardLookup, id: string): Card {
  const card = get(id)
  if (card === undefined) throw new KkbError('CARD_NOT_FOUND', `找不到卡片 ${id}。`, { id })
  const chain = ancestorsOf(get, id)
  return chain.length === 0 ? card : (chain[chain.length - 1] as Card)
}

/** 深度。根为 0。 */
export function depthOf(get: CardLookup, id: string): number {
  return ancestorsOf(get, id).length
}

/**
 * 作用域是派生的：看这棵树挂在哪个根下就知道。
 * 保留根（000 主壳 / 001 看板 / 002 灵感台 / 003 预制体）底下是公有，浮卡底下是私有。
 */
export function scopeOf(get: CardLookup, id: string): Scope {
  return isReservedId(rootOf(get, id).id) ? 'public' : 'private'
}

/** 直接子卡，按 children 的顺序，跳过不存在的（正常加载不会有）。 */
export function childCardsOf(get: CardLookup, id: string): Card[] {
  const card = get(id)
  if (card === undefined) return []
  const out: Card[] = []
  for (const entry of card.children) {
    const child = get(entry.id)
    if (child !== undefined) out.push(child)
  }
  return out
}

/** 所有后代，深度优先，不含自己。 */
export function descendantsOf(get: CardLookup, id: string): Card[] {
  const out: Card[] = []
  const seen = new Set<string>([id])

  const walk = (cardId: string): void => {
    for (const child of childCardsOf(get, cardId)) {
      if (seen.has(child.id)) {
        throw treeCorrupt(`卡片 ${id} 的子树里出现了环`, { id, repeated: child.id })
      }
      seen.add(child.id)
      out.push(child)
      walk(child.id)
    }
  }

  walk(id)
  return out
}

/** id 和它的所有后代。 */
export function subtreeOf(get: CardLookup, id: string): Card[] {
  const card = get(id)
  if (card === undefined) throw new KkbError('CARD_NOT_FOUND', `找不到卡片 ${id}。`, { id })
  return [card, ...descendantsOf(get, id)]
}

/** candidate 是不是 ancestor 的后代（不含相等）。 */
export function isDescendantOf(get: CardLookup, candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return false
  return ancestorsOf(get, candidate).some((card) => card.id === ancestor)
}

/** 子卡在父卡 children 里的下标，找不到返回 -1。 */
export function childIndex(card: Card, childId: string): number {
  return card.children.findIndex((entry) => entry.id === childId)
}

/**
 * 移动前的环检查。
 * 把一张卡塞进自己的子树里会让那棵子树整个脱离森林，而且再也捞不回来。
 */
export function assertMovable(get: CardLookup, id: string, newParentId: string | null): void {
  if (newParentId === null) return
  if (id === newParentId) {
    throw new KkbError('CYCLE_DETECTED', `不能把卡片 ${id} 移动到它自己里面。`, { id })
  }
  if (isDescendantOf(get, newParentId, id)) {
    throw new KkbError('CYCLE_DETECTED', `不能把卡片 ${id} 移动到它自己的后代 ${newParentId} 里面。`, {
      id,
      newParent: newParentId,
    })
  }
}
