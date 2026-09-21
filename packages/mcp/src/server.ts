import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpBackend } from './backend.ts'
import { registerTools, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from './tools.ts'

/**
 * 一个宿主一个 server 实例。
 *
 * 注意参数是 backend 而不是 Workspace：工具层不直接写数据，
 * 写入要走宿主（app 里是 WorkspaceService，独立进程里是 Workspace 本身）。
 * 这样在 app 里跑的时候，AI 的改动会广播到所有窗口。
 */
export function createMcpServer(backend: McpBackend): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  )
  registerTools(server, backend)
  return server
}
