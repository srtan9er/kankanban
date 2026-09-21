import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '@kankanban/core'
import { createStandaloneBackend, startHttpMcpServer } from '../src/index.ts'
import type { RunningHttpMcp } from '../src/index.ts'

/**
 * Streamable HTTP 端点的端到端测试。
 *
 * 这条路径是「MCP server 搬进 app」的关键：客户端不再去启动服务端，
 * 而是连上一个本来就在跑的进程。
 *
 * 真的起 HTTP 服务、真的用 HTTP 客户端连上去、走完整的 JSON-RPC。
 */

let dir: string
let workspace: Workspace
let host: RunningHttpMcp
let client: Client

/** 拿一个很不可能的端口段，避免和开发机上别的东西撞。 */
const BASE_PORT = 17931

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  const first = content[0]
  if (first?.type !== 'text' || typeof first.text !== 'string') throw new Error('没返回文本')
  return JSON.parse(first.text) as Record<string, unknown>
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kkb-http-'))
  workspace = await Workspace.open({ dir })
  host = await startHttpMcpServer(createStandaloneBackend(workspace), {
    port: BASE_PORT,
    log: () => undefined,
  })
  client = new Client({ name: 'kkb-http-test', version: '0.0.1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(host.url)))
})

afterEach(async () => {
  await client.close().catch(() => undefined)
  await host.close().catch(() => undefined)
  await workspace.close().catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

describe('Streamable HTTP 端点', () => {
  it('客户端能连上并列出工具', async () => {
    const listed = await client.listTools()
    expect(listed.tools.length).toBeGreaterThan(10)
    expect(listed.tools.map((t) => t.name)).toContain('board_overview')
  })

  it('server 会交代世界观', () => {
    expect(client.getInstructions()).toMatch(/没有 status 字段/)
  })

  it('能读板', async () => {
    const overview = await call('board_overview')
    const columns = overview['columns'] as Array<{ column: { title: string } }>
    expect(columns.map((c) => c.column.title)).toEqual(['待办', '进行中', '完成'])
  })

  it('能建卡、改卡、移卡', async () => {
    const overview = await call('board_overview')
    const columns = (overview['columns'] as Array<{ column: { id: string } }>).map((c) => c.column.id)

    const created = await call('card_create', { parent: columns[0]!, title: '通过 HTTP 建的卡' })
    expect(created['ok']).toBe(true)

    const updated = await call('card_update', { id: created['created'], title: '改过名字' })
    expect((updated['card'] as { title: string }).title).toBe('改过名字')

    const moved = await call('card_move', { id: created['created'], parent: columns[2]! })
    expect(moved['ok']).toBe(true)

    const after = await call('board_overview')
    const doneColumn = (after['columns'] as Array<{ column: { id: string }; cards: Array<{ id: string }> }>).find(
      (c) => c.column.id === columns[2],
    )
    expect(doneColumn?.cards.map((c) => c.id)).toEqual([created['created']])
  })

  it('错误路径照样返回结构化错误码', async () => {
    const result = await client.callTool({ name: 'card_get', arguments: { id: 'c_不存在' } })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ text: string }>
    expect(JSON.parse(content[0]!.text).code).toBe('CARD_NOT_FOUND')
  })

  it('写入真的落到了工作区（不是只在内存里）', async () => {
    const overview = await call('board_overview')
    const column = (overview['columns'] as Array<{ column: { id: string } }>)[0]!.column.id
    await call('card_create', { parent: column, title: '要活过重启的' })

    await workspace.close()
    const reopened = await Workspace.open({ dir })
    try {
      expect(reopened.allCards().some((c) => c.title === '要活过重启的')).toBe(true)
    } finally {
      await reopened.close()
    }
    // 让 afterEach 不要重复关
    workspace = await Workspace.open({ dir })
  })

  it('多个客户端能同时连（无状态模式）', async () => {
    const second = new Client({ name: 'kkb-http-test-2', version: '0.0.1' })
    await second.connect(new StreamableHTTPClientTransport(new URL(host.url)))
    try {
      const listed = await second.listTools()
      expect(listed.tools.length).toBeGreaterThan(10)
    } finally {
      await second.close()
    }
  })

  it('端口被占用时会往后让，并且报出实际端口', async () => {
    // 上一层的 host 占着 BASE_PORT，这里再起一个应该让到下一个
    const second = await startHttpMcpServer(createStandaloneBackend(workspace), {
      port: BASE_PORT,
      log: () => undefined,
    })
    try {
      expect(second.port).toBe(BASE_PORT + 1)
      expect(second.url).toContain(`:${BASE_PORT + 1}`)
    } finally {
      await second.close()
    }
  })

  it('访问别的路径返回 404', async () => {
    const response = await fetch(`http://127.0.0.1:${host.port}/随便什么`)
    expect(response.status).toBe(404)
  })
})
