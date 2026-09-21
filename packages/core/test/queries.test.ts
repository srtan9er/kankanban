import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  boardOverview,
  cardDetail,
  listCards,
  searchCards,
  trashedCards,
  treeView,
  workspaceInfo,
  Workspace,
} from '../src/index.ts'
import { makeTempWorkspace } from './helpers.ts'
import type { TempWorkspace } from './helpers.ts'

let temp: TempWorkspace | null = null
let ws: Workspace
let todo: string
let doing: string
let done: string

beforeEach(async () => {
  temp = await makeTempWorkspace()
  ws = temp.ws
  const columns = ws.childCards('001')
  todo = columns[0]!.id
  doing = columns[1]!.id
  done = columns[2]!.id
})

afterEach(async () => {
  if (temp !== null) {
    await temp.cleanup()
    temp = null
  }
})

async function createTask(
  parent: string | null,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const outcome = await ws.execute({ type: 'card_create', parent, title, ...extra })
  return outcome.created as string
}

describe('workspaceInfo', () => {
  it('报出根卡片和计数，并顺手说明没有 status 字段', async () => {
    await createTask(todo, 'A')
    const info = workspaceInfo(ws)

    expect(info.name).toBeTruthy()
    expect(info.formatVersion).toBe(1)
    expect(info.roots.map((c) => c.id).sort()).toEqual(['000', '001', '002', '003'])
    expect(info.visibleCardCount).toBe(info.cardCount)
    expect(info.trashedCardCount).toBe(0)
    expect(info.note).toMatch(/没有 status 字段/)
    expect(info.note).toMatch(/parent/)
  })

  it('浮卡单独列出来', async () => {
    const floating = await createTask(null, '桌面上的卡')
    const info = workspaceInfo(ws)
    expect(info.floatingCards.map((c) => c.id)).toEqual([floating])
  })

  it('回收站里的卡计入 trashedCardCount', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({ type: 'card_trash', id })
    const info = workspaceInfo(ws)
    expect(info.trashedCardCount).toBe(1)
    expect(info.visibleCardCount).toBe(info.cardCount - 1)
  })
})

describe('boardOverview', () => {
  it('列出三列和每列的卡', async () => {
    await createTask(todo, '概念图')
    await createTask(doing, '建模')
    const overview = boardOverview(ws)

    expect(overview.board.id).toBe('001')
    expect(overview.columns.map((c) => c.column.title)).toEqual(['待办', '进行中', '完成'])
    expect(overview.columns[0]?.cards.map((c) => c.title)).toEqual(['概念图'])
    expect(overview.columns[1]?.cards.map((c) => c.title)).toEqual(['建模'])
    expect(overview.columns[2]?.cardCount).toBe(0)
  })

  it('紧凑输出不带正文，避免把上下文撑爆', async () => {
    await createTask(todo, '有很多正文的卡', { content: '正文'.repeat(500) })
    const overview = boardOverview(ws)
    const view = overview.columns[0]?.cards[0]
    expect(view?.title).toBe('有很多正文的卡')
    expect(Object.keys(view ?? {})).not.toContain('content')
    expect(Object.keys(view ?? {})).not.toContain('excerpt')
  })

  it('回收站里的卡不出现在列里', async () => {
    const id = await createTask(todo, '要被删的')
    await ws.execute({ type: 'card_trash', id })
    const overview = boardOverview(ws)
    expect(overview.columns[0]?.cards).toEqual([])
  })
})

describe('cardDetail', () => {
  it('默认带正文、子卡和所在路径', async () => {
    const parent = await createTask(todo, '父')
    const child = await createTask(parent, '子')
    const detail = cardDetail(ws, child, { includeContent: true, includeChildren: true })

    expect(detail.title).toBe('子')
    expect(detail.path?.map((p) => p.title)).toEqual(['board', '待办', '父'])
    expect(detail.content).toBe('')
    expect(detail.children).toEqual([])
  })

  it('子卡以紧凑形态列出来', async () => {
    const parent = await createTask(todo, '父')
    await createTask(parent, '子一', { content: '这是子一的正文，够长到能截出片段来' })
    await createTask(parent, '子二')
    const detail = cardDetail(ws, parent, { includeChildren: true })
    expect(detail.children?.map((c) => c.title)).toEqual(['子一', '子二'])
    expect(detail.children?.[0]?.excerpt).toContain('子一的正文')
  })

  it('被回收站压住的卡会说明为什么看不见', async () => {
    const parent = await createTask(todo, '父')
    const child = await createTask(parent, '子')
    await ws.execute({ type: 'card_trash', id: parent })

    const detail = cardDetail(ws, child, { allowTrashed: true })
    expect(detail.hiddenBecause).toMatch(/父卡在回收站里/)
  })

  it('自己在回收站里时说明原因不同', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({ type: 'card_trash', id })
    const detail = cardDetail(ws, id, { allowTrashed: true })
    expect(detail.hiddenBecause).toMatch(/自己在回收站里/)
  })
})

describe('searchCards', () => {
  it('标题命中排在正文命中前面', async () => {
    await createTask(todo, '无关的卡', { content: '这里提到了战斗系统' })
    const titled = await createTask(todo, '战斗系统')
    const hits = searchCards(ws, '战斗系统')

    expect(hits[0]?.id).toBe(titled)
    expect(hits[0]?.matchedIn).toContain('title')
    expect(hits[1]?.matchedIn).toContain('content')
  })

  it('标签也能搜到', async () => {
    const id = await createTask(todo, 'A', { tags: ['art', 'character'] })
    const hits = searchCards(ws, 'char')
    expect(hits.map((h) => h.id)).toContain(id)
    expect(hits[0]?.matchedIn).toContain('tags')
  })

  it('大小写不敏感', async () => {
    const id = await createTask(todo, 'Hero Idle')
    expect(searchCards(ws, 'hero idle').map((h) => h.id)).toContain(id)
  })

  it('命中片段会带上下文', async () => {
    await createTask(todo, 'A', { content: '前面一堆废话'.repeat(20) + '关键目标在这里' + '后面一堆废话'.repeat(20) })
    const hits = searchCards(ws, '关键目标')
    expect(hits[0]?.excerpt).toContain('关键目标')
    expect(hits[0]?.excerpt).toMatch(/^…/)
  })

  it('回收站里的卡搜不到', async () => {
    const id = await createTask(todo, '被删掉的独有词')
    await ws.execute({ type: 'card_trash', id })
    expect(searchCards(ws, '被删掉的独有词')).toEqual([])
  })

  it('空查询返回空数组', async () => {
    await createTask(todo, 'A')
    expect(searchCards(ws, '   ')).toEqual([])
  })

  it('limit 生效', async () => {
    for (let i = 0; i < 5; i++) await createTask(todo, `同名卡 ${i}`)
    expect(searchCards(ws, '同名卡', { limit: 2 })).toHaveLength(2)
  })
})

describe('treeView', () => {
  it('按深度展开', async () => {
    const parent = await createTask(todo, '父')
    const child = await createTask(parent, '子')
    await createTask(child, '孙')

    const tree = treeView(ws, todo, { depth: 3 })
    const parentNode = tree.children.find((n) => n.id === parent)
    expect(parentNode?.children.map((n) => n.id)).toEqual([child])
    expect(parentNode?.children[0]?.children).toHaveLength(1)
  })

  it('到达深度上限时标出被截断', async () => {
    const parent = await createTask(todo, '父')
    await createTask(parent, '子')

    const tree = treeView(ws, todo, { depth: 1 })
    const parentNode = tree.children.find((n) => n.id === parent)
    expect(parentNode?.children).toEqual([])
    expect(parentNode?.cut).toBe(true)
  })

  it('叶子节点不会被标成截断', async () => {
    await createTask(todo, '光杆')
    const tree = treeView(ws, todo, { depth: 1 })
    expect(tree.children[0]?.cut).toBeUndefined()
  })
})

describe('listCards / trashedCards', () => {
  it('默认只列可见的卡', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B')
    await ws.execute({ type: 'card_trash', id: b })

    expect(listCards(ws, { parent: todo }).map((c) => c.id)).toEqual([a])
    expect(listCards(ws, { parent: todo, includeTrashed: true }).map((c) => c.id)).toEqual([a, b])
  })

  it('parent 传 null 时列出所有的根', async () => {
    const floating = await createTask(null, '浮卡')
    const roots = listCards(ws, { parent: null }).map((c) => c.id)
    expect(roots).toContain(floating)
    expect(roots).toContain('001')
  })

  it('trashedCards 按最近改动排序', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B')
    await ws.execute({ type: 'card_trash', id: a })
    await ws.execute({ type: 'card_trash', id: b })

    const trashed = trashedCards(ws)
    expect(trashed).toHaveLength(2)
    expect(trashed.map((c) => c.id)).toContain(a)
    expect(trashed.map((c) => c.id)).toContain(b)
  })

  it('完成列里的卡就是「做完了」——不需要任何 status 字段', async () => {
    const id = await createTask(todo, '画概念图')
    await ws.execute({ type: 'card_move', id, parent: done })

    const overview = boardOverview(ws)
    const doneColumn = overview.columns.find((c) => c.column.id === done)
    expect(doneColumn?.cards.map((c) => c.id)).toEqual([id])
    expect(ws.requireCard(id).parent).toBe(done)
  })
})
