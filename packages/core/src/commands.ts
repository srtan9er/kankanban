import { KkbError, reservedCard } from './errors.ts'
import { assertMovable, childIndex, scopeOf } from './tree.ts'
import type { Card, ChildEntry, Layout, Scope, ViewMode, WindowState } from './types.ts'
import { DEFAULT_VIEW, isReservedId, VIEW_MODES } from './types.ts'
import { clamp, clone, deepEqual, isPlainObject, uniqueStrings } from './utils.ts'

/**
 * 命令层：人类操作的唯一入口。
 *
 * UI 直接调它，MCP server 把它包成工具。所以「拖拽」这种手势在这里
 * 表达成意图（移动到某父卡的第 N 位），而不是鼠标事件。
 *
 * 命令实现只依赖 CommandHost 这个窄接口，不碰文件、不碰 EventLog，
 * 于是语义可以单独测，存储换实现也不影响这里。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 用于撤销/重做时精确还原一张卡的全部字段。 */
export interface CardSnapshot {
  children?: ChildEntry[]
  title?: string
  content?: string
  view?: ViewMode
  color?: string
  due?: string | null
  tags?: string[]
  trashed?: boolean
  isPrefab?: boolean
  prefabRef?: string | null
  overrides?: Record<string, unknown>
  window?: WindowState
  createdAt?: number
  updatedAt?: number
  createdBy?: string
}

export interface CardPatch {
  title?: string
  content?: string
  view?: ViewMode | null
  color?: string | null
  due?: string | null
  tags?: string[] | null
  window?: WindowState | null
  isPrefab?: boolean
  prefabRef?: string | null
  overrides?: Record<string, unknown> | null
}

export type Command =
  | {
      type: 'card_create'
      /** null 表示建在桌面上，也就是一张浮卡。 */
      parent: string | null
      index?: number
      /** 显式 id，只给撤销/重做用。正常建卡不要传，让系统生成。 */
      id?: string
      title?: string
      content?: string
      view?: ViewMode
      color?: string
      due?: string | null
      tags?: string[]
      snapshot?: CardSnapshot
    }
  | { type: 'card_update'; id: string; patch: CardPatch }
  | { type: 'card_move'; id: string; parent: string | null; index?: number; layout?: Layout }
  | { type: 'card_trash'; id: string }
  | { type: 'card_restore'; id: string }
  | { type: 'children_reorder'; parent: string; order: string[] }
  | { type: 'children_layout'; parent: string; id: string; layout?: Layout }
  | { type: 'card_purge'; id: string }

export type CommandType = Command['type']

/** 阶段二要用：这些命令会改变「哪些卡应该是独立窗口」。 */
export interface WindowOp {
  op: 'open' | 'close'
  cardId: string
}

export interface HistoryEntry {
  label: string
  undo: Command
  redo: Command
  /**
   * 被这次命令碰到的卡片的 updatedAt 前后值。
   * 有了它，撤销之后文件能逐字节回到原样，而不是只回到「语义一样」。
   */
  stamps: Record<string, { before: number; after: number }>
}

export interface CommandResult {
  history: HistoryEntry | null
  created?: string
  windowOps: WindowOp[]
  warnings: string[]
}

// ---------------------------------------------------------------------------
// 命令实现依赖的窄接口
// ---------------------------------------------------------------------------

export interface EmittedEvent {
  cardId: string
  type: 'field_set' | 'child_add' | 'child_remove' | 'children_order' | 'card_trash' | 'card_restore'
  path: string
  before?: unknown
  after?: unknown
}

export interface CommandHost {
  now(): number
  lookup: (id: string) => Card | undefined
  require(id: string, options?: { allowTrashed?: boolean }): Card
  nextCardId(): string
  /** 设置顶层字段。value 为 undefined 表示清除该字段。 */
  setField(
    id: string,
    field: string,
    value: unknown,
    options?: { eventType?: 'field_set' | 'card_trash' | 'card_restore' },
  ): void
  /** 把一张构造好的卡放进内存与待写队列。 */
  putCard(card: Card): void
  /** 彻底移除一张卡（不含父子关系处理）。 */
  purgeCard(id: string): void
  insertChild(parentId: string, index: number, entry: ChildEntry, card: Card): void
  removeChildAt(parentId: string, index: number): ChildEntry
  setChildren(parentId: string, entries: ChildEntry[]): void
  emit(event: EmittedEvent): void
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function defaultWindowState(seed = 0): WindowState {
  return {
    x: 120 + (seed % 6) * 32,
    y: 120 + Math.floor(seed / 6) * 32,
    width: 320,
    height: 240,
    alwaysOnTop: false,
    minimized: false,
  }
}

export function defaultLayout(seed = 0): Layout {
  return {
    x: 40 + (seed % 8) * 40,
    y: 40 + Math.floor(seed / 8) * 40,
    w: 200,
    h: 160,
    z: seed + 1,
  }
}

/** 新卡片的缺省视图：建在看板里就是「一列」，其余情况是一行。 */
function defaultViewFor(parent: Card | null): ViewMode {
  if (parent?.view === 'kanban') return 'column'
  return DEFAULT_VIEW
}

function normalizeLayout(input: Layout): Layout {
  const nums: Array<keyof Layout> = ['x', 'y', 'w', 'h', 'z']
  for (const key of nums) {
    const value = input[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new KkbError('INVALID_ARGUMENT', `layout.${key} 应该是有限数字，实际是 ${String(value)}。`, {
        field: key,
        value,
      })
    }
  }
  return { x: input.x, y: input.y, w: input.w, h: input.h, z: input.z }
}

function invalid(field: string, expected: string, value: unknown): KkbError {
  return new KkbError('INVALID_ARGUMENT', `字段 ${field} ${expected}，实际是 ${JSON.stringify(value) ?? String(value)}。`, {
    field,
    value,
  })
}

function normalizeWindowState(value: WindowState): WindowState {
  const nums: Array<'x' | 'y' | 'width' | 'height'> = ['x', 'y', 'width', 'height']
  for (const key of nums) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw invalid(`window.${key}`, '应该是有限数字', value[key])
    }
  }
  if (typeof value.alwaysOnTop !== 'boolean') throw invalid('window.alwaysOnTop', '应该是布尔值', value.alwaysOnTop)
  if (typeof value.minimized !== 'boolean') throw invalid('window.minimized', '应该是布尔值', value.minimized)
  return {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    alwaysOnTop: value.alwaysOnTop,
    minimized: value.minimized,
  }
}

/** 校验并规范化一个补丁字段。返回 undefined 表示「清除该字段」。 */
function normalizePatchValue(field: string, value: unknown, card: Card): unknown {
  if (value === null) {
    if (field === 'title' || field === 'content') {
      throw invalid(field, '不能为 null（这是必填字段）', value)
    }
    return undefined
  }

  switch (field) {
    case 'title':
      if (typeof value !== 'string') throw invalid(field, '应该是字符串', value)
      return value
    case 'content':
      if (typeof value !== 'string') throw invalid(field, '应该是字符串', value)
      return value
    case 'view': {
      if (typeof value !== 'string' || !(VIEW_MODES as readonly string[]).includes(value)) {
        throw invalid(field, `只能是 ${VIEW_MODES.join(' / ')}`, value)
      }
      if (isReservedId(card.id)) {
        throw reservedCard(card.id, `把 view 改成 "${value}"（保留根的视图由 id 决定）`)
      }
      return value
    }
    case 'color':
      if (typeof value !== 'string' || !COLOR_RE.test(value)) {
        throw invalid(field, '应该是 #RRGGBB 形式的颜色', value)
      }
      return value
    case 'due':
      if (typeof value !== 'string' || !DATE_RE.test(value)) {
        throw invalid(field, '应该是 YYYY-MM-DD 形式的日期', value)
      }
      return value
    case 'tags':
      if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) {
        throw invalid(field, '应该是字符串列表', value)
      }
      return uniqueStrings(value as string[])
    case 'window':
      if (!isPlainObject(value)) throw invalid(field, '应该是对象', value)
      return normalizeWindowState(value as unknown as WindowState)
    case 'isPrefab':
      if (typeof value !== 'boolean') throw invalid(field, '应该是布尔值', value)
      return value
    case 'prefabRef':
      if (typeof value !== 'string') throw invalid(field, '应该是卡片 id 字符串', value)
      return value
    case 'overrides':
      if (!isPlainObject(value)) throw invalid(field, '应该是对象', value)
      return { ...value }
    default:
      throw new KkbError(
        'INVALID_ARGUMENT',
        `字段 ${field} 不能通过 card_update 修改。` +
          `结构类的改动请用 card_move / children_reorder / children_layout / card_trash。`,
        { field },
      )
  }
}

function snapshotToCard(
  snapshot: CardSnapshot,
  base: { id: string; parent: string | null; scope: Scope; now: number },
): Card {
  const card: Card = {
    id: base.id,
    parent: base.parent,
    children: snapshot.children !== undefined ? snapshot.children.map((entry) => clone(entry)) : [],
    title: snapshot.title ?? '新卡片',
    content: snapshot.content ?? '',
    scope: base.scope,
    createdAt: snapshot.createdAt ?? base.now,
    updatedAt: snapshot.updatedAt ?? base.now,
    createdBy: snapshot.createdBy ?? 'local',
  }

  if (snapshot.view !== undefined) card.view = snapshot.view
  if (snapshot.trashed === true) card.trashed = true
  if (snapshot.color !== undefined) card.color = snapshot.color
  if (snapshot.due !== undefined) card.due = snapshot.due
  if (snapshot.tags !== undefined && snapshot.tags.length > 0) card.tags = [...snapshot.tags]
  if (snapshot.isPrefab === true) card.isPrefab = true
  if (snapshot.prefabRef !== undefined && snapshot.prefabRef !== null) card.prefabRef = snapshot.prefabRef
  if (snapshot.overrides !== undefined && Object.keys(snapshot.overrides).length > 0) {
    card.overrides = { ...snapshot.overrides }
  }
  if (snapshot.window !== undefined) card.window = { ...snapshot.window }

  return card
}

/** 把一张卡完整拍成快照，用于撤销/重做时的精确还原。 */
export function fullSnapshot(card: Card): CardSnapshot {
  const snapshot: CardSnapshot = {
    children: card.children.map((entry) => clone(entry)),
    title: card.title,
    content: card.content,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    createdBy: card.createdBy,
  }
  if (card.view !== undefined) snapshot.view = card.view
  if (card.trashed === true) snapshot.trashed = true
  if (card.color !== undefined) snapshot.color = card.color
  if (card.due !== undefined) snapshot.due = card.due
  if (card.tags !== undefined) snapshot.tags = [...card.tags]
  if (card.isPrefab === true) snapshot.isPrefab = true
  if (card.prefabRef !== undefined && card.prefabRef !== null) snapshot.prefabRef = card.prefabRef
  if (card.overrides !== undefined) snapshot.overrides = { ...card.overrides }
  if (card.window !== undefined) snapshot.window = { ...card.window }
  return snapshot
}

// ---------------------------------------------------------------------------
// 分派
// ---------------------------------------------------------------------------

export function executeCommand(host: CommandHost, command: Command): CommandResult {
  switch (command.type) {
    case 'card_create':
      return cmdCardCreate(host, command)
    case 'card_update':
      return cmdCardUpdate(host, command)
    case 'card_move':
      return cmdCardMove(host, command)
    case 'card_trash':
      return cmdCardTrash(host, command)
    case 'card_restore':
      return cmdCardRestore(host, command)
    case 'children_reorder':
      return cmdChildrenReorder(host, command)
    case 'children_layout':
      return cmdChildrenLayout(host, command)
    case 'card_purge':
      return cmdCardPurge(host, command)
  }
}

const emptyResult = (): CommandResult => ({ history: null, windowOps: [], warnings: [] })

// ---------------------------------------------------------------------------
// card_create
// ---------------------------------------------------------------------------

function cmdCardCreate(
  host: CommandHost,
  command: Extract<Command, { type: 'card_create' }>,
): CommandResult {
  // require 默认就会拒绝回收站里的卡，所以这里不需要再单独判一次。
  const parent = command.parent === null ? null : host.require(command.parent)

  let id: string
  if (command.id !== undefined) {
    if (host.lookup(command.id) !== undefined) {
      throw new KkbError('ID_DUPLICATE', `卡片 id ${command.id} 已经存在了，不能重复使用。`, {
        id: command.id,
      })
    }
    id = command.id
  } else {
    id = host.nextCardId()
  }

  const snapshot: CardSnapshot = command.snapshot !== undefined ? clone(command.snapshot) : {}
  if (snapshot.title === undefined && command.title !== undefined) snapshot.title = command.title
  if (snapshot.content === undefined && command.content !== undefined) snapshot.content = command.content
  if (snapshot.view === undefined) {
    if (command.view !== undefined) {
      if (!(VIEW_MODES as readonly string[]).includes(command.view)) {
        throw invalid('view', `只能是 ${VIEW_MODES.join(' / ')}`, command.view)
      }
      snapshot.view = command.view
    } else {
      snapshot.view = defaultViewFor(parent)
    }
  }
  if (snapshot.color === undefined && command.color !== undefined) snapshot.color = command.color
  if (snapshot.due === undefined && command.due !== undefined) snapshot.due = command.due
  if (snapshot.tags === undefined && command.tags !== undefined) snapshot.tags = uniqueStrings(command.tags)

  const now = host.now()
  const scope: Scope = parent === null ? 'private' : scopeOf(host.lookup, parent.id)
  const card = snapshotToCard(snapshot, { id, parent: command.parent, scope, now })

  const windowOps: WindowOp[] = []
  if (parent === null) {
    if (card.window === undefined) card.window = defaultWindowState(0)
    windowOps.push({ op: 'open', cardId: id })
  }

  const targetLength = parent === null ? 0 : parent.children.length
  const index = clamp(command.index ?? targetLength, 0, targetLength)

  host.putCard(card)

  if (parent !== null) {
    const entry: ChildEntry =
      parent.view === 'plane' ? { id, layout: defaultLayout(index) } : { id }
    host.insertChild(parent.id, index, entry, card)
  }

  return {
    history: {
      label: `建立卡片「${card.title}」`,
      undo: { type: 'card_purge', id },
      redo: { type: 'card_create', parent: command.parent, index, id, snapshot: fullSnapshot(card) },
      stamps: {},
    },
    created: id,
    windowOps,
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// card_update
// ---------------------------------------------------------------------------

function cmdCardUpdate(
  host: CommandHost,
  command: Extract<Command, { type: 'card_update' }>,
): CommandResult {
  const card = host.require(command.id)
  if (card.trashed === true) {
    throw new KkbError('CARD_TRASHED', `卡片「${card.title}」(${card.id}) 已在回收站里，先恢复再改。`, {
      id: card.id,
    })
  }

  // 用改动前的标题做操作名，否则撤销栈里会出现「修改卡片「新名字」」这种倒装话。
  const label = card.title
  const restore: CardPatch = {}
  const touched: string[] = []

  for (const [field, rawValue] of Object.entries(command.patch)) {
    if (rawValue === undefined) continue

    const value = normalizePatchValue(field, rawValue, card)
    const before = (card as unknown as Record<string, unknown>)[field]
    if (deepEqual(before, value)) continue

    // 撤销时用当初的值反向再改一次。null 表示「这个字段当初不存在」。
    ;(restore as Record<string, unknown>)[field] = before ?? null

    host.setField(card.id, field, value)
    touched.push(field)
  }

  if (touched.length === 0) return emptyResult()

  return {
    history: {
      label: `修改卡片「${label}」的 ${touched.join('、')}`,
      undo: { type: 'card_update', id: card.id, patch: restore },
      redo: command,
      stamps: {},
    },
    windowOps: [],
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// card_move
// ---------------------------------------------------------------------------

function cmdCardMove(
  host: CommandHost,
  command: Extract<Command, { type: 'card_move' }>,
): CommandResult {
  const card = host.require(command.id)
  if (isReservedId(card.id)) throw reservedCard(card.id, '移动')
  if (card.trashed === true) {
    throw new KkbError('CARD_TRASHED', `卡片「${card.title}」(${card.id}) 已在回收站里，先恢复再移动。`, {
      id: card.id,
    })
  }

  const oldParentId = card.parent
  const newParentId = command.parent

  const oldParent = oldParentId === null ? null : host.require(oldParentId, { allowTrashed: true })
  const oldIndex = oldParent === null ? -1 : childIndex(oldParent, card.id)
  const oldEntry = oldParent !== null && oldIndex >= 0 ? clone(oldParent.children[oldIndex]) : undefined

  const newParent = newParentId === null ? null : host.require(newParentId)

  assertMovable(host.lookup, card.id, newParentId)

  const sameParent = oldParent !== null && oldParent.id === newParentId

  // 落点：同父移动时，下标是「取出之后」的坐标系。
  const availableSlots =
    newParent === null ? 0 : newParent.children.length - (sameParent && oldIndex >= 0 ? 1 : 0)
  const index = newParent === null ? 0 : clamp(command.index ?? availableSlots, 0, availableSlots)

  // 同一个父卡里原地不动：不留事件、不进历史。
  if (sameParent && index === oldIndex) return emptyResult()

  // 计算落点布局：只有 plane 视图的容器才存坐标。
  let layout: Layout | undefined
  if (newParent !== null) {
    if (newParent.view === 'plane') {
      layout =
        command.layout !== undefined
          ? normalizeLayout(command.layout)
          : (oldEntry?.layout ?? defaultLayout(availableSlots))
    }
  }

  const windowOps: WindowOp[] = []
  const warnings: string[] = []

  if (oldParent !== null && oldIndex >= 0) host.removeChildAt(oldParent.id, oldIndex)

  if (newParent !== null) {
    host.insertChild(newParent.id, index, layout !== undefined ? { id: card.id, layout } : { id: card.id }, card)
  }

  if (oldParentId !== newParentId) {
    host.setField(card.id, 'parent', newParentId)
  }

  if (newParent === null) {
    windowOps.push({ op: 'open', cardId: card.id })
    if (card.window === undefined) {
      host.setField(card.id, 'window', defaultWindowState(index))
    }
  } else if (oldParentId === null) {
    windowOps.push({ op: 'close', cardId: card.id })
  }

  // 作用域跟着所在的树走，整棵子树一起变。
  const newScope = scopeOf(host.lookup, card.id)
  const scopeChanged: string[] = []
  for (const node of [card, ...descendantsOfSafe(host, card.id)]) {
    if (node.scope !== newScope) {
      host.setField(node.id, 'scope', newScope)
      scopeChanged.push(node.id)
    }
  }

  if (card.parent === null) {
    warnings.push(`「${card.title}」现在是浮在桌面上的独立窗口。`)
  }

  return {
    history: {
      label: `移动卡片「${card.title}」`,
      undo: {
        type: 'card_move',
        id: card.id,
        parent: oldParentId,
        ...(oldIndex >= 0 ? { index: oldIndex } : {}),
        ...(oldEntry?.layout !== undefined ? { layout: clone(oldEntry.layout) } : {}),
      },
      redo: { ...command, parent: newParentId, index },
      stamps: {},
    },
    windowOps,
    warnings:
      scopeChanged.length > 0
        ? [...warnings, `${scopeChanged.length} 张卡的作用域跟着变成了 ${newScope}。`]
        : warnings,
  }
}

/** descendantsOf 的容错版：树万一有问题也不要让移动彻底失败。 */
function descendantsOfSafe(host: CommandHost, id: string): Card[] {
  const out: Card[] = []
  const seen = new Set<string>([id])
  const walk = (cardId: string): void => {
    const card = host.lookup(cardId)
    if (card === undefined) return
    for (const entry of card.children) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      const child = host.lookup(entry.id)
      if (child === undefined) continue
      out.push(child)
      walk(entry.id)
    }
  }
  walk(id)
  return out
}

// ---------------------------------------------------------------------------
// card_trash / card_restore
// ---------------------------------------------------------------------------

function cmdCardTrash(
  host: CommandHost,
  command: Extract<Command, { type: 'card_trash' }>,
): CommandResult {
  const card = host.require(command.id, { allowTrashed: true })
  if (isReservedId(card.id)) throw reservedCard(card.id, '删除')
  if (card.trashed === true) return emptyResult()

  const descendants = descendantsOfSafe(host, card.id)
  const warnings =
    descendants.length > 0
      ? [`「${card.title}」下面还有 ${descendants.length} 张子卡，它们会一起从视图里消失（没有真的删掉，恢复时会一起回来）。`]
      : []

  host.setField(card.id, 'trashed', true, { eventType: 'card_trash' })

  const windowOps: WindowOp[] = card.parent === null ? [{ op: 'close', cardId: card.id }] : []

  return {
    history: {
      label: `删除卡片「${card.title}」`,
      undo: { type: 'card_restore', id: card.id },
      redo: { type: 'card_trash', id: card.id },
      stamps: {},
    },
    windowOps,
    warnings,
  }
}

/** 自己的祖先里有哪些在回收站里。用来解释「为什么恢复了还是看不见」。 */
function trashedAncestors(host: CommandHost, card: Card): string[] {
  const chain: string[] = []
  const seen = new Set<string>([card.id])
  let cursor = card.parent === null ? undefined : host.lookup(card.parent)
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    if (cursor.trashed === true) chain.push(`「${cursor.title}」(${cursor.id})`)
    cursor = cursor.parent === null ? undefined : host.lookup(cursor.parent)
  }
  return chain
}

function cmdCardRestore(
  host: CommandHost,
  command: Extract<Command, { type: 'card_restore' }>,
): CommandResult {
  const card = host.require(command.id, { allowTrashed: true })
  const chain = trashedAncestors(host, card)
  const blockedByAncestor = chain.length > 0

  if (card.trashed !== true) {
    // 自己没被删，但可能因为祖先被删而看不见。这种「恢复了个寂寞」的情况要说清楚。
    if (!blockedByAncestor) return emptyResult()
    return {
      history: null,
      windowOps: [],
      warnings: [
        `卡片「${card.title}」(${card.id}) 自己不在回收站里，` +
          `但它所在的 ${chain.join(' → ')} 还在，所以它仍然看不见。`,
      ],
    }
  }

  host.setField(card.id, 'trashed', undefined, { eventType: 'card_restore' })

  const windowOps: WindowOp[] = card.parent === null ? [{ op: 'open', cardId: card.id }] : []
  const warnings = blockedByAncestor
    ? [`恢复成功，但它所在的 ${chain.join(' → ')} 还在回收站里，所以暂时不会重新出现在视图里。`]
    : []

  return {
    history: {
      label: `恢复卡片「${card.title}」`,
      undo: { type: 'card_trash', id: card.id },
      redo: { type: 'card_restore', id: card.id },
      stamps: {},
    },
    windowOps,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// children_reorder
// ---------------------------------------------------------------------------

function cmdChildrenReorder(
  host: CommandHost,
  command: Extract<Command, { type: 'children_reorder' }>,
): CommandResult {
  const parent = host.require(command.parent)
  if (parent.trashed === true) {
    throw new KkbError('CARD_TRASHED', `「${parent.title}」(${parent.id}) 已在回收站里。`, {
      id: parent.id,
    })
  }

  const before = parent.children.map((entry) => entry.id)
  const after = command.order

  if (after.length !== before.length) {
    throw new KkbError(
      'INVALID_ARGUMENT',
      `新的顺序有 ${after.length} 项，但「${parent.title}」下面有 ${before.length} 张子卡，数量必须一致。`,
      { expected: before.length, got: after.length },
    )
  }

  const beforeSet = new Set(before)
  const seen = new Set<string>()
  for (const id of after) {
    if (!beforeSet.has(id)) {
      throw new KkbError('INVALID_ARGUMENT', `子卡 ${id} 不在「${parent.title}」下面，不能出现在新的顺序里。`, {
        parent: parent.id,
        id,
      })
    }
    if (seen.has(id)) {
      throw new KkbError('INVALID_ARGUMENT', `新的顺序里 ${id} 出现了多次。`, { parent: parent.id, id })
    }
    seen.add(id)
  }

  if (deepEqual(before, after)) return emptyResult()

  const byId = new Map(parent.children.map((entry) => [entry.id, entry]))
  host.setChildren(
    parent.id,
    after.map((id) => clone(byId.get(id) as ChildEntry)),
  )
  host.emit({
    cardId: parent.id,
    type: 'children_order',
    path: '/children',
    before,
    after: [...after],
  })

  return {
    history: {
      label: `调整「${parent.title}」的子卡顺序`,
      undo: { type: 'children_reorder', parent: parent.id, order: before },
      redo: { type: 'children_reorder', parent: parent.id, order: [...after] },
      stamps: {},
    },
    windowOps: [],
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// children_layout
// ---------------------------------------------------------------------------

function cmdChildrenLayout(
  host: CommandHost,
  command: Extract<Command, { type: 'children_layout' }>,
): CommandResult {
  const parent = host.require(command.parent)
  if (parent.trashed === true) {
    throw new KkbError('CARD_TRASHED', `「${parent.title}」(${parent.id}) 已在回收站里。`, {
      id: parent.id,
    })
  }

  const index = childIndex(parent, command.id)
  if (index < 0) {
    throw new KkbError('CARD_NOT_FOUND', `子卡 ${command.id} 不在「${parent.title}」下面。`, {
      parent: parent.id,
      id: command.id,
    })
  }

  const entry = parent.children[index] as ChildEntry
  const before = entry.layout !== undefined ? clone(entry.layout) : undefined
  const after = command.layout !== undefined ? normalizeLayout(command.layout) : undefined

  if (deepEqual(before, after)) return emptyResult()

  const entries = parent.children.map((item, i) =>
    i === index ? (after !== undefined ? { id: item.id, layout: after } : { id: item.id }) : clone(item),
  )
  host.setChildren(parent.id, entries)
  host.emit({
    cardId: parent.id,
    type: 'field_set',
    path: `/children/${index}/layout`,
    before,
    after,
  })

  return {
    history: {
      label: `调整子卡 ${command.id} 的位置`,
      undo: {
        type: 'children_layout',
        parent: parent.id,
        id: command.id,
        ...(before !== undefined ? { layout: before } : {}),
      },
      redo: {
        type: 'children_layout',
        parent: parent.id,
        id: command.id,
        ...(after !== undefined ? { layout: after } : {}),
      },
      stamps: {},
    },
    windowOps: [],
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// card_purge（内部命令，撤销 card_create 用；不对外暴露成 MCP 工具）
// ---------------------------------------------------------------------------

function cmdCardPurge(
  host: CommandHost,
  command: Extract<Command, { type: 'card_purge' }>,
): CommandResult {
  const card = host.require(command.id, { allowTrashed: true })
  if (isReservedId(card.id)) throw reservedCard(card.id, '彻底删除')
  if (card.children.length > 0) {
    throw new KkbError(
      'INVALID_ARGUMENT',
      `卡片「${card.title}」(${card.id}) 下面还有 ${card.children.length} 张子卡，不能直接彻底删除。`,
      { id: card.id, children: card.children.length },
    )
  }

  const parentId = card.parent
  const parent = parentId === null ? null : (host.lookup(parentId) ?? null)
  const index = parent === null ? 0 : childIndex(parent, card.id)
  const snapshot = fullSnapshot(card)

  if (parent !== null && index >= 0) host.removeChildAt(parent.id, index)
  host.purgeCard(card.id)

  const windowOps: WindowOp[] = card.parent === null ? [{ op: 'close', cardId: card.id }] : []

  return {
    history: {
      label: `彻底删除卡片「${card.title}」`,
      undo: {
        type: 'card_create',
        parent: parentId,
        index,
        id: card.id,
        snapshot,
      },
      redo: { type: 'card_purge', id: card.id },
      stamps: {},
    },
    windowOps,
    warnings: [],
  }
}
