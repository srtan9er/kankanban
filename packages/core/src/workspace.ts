import { stat } from 'node:fs/promises'
import path from 'node:path'
import { executeCommand } from './commands.ts'
import type { Command, CommandHost, EmittedEvent, HistoryEntry, WindowOp } from './commands.ts'
import { cardNotFound, KkbError } from './errors.ts'
import { EventLog } from './event-log.ts'
import { createCardId, createEventId } from './ids.ts'
import { acquireLock, kkbPaths, Persistence } from './persistence.ts'
import type { KkbPaths } from './persistence.ts'
import { ancestorsOf, childCardsOf, childIndex, depthOf, descendantsOf, isDescendantOf, scopeOf } from './tree.ts'
import type { Card, ChildEntry, KkbEvent, Scope, ViewMode, WorkspaceMeta } from './types.ts'
import {
  BOARD_ID,
  DEFAULT_BOARD_COLUMNS,
  RESERVED_IDS,
  RESERVED_TITLE,
  RESERVED_VIEW,
  isReservedId,
} from './types.ts'
import { clamp, deepEqual } from './utils.ts'
import { WriteQueue } from './write-queue.ts'

/**
 * 工作区：内存里的树 + 落盘 + 事件日志 + 撤销栈。
 *
 * 这是**唯一的写入入口**。UI 和 MCP 都只能通过 execute() 改数据，
 * 于是「谁改的、改了什么、能不能撤」天然是完整的。
 * 阶段二的窗口广播也是从这里把事件发出去的。
 */

export interface OpenWorkspaceOptions {
  /** 工作区目录，也就是 .kkb 的父目录。 */
  dir: string
  /** false 时目录里没有 .kkb 就报错，而不是新建。缺省 true。 */
  create?: boolean
  /** 是否加工作区锁。缺省 true。 */
  lock?: boolean
  /** 是否补全缺失的保留根卡片。缺省 true。 */
  bootstrap?: boolean
}

export interface ExecuteOptions {
  /** false 表示这次执行不进撤销栈（撤销/重做内部用）。缺省 true。 */
  record?: boolean
  /** 撤销/重做时用来精确还原 updatedAt，保证文件逐字节回到原样。 */
  updatedAtTargets?: Record<string, number>
}

export interface ExecuteOutcome {
  /** 这次执行产生的事件。顺序即发生顺序。 */
  events: KkbEvent[]
  /**
   * 内容有变化的卡片 id。
   *
   * 给 app 层用的：主进程照着这个把「变化后的卡片对象」推给所有窗口，
   * 渲染进程直接替换即可，不需要把事件应用逻辑再实现一遍——两份逻辑一定会漂移。
   */
  changed: string[]
  /** 被彻底删除的卡片 id（撤销建卡时会用到）。 */
  removed: string[]
  /** card_create 建出来的卡片 id。 */
  created?: string
  /** 阶段二要用：哪些卡应该开窗/关窗。 */
  windowOps: WindowOp[]
  /** 给人看的提醒，比如「这张卡下面还有 3 张子卡」。 */
  warnings: string[]
  /** 这次执行是否进了撤销栈。 */
  recorded: boolean
}

const HISTORY_LIMIT = 200

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

export class Workspace {
  readonly paths: KkbPaths
  meta: WorkspaceMeta
  readonly lookup = (id: string): Card | undefined => this.cards.get(id)

  private readonly persistence: Persistence
  private readonly eventLog: EventLog
  /** 命令串行队列，见 execute() 里的说明。 */
  private readonly commandQueue = new WriteQueue()
  private readonly cards = new Map<string, Card>()
  private readonly dirty = new Set<string>()
  private readonly purged: string[] = []
  private readonly undoStack: HistoryEntry[] = []
  private readonly redoStack: HistoryEntry[] = []
  private readonly listeners = new Set<(events: readonly KkbEvent[]) => void>()
  private releaseLockFn: (() => Promise<void>) | null = null
  private pendingEvents: KkbEvent[] = []
  private closed = false
  private closing = false
  private activeOperations = 0
  private idleWaiters: Array<() => void> = []

  private constructor(args: {
    paths: KkbPaths
    meta: WorkspaceMeta
    cards: Map<string, Card>
    eventLog: EventLog
    persistence: Persistence
    releaseLock: (() => Promise<void>) | null
  }) {
    this.paths = args.paths
    this.meta = args.meta
    this.cards = args.cards
    this.eventLog = args.eventLog
    this.persistence = args.persistence
    this.releaseLockFn = args.releaseLock
  }

  // -------------------------------------------------------------------------
  // 打开 / 关闭
  // -------------------------------------------------------------------------

  static async open(options: OpenWorkspaceOptions): Promise<Workspace> {
    const dir = path.resolve(options.dir)
    const paths = kkbPaths(dir)
    const persistence = new Persistence(paths)

    const hadWorkspace = await pathExists(paths.kkbDir)
    if (!hadWorkspace && options.create === false) {
      throw new KkbError('IO_ERROR', `${dir} 不是一个 KankanBan 工作区（没有 .kkb 目录）。`, { dir })
    }

    await persistence.ensureDirs()

    let releaseLock: (() => Promise<void>) | null = null
    if (options.lock !== false) releaseLock = await acquireLock(paths.lockFile)

    try {
      const meta = (await persistence.loadMeta()) ?? (await persistence.createMeta(path.basename(dir)))
      const cards = await persistence.loadCards()
      const eventLog = await EventLog.open(paths.eventsFile)

      const workspace = new Workspace({ paths, meta, cards, eventLog, persistence, releaseLock })
      if (options.bootstrap !== false) await workspace.ensureRoots()
      workspace.assertIntegrity()
      return workspace
    } catch (error) {
      if (releaseLock !== null) await releaseLock()
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return
    this.closing = true

    /*
     * 先等在飞的写入结束。
     *
     * 这条很重要：MCP 客户端断开时会把 stdin 一关就走人，此刻可能还有工具调用
     * 正在写盘。不 waitForIdle 的话，进程退出会把卡片文件写了、事件日志丢了
     * ——正好丢掉「谁改了什么」这条最需要留痕的信息。
     */
    await this.waitForIdle()

    await this.flush()
    // 三处排队的东西都要等干净再走：卡片文件、事件日志、磁盘队列。
    await this.eventLog.drain()
    await this.persistence.drain()
    this.closed = true
    this.listeners.clear()
    if (this.releaseLockFn !== null) {
      const release = this.releaseLockFn
      this.releaseLockFn = null
      await release()
    }
  }

  /** 有没有正在执行的写操作。 */
  isBusy(): boolean {
    return this.activeOperations > 0
  }

  /** 等所有在飞的写操作结束。 */
  async waitForIdle(): Promise<void> {
    if (this.activeOperations === 0) return
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  private endOperation(): void {
    this.activeOperations -= 1
    if (this.activeOperations > 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private assertOpen(): void {
    if (this.closed || this.closing) {
      throw new KkbError('IO_ERROR', '这个工作区已经关闭了，不能再改它。')
    }
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  getCard(id: string): Card | undefined {
    return this.cards.get(id)
  }

  requireCard(id: string, options: { allowTrashed?: boolean } = {}): Card {
    const card = this.cards.get(id)
    if (card === undefined) throw cardNotFound(id)
    if (card.trashed === true && options.allowTrashed !== true) {
      throw new KkbError('CARD_TRASHED', `卡片「${card.title}」(${card.id}) 已在回收站里。`, { id })
    }
    return card
  }

  hasCard(id: string): boolean {
    return this.cards.has(id)
  }

  /** 全部卡片，含回收站里的。 */
  allCards(): Card[] {
    return [...this.cards.values()]
  }

  /** 全部可见卡片（不含回收站，以及回收站里的子树）。 */
  visibleCards(): Card[] {
    const hidden = new Set<string>()
    for (const card of this.cards.values()) {
      if (card.trashed === true) {
        hidden.add(card.id)
        for (const node of descendantsOf(this.lookup, card.id)) hidden.add(node.id)
      }
    }
    return [...this.cards.values()].filter((card) => !hidden.has(card.id))
  }

  isHidden(id: string): boolean {
    const card = this.cards.get(id)
    if (card === undefined) return false
    if (card.trashed === true) return true
    return ancestorsOf(this.lookup, id).some((ancestor) => ancestor.trashed === true)
  }

  childCards(id: string): Card[] {
    return childCardsOf(this.lookup, id)
  }

  /** [父, 祖父, ..., 根]，不含自己。 */
  ancestorsOf(id: string): Card[] {
    return ancestorsOf(this.lookup, id)
  }

  /** 自己 + 所有后代。 */
  subtreeOf(id: string): Card[] {
    const card = this.requireCard(id, { allowTrashed: true })
    return [card, ...descendantsOf(this.lookup, id)]
  }

  /** 所有树的根卡片，含保留根。 */
  roots(options: { includeTrashed?: boolean } = {}): Card[] {
    return [...this.cards.values()].filter(
      (card) => card.parent === null && (options.includeTrashed === true || card.trashed !== true),
    )
  }

  /** 浮在桌面上的卡：parent 为 null 且不是保留根。 */
  floatingCards(): Card[] {
    return this.roots().filter((card) => !isReservedId(card.id))
  }

  depthOf(id: string): number {
    return depthOf(this.lookup, id)
  }

  scopeOf(id: string): Scope {
    return scopeOf(this.lookup, id)
  }

  isDescendant(candidate: string, ancestor: string): boolean {
    return isDescendantOf(this.lookup, candidate, ancestor)
  }

  lastSeq(): number {
    return this.eventLog.lastSeq
  }

  async readEvents(options: { since?: number; limit?: number } = {}): Promise<KkbEvent[]> {
    return this.eventLog.readSince(options.since ?? 0, options.limit ?? 500)
  }

  /** 订阅事件。阶段二的窗口广播就靠它。 */
  onChange(listener: (events: readonly KkbEvent[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // -------------------------------------------------------------------------
  // 写
  // -------------------------------------------------------------------------

  async execute(command: Command, options: ExecuteOptions = {}): Promise<ExecuteOutcome> {
    this.assertOpen()
    this.activeOperations += 1
    try {
      /*
       * 命令必须串行执行。
       *
       * executeInner 的流程是「同步改内存 → 异步落盘 → 追加事件」，而 pendingEvents
       * 是实例状态。两个命令交错跑的话，B 开头那句 `this.pendingEvents = []`
       * 会把 A 刚记下的事件抹掉——卡片数据写对了，但「谁改了什么」静默丢了。
       *
       * 注意这里是「提交时」检查开关，不在队列里再检查一次：close() 会等所有已提交的
       * 命令跑完，所以在关闭途中已经排在队里的命令应该正常执行完，而不是中途被拒。
       */
      return await this.commandQueue.run(() => this.executeInner(command, options))
    } finally {
      this.endOperation()
    }
  }

  private async executeInner(command: Command, options: ExecuteOptions): Promise<ExecuteOutcome> {
    const { host, touched } = this.makeHost()
    this.pendingEvents = []

    let result
    try {
      result = executeCommand(host, command)
    } catch (error) {
      this.rollback(touched)
      throw error
    }

    const stamps = this.stampUpdatedAt(options.updatedAtTargets)
    // 在 flush 清空之前抓一份，广播要用
    const changed = [...this.dirty].filter((id) => this.cards.has(id))
    const removed = [...this.purged]
    await this.flush()

    const events = this.pendingEvents
    this.pendingEvents = []

    await this.eventLog.append(events)

    const record = options.record !== false
    if (record && result.history !== null) {
      const entry: HistoryEntry = { ...result.history, stamps }
      this.undoStack.push(entry)
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift()
      this.redoStack.length = 0
    }

    if (events.length > 0) {
      for (const listener of this.listeners) listener(events)
    }

    return {
      events,
      changed,
      removed,
      ...(result.created !== undefined ? { created: result.created } : {}),
      windowOps: result.windowOps,
      warnings: result.warnings,
      recorded: record && result.history !== null,
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null
  }

  redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null
  }

  async undo(): Promise<ExecuteOutcome | null> {
    this.assertOpen()
    const entry = this.undoStack.pop()
    if (entry === undefined) return null
    const outcome = await this.applyHistory(entry, 'undo')
    this.redoStack.push(entry)
    return outcome
  }

  async redo(): Promise<ExecuteOutcome | null> {
    this.assertOpen()
    const entry = this.redoStack.pop()
    if (entry === undefined) return null
    const outcome = await this.applyHistory(entry, 'redo')
    this.undoStack.push(entry)
    return outcome
  }

  private async applyHistory(entry: HistoryEntry, direction: 'undo' | 'redo'): Promise<ExecuteOutcome> {
    const targets: Record<string, number> = {}
    for (const [id, stamp] of Object.entries(entry.stamps)) {
      targets[id] = direction === 'undo' ? stamp.before : stamp.after
    }
    return this.execute(direction === 'undo' ? entry.undo : entry.redo, {
      record: false,
      updatedAtTargets: targets,
    })
  }

  // -------------------------------------------------------------------------
  // 命令宿主
  // -------------------------------------------------------------------------

  private makeHost(): {
    host: CommandHost
    touched: Map<string, Card | null>
  } {
    const touched = new Map<string, Card | null>()

    /** 第一次碰到某张卡时留一份备份，命令失败时用来整体回滚。 */
    const backup = (id: string): void => {
      if (touched.has(id)) return
      const existing = this.cards.get(id)
      touched.set(id, existing === undefined ? null : structuredClone(existing))
    }

    const host: CommandHost = {
      lookup: (id) => this.cards.get(id),
      now: () => Date.now(),

      require: (id, options) => {
        const card = this.cards.get(id)
        if (card === undefined) throw cardNotFound(id)
        if (card.trashed === true && options?.allowTrashed !== true) {
          throw new KkbError('CARD_TRASHED', `卡片「${card.title}」(${card.id}) 已在回收站里。`, { id })
        }
        return card
      },

      nextCardId: () => createCardId((id) => this.cards.has(id)),

      floatingCount: () =>
        [...this.cards.values()].filter((card) => card.parent === null && !isReservedId(card.id)).length,

      setField: (id, field, value, options) => {
        const card = this.cards.get(id)
        if (card === undefined) throw cardNotFound(id)

        const bucket = card as unknown as Record<string, unknown>
        const before = bucket[field]
        if (deepEqual(before, value)) return

        backup(id)
        if (value === undefined) delete bucket[field]
        else bucket[field] = value
        this.dirty.add(id)

        this.emitEvent({
          cardId: id,
          type: options?.eventType ?? 'field_set',
          path: `/${field}`,
          ...(before !== undefined ? { before: structuredClone(before) } : {}),
          ...(value !== undefined ? { after: structuredClone(value) } : {}),
        })
      },

      putCard: (card) => {
        if (this.cards.has(card.id)) {
          throw new KkbError('ID_DUPLICATE', `卡片 id ${card.id} 已经存在了。`, { id: card.id })
        }
        touched.set(card.id, null)
        this.cards.set(card.id, card)
        this.dirty.add(card.id)
      },

      purgeCard: (id) => {
        const card = this.cards.get(id)
        if (card === undefined) throw cardNotFound(id)
        if (!touched.has(id)) touched.set(id, structuredClone(card))
        this.cards.delete(id)
        this.dirty.delete(id)
        this.purged.push(id)
      },

      insertChild: (parentId, index, entry, card) => {
        const parent = this.cards.get(parentId)
        if (parent === undefined) throw cardNotFound(parentId)
        backup(parentId)

        const at = clamp(index, 0, parent.children.length)
        parent.children.splice(at, 0, structuredClone(entry))
        this.dirty.add(parentId)

        this.emitEvent({
          cardId: parentId,
          type: 'child_add',
          path: `/children/${at}`,
          after: { entry: structuredClone(entry), card: structuredClone(card) },
        })
      },

      removeChildAt: (parentId, index) => {
        const parent = this.cards.get(parentId)
        if (parent === undefined) throw cardNotFound(parentId)
        if (index < 0 || index >= parent.children.length) {
          throw new KkbError(
            'INVALID_ARGUMENT',
            `要从「${parent.title}」里移除第 ${index} 个子卡，但它只有 ${parent.children.length} 个。`,
            { parent: parentId, index, length: parent.children.length },
          )
        }

        backup(parentId)
        const removed = parent.children.splice(index, 1)[0] as ChildEntry
        this.dirty.add(parentId)

        this.emitEvent({
          cardId: parentId,
          type: 'child_remove',
          path: `/children/${index}`,
          before: { entry: structuredClone(removed) },
        })

        return removed
      },

      setChildren: (parentId, entries) => {
        const parent = this.cards.get(parentId)
        if (parent === undefined) throw cardNotFound(parentId)
        backup(parentId)
        parent.children = entries.map((entry) => structuredClone(entry))
        this.dirty.add(parentId)
      },

      emit: (event) => this.emitEvent(event),
    }

    return { host, touched }
  }

  private emitEvent(event: EmittedEvent): void {
    const full: KkbEvent = {
      seq: this.eventLog.nextSeq(),
      id: createEventId(),
      clientId: this.meta.clientId,
      timestamp: Date.now(),
      cardId: event.cardId,
      type: event.type,
      path: event.path,
      ...(event.before !== undefined ? { before: event.before } : {}),
      ...(event.after !== undefined ? { after: event.after } : {}),
    }
    this.pendingEvents.push(full)
  }

  /** 命令失败时把内存恢复到执行前的样子。 */
  private rollback(touched: Map<string, Card | null>): void {
    for (const [id, snapshot] of touched) {
      if (snapshot === null) this.cards.delete(id)
      else this.cards.set(id, snapshot)
    }
    this.dirty.clear()
    this.purged.length = 0
    this.pendingEvents = []
  }

  /**
   * 统一推进 updatedAt。
   *
   * 刻意不给它发事件：它是本地时间戳，可以从事件的时间推出来，
   * 每次都记一条会让日志变成噪声。
   */
  private stampUpdatedAt(targets?: Record<string, number>): Record<string, { before: number; after: number }> {
    const stamps: Record<string, { before: number; after: number }> = {}
    const now = Date.now()
    for (const id of this.dirty) {
      const card = this.cards.get(id)
      if (card === undefined) continue
      const before = card.updatedAt
      const after = targets?.[id] ?? now
      if (before !== after) card.updatedAt = after
      stamps[id] = { before, after }
    }
    return stamps
  }

  private async flush(): Promise<void> {
    if (this.dirty.size === 0 && this.purged.length === 0) return

    const toSave: Card[] = []
    for (const id of this.dirty) {
      const card = this.cards.get(id)
      if (card !== undefined) toSave.push(card)
    }
    const toDelete = [...this.purged]

    this.dirty.clear()
    this.purged.length = 0

    for (const id of toDelete) await this.persistence.deleteCardFile(id)
    await this.persistence.saveCards(toSave)
  }

  // -------------------------------------------------------------------------
  // 保留根
  // -------------------------------------------------------------------------

  private newCard(input: {
    id: string
    parent: string | null
    title: string
    view: ViewMode
    scope: Scope
    now: number
  }): Card {
    return {
      id: input.id,
      parent: input.parent,
      children: [],
      title: input.title,
      content: '',
      view: input.view,
      scope: input.scope,
      createdAt: input.now,
      updatedAt: input.now,
      createdBy: 'system',
    }
  }

  /** 补齐缺失的保留根。首次打开时会连看板的默认三列一起建好。 */
  private async ensureRoots(): Promise<void> {
    const now = Date.now()
    const created: Card[] = []

    for (const id of RESERVED_IDS) {
      if (this.cards.has(id)) continue
      const view = RESERVED_VIEW[id] as ViewMode
      created.push(
        this.newCard({
          id,
          parent: null,
          title: RESERVED_TITLE[id] ?? id,
          view,
          scope: 'public',
          now,
        }),
      )
    }

    if (created.length === 0) return

    for (const card of created) this.cards.set(card.id, card)

    // 看板刚补回来，且没有任何卡声称自己是它的子卡 —— 说明是全新工作区，给三列默认列。
    // 如果已经有人认领，就交给下面的「收养」逻辑，不要再造三列出来。
    const board = created.find((card) => card.id === BOARD_ID)
    const claimants = [...this.cards.values()].filter((card) => card.parent === BOARD_ID)
    if (board !== undefined && claimants.length === 0) {
      for (const name of DEFAULT_BOARD_COLUMNS) {
        const id = createCardId((candidate) => this.cards.has(candidate))
        const column = this.newCard({ id, parent: BOARD_ID, title: name, view: 'column', scope: 'public', now })
        this.cards.set(id, column)
        created.push(column)
        board.children.push({ id })
      }
    }

    /*
     * 收养孤儿：某张卡说「我的父卡是 001」，但 001.md 丢了、刚被重建，
     * 那它自己的 children 里不会有这些卡。按 parent 认领回来，
     * 否则工作区会因为丢失一个文件而彻底打不开。
     *
     * 只在根卡片是「刚重建」的情况下做这件事——根还在、只是 children 少了一条，
     * 那是真的结构损坏，应该报错而不是悄悄修好。
     */
    for (const root of created) {
      if (root.children.length > 0) continue
      const orphans = [...this.cards.values()]
        .filter((candidate) => candidate.parent === root.id && !root.children.some((e) => e.id === candidate.id))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      for (const orphan of orphans) root.children.push({ id: orphan.id })
    }

    await this.persistence.saveCards(created)
  }

  // -------------------------------------------------------------------------
  // 完整性校验
  // -------------------------------------------------------------------------

  /**
   * 打开时做一次全量校验。宁可拒绝加载并说清楚哪里坏了，
   * 也不要带着一棵自相矛盾的树继续跑——那样丢数据是静默的。
   */
  private assertIntegrity(): void {
    const problems: string[] = []

    for (const id of RESERVED_IDS) {
      if (!this.cards.has(id)) problems.push(`缺少保留根卡片 ${id}`)
    }

    for (const card of this.cards.values()) {
      const seen = new Set<string>()
      for (const entry of card.children) {
        if (seen.has(entry.id)) {
          problems.push(`卡片 ${card.id} 的 children 里 ${entry.id} 出现了多次`)
        }
        seen.add(entry.id)

        const child = this.cards.get(entry.id)
        if (child === undefined) {
          problems.push(`卡片 ${card.id} 的 children 引用了不存在的卡片 ${entry.id}`)
          continue
        }
        if (child.parent !== card.id) {
          problems.push(
            `卡片 ${child.id} 出现在 ${card.id} 的 children 里，但它的 parent 是 ${String(child.parent)}`,
          )
        }
      }

      if (card.parent === null) {
        if (isReservedId(card.id)) {
          const expectedView = RESERVED_VIEW[card.id]
          if (expectedView !== undefined && card.view !== expectedView) {
            problems.push(`保留根 ${card.id} 的 view 应该是 ${expectedView}，实际是 ${String(card.view)}`)
          }
          if (card.scope !== 'public') {
            problems.push(`保留根 ${card.id} 的 scope 应该是 public，实际是 ${card.scope}`)
          }
        }
      } else {
        const parent = this.cards.get(card.parent)
        if (parent === undefined) {
          problems.push(`卡片 ${card.id} 的 parent 指向不存在的卡片 ${card.parent}`)
        } else if (childIndex(parent, card.id) < 0) {
          problems.push(`卡片 ${card.id} 说自己是 ${card.parent} 的子卡，但父卡的 children 里没有它`)
        }
      }
    }

    const cycleReports = new Set<string>()
    for (const card of this.cards.values()) {
      try {
        ancestorsOf(this.lookup, card.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!cycleReports.has(message)) {
          cycleReports.add(message)
          problems.push(message)
        }
      }
    }

    if (problems.length > 0) {
      const shown = problems.slice(0, 12)
      const more = problems.length > shown.length ? `（还有 ${problems.length - shown.length} 条）` : ''
      throw new KkbError(
        'TREE_CORRUPT',
        `工作区加载失败，发现 ${problems.length} 个结构问题：${shown.join('；')}${more}`,
        { problems },
      )
    }
  }
}
