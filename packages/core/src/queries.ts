import type { Card, Scope, ViewMode } from './types.ts'
import { BOARD_ID } from './types.ts'
import type { Workspace } from './workspace.ts'

/**
 * 只读查询。
 *
 * 给 AI 用的读取工具比写入工具还重要——看不见就看不懂。
 * 但上下文预算是稀缺的，所以这里一律返回**紧凑视图**：
 * 默认不带正文，要正文得明说。
 */

export interface CardView {
  id: string
  title: string
  parent: string | null
  view?: ViewMode
  scope: Scope
  childCount: number
  color?: string
  due?: string | null
  tags?: string[]
  trashed?: boolean
  /** 正文摘要，只有在明确要求时才出现 */
  excerpt?: string
  createdAt: number
  updatedAt: number
}

export interface CardDetail extends CardView {
  content?: string
  children?: CardView[]
  /** 从根到自己的 id 链，方便 AI 知道自己在哪 */
  path?: Array<{ id: string; title: string }>
  /** 回收站里的卡：这张卡为什么看不见 */
  hiddenBecause?: string
}

export interface TreeNode extends CardView {
  children: TreeNode[]
  /** 达到深度上限被截断，还有子卡没展开 */
  cut?: boolean
}

export interface SearchHit extends CardView {
  matchedIn: Array<'title' | 'content' | 'tags'>
  excerpt?: string
}

export interface BoardColumnView {
  column: CardView
  cardCount: number
  cards: CardView[]
}

export interface BoardOverview {
  board: CardView
  columns: BoardColumnView[]
}

export interface WorkspaceInfo {
  root: string
  name: string
  workspaceId: string
  formatVersion: number
  cardCount: number
  visibleCardCount: number
  trashedCardCount: number
  roots: CardView[]
  floatingCards: CardView[]
  lastSeq: number
  /** 不变量：一张卡在哪一列由 parent 决定。这里显式说明，免得 AI 去找 status 字段。 */
  note: string
}

const SCOPE_NOTE = '没有 status 字段：一张卡在哪一列由它的 parent 决定。'

function excerptAround(text: string, needle: string, radius = 40): string | undefined {
  if (text === '') return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (needle === '') return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat

  const index = flat.toLowerCase().indexOf(needle.toLowerCase())
  if (index < 0) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat

  const start = Math.max(0, index - radius)
  const end = Math.min(flat.length, index + needle.length + radius)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export function toCardView(card: Card, options: { excerpt?: number } = {}): CardView {  const view: CardView = {
    id: card.id,
    title: card.title,
    parent: card.parent,
    scope: card.scope,
    childCount: card.children.length,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  }

  if (card.view !== undefined) view.view = card.view
  if (card.color !== undefined) view.color = card.color
  if (card.due !== undefined) view.due = card.due
  if (card.tags !== undefined && card.tags.length > 0) view.tags = [...card.tags]
  if (card.trashed === true) view.trashed = true

  if (options.excerpt !== undefined && options.excerpt > 0) {
    const text = excerptAround(card.content, '', options.excerpt)
    if (text !== undefined) view.excerpt = text
  }

  return view
}

/**
 * 可见的直接子卡。
 * 查询层一律走这个：回收站里的卡，以及被回收站祖先压住的卡，都不该出现在视图里。
 */
function visibleChildren(workspace: Workspace, id: string): Card[] {
  return workspace.childCards(id).filter((card) => !workspace.isHidden(card.id))
}

export function workspaceInfo(workspace: Workspace): WorkspaceInfo {
  const all = workspace.allCards()
  const visible = workspace.visibleCards()
  const trashed = all.filter((card) => card.trashed === true)

  return {
    root: workspace.paths.root,
    name: workspace.meta.name,
    workspaceId: workspace.meta.id,
    formatVersion: workspace.meta.version,
    cardCount: all.length,
    visibleCardCount: visible.length,
    trashedCardCount: trashed.length,
    roots: workspace.roots().map((card) => toCardView(card)),
    floatingCards: workspace.floatingCards().map((card) => toCardView(card)),
    lastSeq: workspace.lastSeq(),
    note: SCOPE_NOTE,
  }
}

export function boardOverview(
  workspace: Workspace,
  boardId: string = BOARD_ID,
  options: { limitPerColumn?: number } = {},
): BoardOverview {
  const board = workspace.requireCard(boardId)
  const limit = options.limitPerColumn ?? 50

  const columns: BoardColumnView[] = visibleChildren(workspace, boardId).map((column) => {
    const cards = visibleChildren(workspace, column.id)
    return {
      column: toCardView(column),
      cardCount: cards.length,
      cards: cards.slice(0, limit).map((card) => toCardView(card, { excerpt: 0 })),
    }
  })

  return { board: toCardView(board), columns }
}

export function cardDetail(
  workspace: Workspace,
  id: string,
  options: { includeContent?: boolean; includeChildren?: boolean; includePath?: boolean; allowTrashed?: boolean } = {},
): CardDetail {
  const card = workspace.requireCard(id, { allowTrashed: options.allowTrashed === true })

  const detail: CardDetail = toCardView(card)

  if (options.includeContent === true) detail.content = card.content

  if (options.includeChildren === true) {
    detail.children = visibleChildren(workspace, id).map((child) => toCardView(child, { excerpt: 60 }))
  }

  if (options.includePath !== false) {
    const chain = workspace.ancestorsOf(id)
    detail.path = [...chain].reverse().map((node) => ({ id: node.id, title: node.title }))
  }

  if (workspace.isHidden(id)) {
    detail.hiddenBecause =
      card.trashed === true ? '这张卡自己在回收站里。' : '它的某个父卡在回收站里，所以整棵子树都看不见。'
  }

  return detail
}

export function treeView(
  workspace: Workspace,
  rootId: string,
  options: { depth?: number; includeTrashed?: boolean } = {},
): TreeNode {
  const depth = options.depth ?? 2
  const includeTrashed = options.includeTrashed === true

  const build = (id: string, remaining: number): TreeNode => {
    const card = workspace.requireCard(id, { allowTrashed: includeTrashed })
    const node: TreeNode = { ...toCardView(card), children: [] }

    const children =
      includeTrashed ? workspace.childCards(id) : visibleChildren(workspace, id)
    if (remaining <= 0) {
      if (children.length > 0) node.cut = true
      return node
    }
    node.children = children.map((child) => build(child.id, remaining - 1))
    return node
  }

  return build(rootId, depth)
}

export function searchCards(
  workspace: Workspace,
  query: string,
  options: { limit?: number; scope?: string; includeContent?: boolean } = {},
): SearchHit[] {
  const limit = options.limit ?? 30
  const needle = query.trim()
  if (needle === '') return []

  const lower = needle.toLowerCase()
  const hits: SearchHit[] = []

  for (const card of workspace.visibleCards()) {
    const matchedIn: Array<'title' | 'content' | 'tags'> = []

    if (card.title.toLowerCase().includes(lower)) matchedIn.push('title')
    if (card.content.toLowerCase().includes(lower)) matchedIn.push('content')
    if (card.tags?.some((tag) => tag.toLowerCase().includes(lower)) === true) matchedIn.push('tags')

    if (matchedIn.length === 0) continue

    const hit: SearchHit = { ...toCardView(card), matchedIn }
    const excerpt = excerptAround(card.content, needle)
    if (excerpt !== undefined && options.includeContent !== false) hit.excerpt = excerpt
    hits.push(hit)

    if (hits.length >= limit) break
  }

  // 标题命中排在正文命中前面——大部分时候人找的是名字。
  hits.sort((a, b) => {
    const aTitle = a.matchedIn.includes('title') ? 0 : 1
    const bTitle = b.matchedIn.includes('title') ? 0 : 1
    if (aTitle !== bTitle) return aTitle - bTitle
    return b.updatedAt - a.updatedAt
  })

  return hits
}

export function listCards(
  workspace: Workspace,
  options: { parent?: string | null; includeTrashed?: boolean; limit?: number } = {},
): CardView[] {
  const limit = options.limit ?? 200

  if (options.parent !== undefined) {
    if (options.parent === null) {
      return workspace
        .roots({ includeTrashed: options.includeTrashed === true })
        .slice(0, limit)
        .map((card) => toCardView(card))
    }
    return workspace
      .childCards(options.parent)
      .filter((card) => (options.includeTrashed === true ? true : !workspace.isHidden(card.id)))
      .slice(0, limit)
      .map((card) => toCardView(card, { excerpt: 60 }))
  }

  const cards = options.includeTrashed === true ? workspace.allCards() : workspace.visibleCards()
  return cards.slice(0, limit).map((card) => toCardView(card))
}

export function trashedCards(workspace: Workspace, limit = 50): CardView[] {
  return workspace
    .allCards()
    .filter((card) => card.trashed === true)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((card) => toCardView(card, { excerpt: 60 }))
}
