import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '@kankanban/core'
import { createServer, TOOL_NAMES } from '../src/index.ts'

/**
 * MCP 层的端到端测试：真的起一个 server、真的接一个 client，
 * 走完整的 JSON-RPC，而不是直接调函数。
 *
 * 用内存传输而不是 stdio 子进程，因为这样失败信息里能直接看到调用栈。
 */

let dir: string
let workspace: Workspace
let server: McpServer
let client: Client

interface ToolPayload {
  ok?: boolean
  created?: string
  warnings?: string[]
  code?: string
  message?: string
  [key: string]: unknown
}

interface RawResult {
  isError?: boolean
  content: unknown
}

async function callRaw(name: string, args: Record<string, unknown> = {}): Promise<RawResult> {
  const result = await client.callTool({ name, arguments: args })
  return result as unknown as RawResult
}

function contentText(result: RawResult): string {
  if (!Array.isArray(result.content)) throw new Error('工具没返回内容数组')
  const first = result.content[0] as { type?: string; text?: string } | undefined
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('工具没返回文本内容')
  }
  return first.text
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolPayload> {
  return JSON.parse(contentText(await callRaw(name, args))) as ToolPayload
}

function errorPayload(result: RawResult): ToolPayload {
  return JSON.parse(contentText(result)) as ToolPayload
}

/** 拿主看板第一列的 id。大部分「往列里放卡」的测试都要它。 */
async function firstColumnId(): Promise<string> {
  const overview = await call('board_overview')
  return (overview['columns'] as Array<{ column: { id: string } }>)[0]!.column.id
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kkb-mcp-'))
  workspace = await Workspace.open({ dir })
  server = createServer(workspace)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'kankanban-test', version: '0.0.1' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client.close().catch(() => undefined)
  await server.close().catch(() => undefined)
  await workspace.close().catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
})

describe('工具清单', () => {
  it('阶段一的工具全部注册上了', async () => {
    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name).sort()
    expect(names).toEqual([...TOOL_NAMES].sort())
  })

  it('每个工具都有说明和输入 schema', async () => {
    const listed = await client.listTools()
    for (const tool of listed.tools) {
      expect(tool.description, `${tool.name} 缺说明`).toBeTruthy()
      expect(tool.inputSchema, `${tool.name} 缺 inputSchema`).toBeTruthy()
    }
  })

  it('只读工具被标成 readOnlyHint', async () => {
    const listed = await client.listTools()
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]))
    for (const name of ['workspace_info', 'board_overview', 'card_get', 'search_cards']) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true)
    }
    expect(byName.get('card_create')?.annotations?.readOnlyHint).toBeFalsy()
  })

  it('server 会交代世界观', () => {
    const instructions = client.getInstructions()
    expect(instructions).toMatch(/没有 status 字段/)
    expect(instructions).toMatch(/数组下标就是顺序/)
  })
})

describe('读取工具', () => {
  it('workspace_info 报出四张保留根', async () => {
    const info = await call('workspace_info')
    const roots = (info['roots'] as Array<{ id: string }>).map((r) => r.id).sort()
    expect(roots).toEqual(['000', '001', '002', '003'])
    expect(info['note']).toMatch(/没有 status 字段/)
  })

  it('board_overview 缺省看主看板的三列', async () => {
    const overview = await call('board_overview')
    const columns = overview['columns'] as Array<{ column: { title: string } }>
    expect(columns.map((c) => c.column.title)).toEqual(['待办', '进行中', '完成'])
  })

  it('card_get 带上从根下来的路径', async () => {
    const { created } = await call('card_create', { parent: '001', title: '新列' })
    const detail = await call('card_get', { id: created })
    expect((detail['path'] as Array<{ title: string }>).map((p) => p.title)).toEqual(['board'])
  })

  it('search_cards 找得到刚建的卡', async () => {
    await call('card_create', { parent: '001', title: '战斗系统重构' })
    const found = await call('search_cards', { query: '战斗系统' })
    const hits = found['hits'] as Array<{ title: string }>
    expect(hits[0]?.title).toBe('战斗系统重构')
  })

  it('list_cards 传 null 列出所有根', async () => {
    await call('card_create', { parent: null, title: '桌面上的卡' })
    const listed = await call('list_cards', { parent: null })
    expect((listed['cards'] as unknown[]).length).toBeGreaterThanOrEqual(5)
  })
})

describe('写入工具', () => {
  it('建卡 → 出现在看板列里', async () => {
    const overview = await call('board_overview')
    const firstColumn = (overview['columns'] as Array<{ column: { id: string } }>)[0]!.column.id

    const created = await call('card_create', { parent: firstColumn, title: '画概念图' })
    expect(created['ok']).toBe(true)

    const after = await call('board_overview')
    const cards = (after['columns'] as Array<{ cards: Array<{ id: string }> }>)[0]!.cards
    expect(cards.map((c) => c.id)).toEqual([created['created']])
  })

  it('parent 传 null 建浮卡', async () => {
    const created = await call('card_create', { parent: null, title: '浮卡' })
    const info = await call('workspace_info')
    expect((info['floatingCards'] as Array<{ id: string }>).map((c) => c.id)).toEqual([created['created']])
  })

  it('移卡就是改状态：从待办挪到完成', async () => {
    const overview = await call('board_overview')
    const columns = (overview['columns'] as Array<{ column: { id: string } }>).map((c) => c.column.id)
    const created = await call('card_create', { parent: columns[0]!, title: '画概念图' })

    const moved = await call('card_move', { id: created['created'], parent: columns[2]! })
    expect(moved['ok']).toBe(true)

    const after = await call('board_overview')
    const doneCards = (after['columns'] as Array<{ column: { id: string }; cards: Array<{ id: string }> }>).find(
      (c) => c.column.id === columns[2],
    )
    expect(doneCards?.cards.map((c) => c.id)).toEqual([created['created']])
  })

  it('改卡会回一句改了什么', async () => {
    const created = await call('card_create', { parent: '001', title: '旧名字' })
    const updated = await call('card_update', { id: created['created'], title: '新名字', color: '#FF0000' })
    expect(updated['changed']).toEqual(['title', 'color'])
    expect((updated['card'] as { title: string }).title).toBe('新名字')
  })

  it('空补丁不会误伤任何字段', async () => {
    const created = await call('card_create', { parent: '001', title: '别动我' })
    const result = await call('card_update', { id: created['created'] })
    expect(result['changed']).toEqual([])
    expect((await call('card_get', { id: created['created'] }))['title']).toBe('别动我')
  })

  it('删除是软删除，恢复后回来', async () => {
    const column = await firstColumnId()
    const created = await call('card_create', { parent: column, title: '要被删的' })
    await call('card_trash', { id: created['created'] })

    const trash = await call('trash_list')
    expect((trash['cards'] as Array<{ id: string }>).map((c) => c.id)).toContain(created['created'])

    await call('card_restore', { id: created['created'] })
    const overview = await call('board_overview')
    const titles = (overview['columns'] as Array<{ cards: Array<{ title: string }> }>).flatMap((c) =>
      c.cards.map((card) => card.title),
    )
    expect(titles).toContain('要被删的')
  })

  it('删除会提醒你下面还有子卡', async () => {
    const parent = await call('card_create', { parent: '001', title: '父' })
    await call('card_create', { parent: parent['created'] as string, title: '子' })
    const trashed = await call('card_trash', { id: parent['created'] })
    expect(trashed['warnings']?.[0]).toMatch(/下面还有 1 张子卡/)
  })

  it('children_reorder 调整列的顺序', async () => {
    const overview = await call('board_overview')
    const ids = (overview['columns'] as Array<{ column: { id: string } }>).map((c) => c.column.id)
    await call('children_reorder', { parent: '001', order: [ids[2]!, ids[0]!, ids[1]!] })

    const after = await call('board_overview')
    expect((after['columns'] as Array<{ column: { id: string } }>).map((c) => c.column.id)).toEqual([
      ids[2],
      ids[0],
      ids[1],
    ])
  })

  it('events_since 能回答「刚刚改了什么」', async () => {
    const mark = (await call('workspace_info'))['lastSeq'] as number
    await call('card_create', { parent: '001', title: '刚建的' })

    const events = await call('events_since', { since: mark })
    const list = events['events'] as Array<{ type: string }>
    expect(list.some((e) => e.type === 'child_add')).toBe(true)
  })

  it('undo / redo 走的是同一套操作层', async () => {
    const column = await firstColumnId()
    const created = await call('card_create', { parent: column, title: '试试撤销' })
    const undone = await call('undo')
    expect(undone['undid']).toBe('建立卡片「试试撤销」')

    const cardIds = async (): Promise<string[]> => {
      const overview = await call('board_overview')
      return (overview['columns'] as Array<{ cards: Array<{ id: string }> }>).flatMap((c) =>
        c.cards.map((card) => card.id),
      )
    }

    expect(await cardIds()).not.toContain(created['created'])

    await call('redo')
    expect(await cardIds()).toContain(created['created'])
  })
})

describe('生命周期', () => {
  it('工具调用产生的事件会落盘，重开工作区后 seq 不回退', async () => {
    const column = await firstColumnId()
    await call('card_create', { parent: column, title: '要活过重启的' })

    const mark = workspace.lastSeq()
    expect(mark).toBeGreaterThan(0)

    await client.close()
    await server.close()
    await workspace.close()

    const reopened = await Workspace.open({ dir })
    try {
      expect(reopened.lastSeq()).toBe(mark)
      expect(reopened.allCards().some((c) => c.title === '要活过重启的')).toBe(true)
      expect(await reopened.readEvents()).toHaveLength(mark)
    } finally {
      await reopened.close()
    }
  })

  it('关掉工作区后再写会明确报错，而不是悄悄写坏数据', async () => {
    // 读是安全的（数据还在内存里），所以这里只断言写。
    await workspace.close()
    const result = await callRaw('card_create', { parent: '001', title: 'X' })
    expect(result.isError).toBe(true)
    expect(errorPayload(result).message).toMatch(/已经关闭/)
  })
})

describe('错误路径', () => {
  it('找不到卡时返回结构化错误，AI 能自己判断', async () => {
    const result = await callRaw('card_get', { id: 'c_不存在' })
    expect(result.isError).toBe(true)
    const payload = errorPayload(result)
    expect(payload.code).toBe('CARD_NOT_FOUND')
    expect(payload.message).toMatch(/找不到卡片/)
  })

  it('把卡塞进自己的后代里会被拒绝，并说明为什么', async () => {
    const parent = await call('card_create', { parent: '001', title: '父' })
    const child = await call('card_create', { parent: parent['created'] as string, title: '子' })

    const result = await callRaw('card_move', { id: parent['created'], parent: child['created'] })
    expect(result.isError).toBe(true)
    const payload = errorPayload(result)
    expect(payload.code).toBe('CYCLE_DETECTED')
    expect(payload.message).toMatch(/自己的后代/)
  })

  it('动保留根会被拒绝', async () => {
    const result = await callRaw('card_trash', { id: '001' })
    expect(result.isError).toBe(true)
    const payload = errorPayload(result)
    expect(payload.code).toBe('RESERVED_CARD')
  })

  it('日期格式不对时错误里说了正确格式', async () => {
    const created = await call('card_create', { parent: '001', title: 'A' })
    const result = await callRaw('card_update', { id: created['created'], due: '六月一号' })
    expect(result.isError).toBe(true)
    const payload = errorPayload(result)
    expect(payload.code).toBe('INVALID_ARGUMENT')
    expect(payload.message).toMatch(/YYYY-MM-DD/)
  })

  it('参数不合 schema 时被挡下来', async () => {
    const result = await callRaw('card_create', { title: '忘了写 parent' })
    expect(result.isError).toBe(true)
  })

  it('撤销栈空时 undo 是人话，不是错误', async () => {
    const result = await call('undo')
    expect(result['ok']).toBe(false)
    expect(result['note']).toMatch(/撤销栈是空的/)
  })
})
