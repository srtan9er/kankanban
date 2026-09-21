import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Workspace } from '@kankanban/core'
import { registerTools, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from './tools.ts'

/** 一个工作区一个 server 实例。工具注册在 MCP server 上，但真正的操作层是 core 的 commands。 */
export function createServer(workspace: Workspace): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  )
  registerTools(server, workspace)
  return server
}
