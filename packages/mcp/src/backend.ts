import { KkbError } from '@kankanban/core'
import type { Command, ExecuteOutcome, KkbEvent, WindowOp, Workspace } from '@kankanban/core'

/**
 * MCP 工具和「谁在托管工作区」之间的那层。
 *
 * 为什么需要它：MCP 工具**不能直接写 Workspace**。
 * 在 app 里跑的时候，写入必须经过 WorkspaceService，
 * 否则窗口收不到广播 —— AI 改的东西在人眼前不会变，那就成了两个世界。
 *
 * 所以：
 *   读 —— 直接用内存里的树（只读，安全，立刻）
 *   写 —— 交给宿主，由宿主负责落盘和广播
 *
 * **失败一律抛错**，不返回失败对象。工具层用 `guard` 统一接住，
 * 抛出的错误会带着 code 变成结构化错误返回给 AI。
 * （一开始这里返回 { ok: false }，结果工具把失败当成功继续往下走，
 * 十几个错误路径测试当场就红了。）
 *
 * 两个实现：
 *   app       → WorkspaceService（写入会广播到所有窗口）
 *   bin.ts    → 独立 stdio 进程，直接调 Workspace（没有窗口要广播）
 */

export interface BackendResult {
  created?: string
  /** 内容有变化的卡片 id */
  changed: string[]
  /** 给人看的提醒 */
  warnings: string[]
  /** 哪些卡应该开窗/关窗 */
  windowOps: WindowOp[]
  /** 这次执行产生的事件（工具会挑摘要回给 AI） */
  events: KkbEvent[]
}

export interface McpBackend {
  /** 只读查询用。写入不要碰它。 */
  readonly workspace: Workspace
  run(command: Command): Promise<BackendResult>
  undo(): Promise<BackendResult>
  redo(): Promise<BackendResult>
  undoLabel(): string | null
  redoLabel(): string | null
}

function shape(outcome: ExecuteOutcome): BackendResult {
  return {
    ...(outcome.created !== undefined ? { created: outcome.created } : {}),
    changed: outcome.changed,
    warnings: outcome.warnings,
    windowOps: outcome.windowOps,
    events: outcome.events,
  }
}

/**
 * 独立进程用的实现：直接写 Workspace。
 *
 * 这里没有窗口要广播，所以可以走捷径。app 里的实现见
 * packages/app/src/main/mcp-host.ts。
 */
export function createStandaloneBackend(workspace: Workspace): McpBackend {
  return {
    workspace,
    run: async (command: Command) => shape(await workspace.execute(command)),
    undo: async () => {
      const outcome = await workspace.undo()
      if (outcome === null) throw new KkbError('INVALID_ARGUMENT', '撤销栈是空的，没有可撤销的操作。')
      return shape(outcome)
    },
    redo: async () => {
      const outcome = await workspace.redo()
      if (outcome === null) throw new KkbError('INVALID_ARGUMENT', '没有可重做的操作。')
      return shape(outcome)
    },
    undoLabel: () => workspace.undoLabel(),
    redoLabel: () => workspace.redoLabel(),
  }
}
