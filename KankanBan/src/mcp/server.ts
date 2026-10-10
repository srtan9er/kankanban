/**
 * MCP 服务器 —— 把 `tools.ts` 的工具目录接到真正的 MCP 协议上（ARCHITECTURE.md §9.1 的适配器）。
 *
 * 【为什么用低层 `Server` 而不是高层 `McpServer`】
 * 高层 `registerTool` 的 `inputSchema` **只接受 zod**，会把 `tools.ts` 里声明的 JSON Schema
 * 过一道有损转换。而 MCP 协议本身在 `tools/list` 里传的就是 JSON Schema ——
 * 用低层 Server 意味着**声明即所见**：既不引 zod，也不让工具目录依赖任何 SDK。
 * 这也让 §9.1 的分层真正成立：core 与工具目录都能脱离协议单独跑，
 * §4.3 断言五因此可以在没有 GUI、没有 stdio 的环境里验完。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { openSession, type Session, type SessionOptions } from '../core/workspace.ts';
import { callTool, toolListPayload } from './tools.ts';

export const SERVER_INFO = { name: 'kankanban', version: '0.1.0' } as const;

/**
 * 造一个绑定到某个会话的 MCP 服务器。
 *
 * 会话是**显式传入**的，不是模块级单例 —— 这样测试能起多个互不干扰的
 * 「工作区 + 服务器」组合，也避免以后接多工作区时踩到隐藏共享状态。
 */
export function createServer(session: Session): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolListPayload() }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      const result = callTool(session, request.params.name, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      // 工具失败要**让 AI 看见原因**，所以回成 isError 而不是让异常炸掉整个会话 ——
      // 一次调用失败不该让连接断掉。注意这里只吞"工具内部"的错误，
      // 协议层的错误照样往上抛。
      return {
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  return server;
}

/** 用 stdio 传输把服务器跑起来（这是给 MCP 客户端进程用的入口）。 */
export async function serveStdio(root: string, options: SessionOptions = {}): Promise<Server> {
  const session = openSession(root, options);
  const server = createServer(session);
  await server.connect(new StdioServerTransport());
  return server;
}
