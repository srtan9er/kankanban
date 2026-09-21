import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpBackend } from './backend.ts'
import { createMcpServer } from './server.ts'

/**
 * 在 127.0.0.1 上以 Streamable HTTP 对外提供 MCP 端点。
 *
 * 为什么是 HTTP 而不是 stdio：
 *   stdio 要求客户端去**启动**这个进程。可我们现在要的是反过来 ——
 *   进程（Electron app）本来就在跑，客户端连上来。
 *   用 HTTP 之后 app 成为唯一的写者，人和 AI 看同一份数据，
 *   工作区锁也就不存在冲突了。
 *
 * 无状态模式，**每个请求新建一套 server + transport**。
 * 这一点是 SDK 示例的规定动作，不是可选风格：复用同一个 transport 时
 * 只有第一个请求（initialize）能通，后面的全 500 且响应体为空 ——
 * 我第一版就是这么写的，症状很有迷惑性。
 */

export interface HttpMcpOptions {
  /** 首选端口。被占用时会往后试几个。 */
  port: number
  host?: string
  path?: string
  log?: (message: string) => void
}

export interface RunningHttpMcp {
  url: string
  port: number
  host: string
  path: string
  close(): Promise<void>
}

const PORT_ATTEMPTS = 10

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

export async function startHttpMcpServer(
  backend: McpBackend,
  options: HttpMcpOptions,
): Promise<RunningHttpMcp> {
  const host = options.host ?? '127.0.0.1'
  const routePath = options.path ?? '/mcp'
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`))

  let live = 0

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (url.pathname !== routePath) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `未知路径，MCP 端点在 ${routePath}` }))
      return
    }

    void (async () => {
      // 每个请求一套：无状态模式下这是必须的
      const server = createMcpServer(backend)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await server.connect(transport)

      live += 1
      const cleanup = (): void => {
        live -= 1
        void transport.close().catch(() => undefined)
        void server.close().catch(() => undefined)
      }
      res.on('close', cleanup)

      await transport.handleRequest(req, res)
    })().catch((error: unknown) => {
      log(`[mcp] 处理请求出错：${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'internal' }))
      } else {
        res.end()
      }
    })
  })

  let bound = options.port
  let lastError: NodeJS.ErrnoException | null = null

  for (let i = 0; i < PORT_ATTEMPTS; i++) {
    const candidate = options.port + i
    try {
      await listen(http, host, candidate)
      bound = candidate
      lastError = null
      break
    } catch (error) {
      lastError = error as NodeJS.ErrnoException
      if (lastError.code !== 'EADDRINUSE') break
      log(`[mcp] 端口 ${candidate} 被占用，试下一个`)
    }
  }

  if (lastError !== null) {
    throw new Error(`MCP 端口从 ${options.port} 起试了 ${PORT_ATTEMPTS} 个都被占用了：${lastError.message}`)
  }

  const url = `http://${host}:${bound}${routePath}`
  log(`[mcp] 端点在 ${url}`)

  return {
    url,
    port: bound,
    host,
    path: routePath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
      })
      // 等还在飞的请求收尾，别在写盘中途把进程关了
      for (let i = 0; i < 50 && live > 0; i++) {
        await new Promise((r) => setTimeout(r, 20))
      }
    },
  }
}
