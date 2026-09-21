import { startHttpMcpServer } from '@kankanban/mcp'
import type { BackendResult, McpBackend, RunningHttpMcp } from '@kankanban/mcp'
import { KkbError } from '@kankanban/core'
import type { Command, KkbErrorCode } from '@kankanban/core'
import type { CommandReply } from '../shared/ipc.ts'
import type { WorkspaceService } from './service.ts'

/**
 * 把 MCP 端点挂在 app 里。
 *
 * 这是「人和 AI 走同一套操作层」最后落地的一块：
 *   - 以前 app 和 MCP server 是两个进程，都写同一个 .kkb，
 *     只能靠排他锁互斥 —— 开了 app 就用不了 AI，反之亦然。
 *   - 现在 MCP 工具接到 WorkspaceService 上，写操作走同一条路：
 *     落盘 + 广播到所有窗口。AI 改的东西人立刻看得见。
 *
 * 锁的问题自然消失：只有一个写者了。
 *
 * 端口：默认固定，被占用时往后试几个（最多 10 个），实际端口会报给界面。
 * 客户端配置里写的是 URL，所以端口漂了要去界面上看新的。
 */

export const DEFAULT_MCP_PORT = 17381

/**
 * IPC 那条路返回的是失败对象（渲染进程需要的是一个值，不是一个 reject），
 * 但 MCP 工具层要的是抛错。这里把前者翻成后者，并且**保住错误码** ——
 * AI 靠错误码判断该换参数还是换思路。
 */
function toBackendResult(reply: CommandReply): BackendResult {
  if (!reply.ok) {
    throw new KkbError(
      (reply.error?.code ?? 'IO_ERROR') as KkbErrorCode,
      reply.error?.message ?? '执行失败',
    )
  }
  return {
    ...(reply.created !== undefined ? { created: reply.created } : {}),
    changed: reply.changed ?? [],
    warnings: reply.warnings ?? [],
    windowOps: reply.windowOps ?? [],
    events: reply.events ?? [],
  }
}

function backendFor(service: WorkspaceService): McpBackend {
  return {
    // 只读查询直接读内存里的树；写入一律走 service，这样才会广播
    workspace: service.raw,
    run: async (command: Command) => toBackendResult(await service.run(command)),
    undo: async () => toBackendResult(await service.undo()),
    redo: async () => toBackendResult(await service.redo()),
    undoLabel: () => service.undoLabel(),
    redoLabel: () => service.redoLabel(),
  }
}

export interface McpHostOptions {
  port?: number
  log?: (message: string) => void
}

export async function startMcpHost(
  service: WorkspaceService,
  options: McpHostOptions = {},
): Promise<RunningHttpMcp> {
  const port = options.port ?? Number(process.env['KKB_MCP_PORT'] ?? DEFAULT_MCP_PORT)
  return startHttpMcpServer(backendFor(service), { port, ...(options.log ? { log: options.log } : {}) })
}
