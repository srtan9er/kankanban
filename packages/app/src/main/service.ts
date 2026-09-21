import { toKkbError, Workspace } from '@kankanban/core'
import type { Command, WindowState } from '@kankanban/core'
import { CHANNELS } from '../shared/ipc.ts'
import type { BootInfo, CommandReply, Patch, Snapshot } from '../shared/ipc.ts'
import type { WindowManager } from './windows.ts'

/**
 * 主进程是唯一写者。
 *
 * 所有来自渲染进程的改动都要经过这里：
 *   执行命令 → 落盘 → 把「哪些卡变了」广播给每个窗口 → 处理开窗关窗。
 *
 * 广播的是变化后的卡片对象，不是事件流。渲染进程直接替换即可，
 * 不需要把事件应用逻辑再实现一遍 —— 两份逻辑一定会漂移。
 * 事件流本身还在 events.jsonl 里，那是留给同步层的。
 */
export class WorkspaceService {
  private readonly workspace: Workspace
  private readonly windows: WindowManager

  private constructor(workspace: Workspace, windows: WindowManager) {
    this.workspace = workspace
    this.windows = windows
  }

  static async open(dir: string, windows: WindowManager): Promise<WorkspaceService> {
    const workspace = await Workspace.open({ dir, create: true })
    const service = new WorkspaceService(workspace, windows)

    // 窗口被拖动或缩放之后要把位置存回卡片字段
    windows.onBoundsChanged = (cardId, state) => {
      void service.persistBounds(cardId, state)
    }

    // 开场把桌面上的浮卡都开出来
    for (const card of workspace.floatingCards()) {
      windows.openCard(card.id, card.window)
    }

    return service
  }

  get root(): string {
    return this.workspace.paths.root
  }

  get name(): string {
    return this.workspace.meta.name
  }

  /** MCP 工具要用它做只读查询。写入请走 run/undo/redo。 */
  get raw(): Workspace {
    return this.workspace
  }

  canUndo(): boolean {
    return this.workspace.canUndo()
  }

  canRedo(): boolean {
    return this.workspace.canRedo()
  }

  undoLabel(): string | null {
    return this.workspace.undoLabel()
  }

  redoLabel(): string | null {
    return this.workspace.redoLabel()
  }

  // -------------------------------------------------------------------------
  // 命令
  // -------------------------------------------------------------------------

  async run(command: Command): Promise<CommandReply> {
    try {
      const outcome = await this.workspace.execute(command)
      this.after(outcome)
      return {
        ok: true,
        ...(outcome.created !== undefined ? { created: outcome.created } : {}),
        changed: outcome.changed,
        ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
        events: outcome.events,
        windowOps: outcome.windowOps,
      }
    } catch (error) {
      const kkb = toKkbError(error)
      return { ok: false, error: { code: kkb.code, message: kkb.message } }
    }
  }

  async undo(): Promise<CommandReply> {
    const outcome = await this.workspace.undo()
    if (outcome === null) {
      return { ok: false, error: { code: 'NOTHING_TO_UNDO', message: '没有可撤销的操作。' } }
    }
    this.after(outcome)
    return {
      ok: true,
      changed: outcome.changed,
      ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
      events: outcome.events,
      windowOps: outcome.windowOps,
    }
  }

  async redo(): Promise<CommandReply> {
    const outcome = await this.workspace.redo()
    if (outcome === null) {
      return { ok: false, error: { code: 'NOTHING_TO_REDO', message: '没有可重做的操作。' } }
    }
    this.after(outcome)
    return {
      ok: true,
      changed: outcome.changed,
      ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
      events: outcome.events,
      windowOps: outcome.windowOps,
    }
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  snapshot(): Snapshot {
    return { cards: this.workspace.allCards(), lastSeq: this.workspace.lastSeq() }
  }

  boot(webContentsId: number): BootInfo {
    const cardId = this.windows.cardIdOf(webContentsId)
    return {
      target: cardId === null ? { kind: 'main' } : { kind: 'card', cardId },
      workspaceRoot: this.workspace.paths.root,
      workspaceName: this.workspace.meta.name,
      canUndo: this.workspace.canUndo(),
      canRedo: this.workspace.canRedo(),
      undoLabel: this.workspace.undoLabel(),
      redoLabel: this.workspace.redoLabel(),
    }
  }

  /** 看板第一列的 id —— 「收回进容器」的落点。 */
  firstBoardColumn(): string | null {
    const columns = this.workspace.childCards('001')
    return columns[0]?.id ?? null
  }

  cardView(id: string): { id: string; title: string; parent: string | null; floating: boolean } | null {
    const card = this.workspace.getCard(id)
    if (card === undefined) return null
    return { id: card.id, title: card.title, parent: card.parent, floating: card.parent === null }
  }

  isFloating(id: string): boolean {
    return this.workspace.getCard(id)?.parent === null && id !== '000'
  }

  cardState(id: string): WindowState | undefined {
    return this.workspace.getCard(id)?.window
  }

  isAlive(): boolean {
    return this.workspace.getCard('001') !== undefined
  }

  async close(): Promise<void> {
    await this.workspace.close()
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private after(outcome: {
    changed: string[]
    removed: string[]
    windowOps: readonly { op: 'open' | 'close'; cardId: string }[]
  }): void {
    const cards = outcome.changed
      .map((id) => this.workspace.getCard(id))
      .filter((card): card is NonNullable<typeof card> => card !== undefined)

    const patch: Patch = {
      cards,
      removed: outcome.removed,
      lastSeq: this.workspace.lastSeq(),
      history: {
        canUndo: this.workspace.canUndo(),
        canRedo: this.workspace.canRedo(),
        undoLabel: this.workspace.undoLabel(),
        redoLabel: this.workspace.redoLabel(),
      },
    }
    this.windows.broadcast(CHANNELS.patch, patch)

    this.windows.applyWindowOps(outcome.windowOps, (cardId) => this.workspace.getCard(cardId)?.window)
  }

  /**
   * 窗口位置落盘。
   *
   * record: false —— 挪一下窗口不该塞进撤销栈，
   * 不然用户按 Ctrl+Z 撤销的会是「把卡片挪了 3 个像素」。
   */
  private async persistBounds(cardId: string, state: WindowState): Promise<void> {
    if (this.workspace.getCard(cardId) === undefined) return
    try {
      await this.workspace.execute(
        { type: 'card_update', id: cardId, patch: { window: state } },
        { record: false },
      )
    } catch {
      // 卡片可能刚好被删了，忽略
    }
  }
}
