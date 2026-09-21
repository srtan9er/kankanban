import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cardFilePath, serializeCard, Workspace } from '../src/index.ts'
import { card, makeTempWorkspace } from './helpers.ts'
import type { TempWorkspace } from './helpers.ts'

let temp: TempWorkspace | null = null

async function open(): Promise<TempWorkspace> {
  temp = await makeTempWorkspace()
  return temp
}

afterEach(async () => {
  if (temp !== null) {
    await temp.cleanup()
    temp = null
  }
})

describe('工作区初始化', () => {
  it('首次打开会建好四个保留根卡片', async () => {
    const t = await open()
    for (const id of ['000', '001', '002', '003']) {
      expect(t.ws.hasCard(id)).toBe(true)
    }
    expect(t.ws.getCard('000')?.view).toBe('main')
    expect(t.ws.getCard('001')?.view).toBe('kanban')
    expect(t.ws.getCard('002')?.view).toBe('plane')
    expect(t.ws.getCard('003')?.view).toBe('grid')
  })

  it('看板预置三列，视图是 column', async () => {
    const t = await open()
    const columns = t.ws.childCards('001')
    expect(columns.map((c) => c.title)).toEqual(['待办', '进行中', '完成'])
    expect(columns.every((c) => c.view === 'column')).toBe(true)
  })

  it('保留根都是公有的根卡片', async () => {
    const t = await open()
    for (const id of ['000', '001', '002', '003']) {
      const card = t.ws.getCard(id)
      expect(card?.parent).toBeNull()
      expect(card?.scope).toBe('public')
    }
  })

  it('一开始没有浮卡', async () => {
    const t = await open()
    expect(t.ws.floatingCards()).toEqual([])
    expect(t.ws.roots().map((c) => c.id).sort()).toEqual(['000', '001', '002', '003'])
  })

  it('落盘结构就是 .kkb 下那几个文件', async () => {
    const t = await open()
    expect(t.ws.paths.kkbDir).toBe(path.join(t.dir, '.kkb'))
    const meta = JSON.parse(await readFile(t.ws.paths.metaFile, 'utf8')) as Record<string, unknown>
    expect(meta['version']).toBe(1)
    expect(typeof meta['clientId']).toBe('string')
    expect(typeof meta['id']).toBe('string')
  })
})

describe('持久化', () => {
  it('关掉再打开，卡片树还在', async () => {
    const t = await open()
    const before = t.ws.allCards().length
    const firstColumn = t.ws.childCards('001')[0]!.id
    const { created } = await t.ws.execute({ type: 'card_create', parent: firstColumn, title: '活过重启' })
    const id = created as string

    await t.reopen()

    expect(t.ws.allCards().length).toBe(before + 1)
    expect(t.ws.getCard(id)?.title).toBe('活过重启')
    expect(t.ws.getCard(id)?.parent).toBe(firstColumn)
  })

  it('没动过的卡片文件在重开后逐字节不变', async () => {
    const t = await open()
    const file = cardFilePath(t.ws.paths, '001')
    const before = await readFile(file, 'utf8')

    await t.reopen()

    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('浮卡的窗口状态能存下来', async () => {
    const t = await open()
    const { created } = await t.ws.execute({ type: 'card_create', parent: null, title: '浮卡' })
    const id = created as string
    expect(t.ws.getCard(id)?.window).toBeDefined()

    await t.reopen()

    const restored = t.ws.getCard(id)
    expect(restored?.parent).toBeNull()
    expect(restored?.window?.width).toBe(320)
    expect(t.ws.floatingCards().map((c) => c.id)).toEqual([id])
  })
})

describe('加锁', () => {
  it('同一个工作区不能被两个实例同时打开', async () => {
    const t = await open()
    await expect(Workspace.open({ dir: t.dir })).rejects.toThrowError(/已经被另一个进程占用/)
  })

  it('关掉之后锁会释放，可以重新打开', async () => {
    const t = await open()
    await t.ws.close()
    const again = await Workspace.open({ dir: t.dir })
    expect(again.hasCard('001')).toBe(true)
    await again.close()
  })

  it('lock: false 可以跳过加锁', async () => {
    temp = await makeTempWorkspace()
    const second = await Workspace.open({ dir: temp.dir, lock: false })
    expect(second.hasCard('001')).toBe(true)
    await second.close()
  })
})

describe('优雅关闭', () => {
  it('close() 会等在飞的写入结束，不丢事件', async () => {
    const t = await open()
    const column = t.ws.childCards('001')[0]!.id

    const inFlight = t.ws.execute({ type: 'card_create', parent: column, title: '并发写入' })
    const closing = t.ws.close()

    await inFlight
    await closing

    const raw = await readFile(t.ws.paths.eventsFile, 'utf8')
    const events = raw.split('\n').filter((line) => line.trim() !== '')
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0] as string).type).toBe('child_add')

    // 卡片文件也要在
    const reopened = await Workspace.open({ dir: t.dir })
    expect(reopened.allCards().some((c) => c.title === '并发写入')).toBe(true)
    expect(reopened.lastSeq()).toBe(1)
    await reopened.close()
  })

  it('关闭之后不能再写', async () => {
    const t = await open()
    await t.ws.close()
    await expect(
      t.ws.execute({ type: 'card_create', parent: '001', title: 'X' }),
    ).rejects.toThrowError(/已经关闭了/)
  })
})

describe('并发写入', () => {
  it('并发的 execute 不会互相踩事件缓冲区', async () => {
    const t = await open()
    const column = t.ws.childCards('001')[0]!.id

    const outcomes = await Promise.all([
      t.ws.execute({ type: 'card_create', parent: column, title: 'A' }),
      t.ws.execute({ type: 'card_create', parent: column, title: 'B' }),
      t.ws.execute({ type: 'card_create', parent: column, title: 'C' }),
    ])

    // 每次调用都该拿到恰好一条自己的事件
    for (const outcome of outcomes) {
      expect(outcome.events).toHaveLength(1)
    }

    // 三条事件一条不少，也一条不多
    const events = await t.ws.readEvents()
    expect(events).toHaveLength(3)
    expect(new Set(events.map((e) => e.seq)).size).toBe(3)

    // 三张卡都在
    expect(t.ws.childCards(column)).toHaveLength(3)
  })

  it('并发写入之后，撤销栈也是完整的', async () => {
    const t = await open()
    const column = t.ws.childCards('001')[0]!.id

    await Promise.all([
      t.ws.execute({ type: 'card_create', parent: column, title: 'A' }),
      t.ws.execute({ type: 'card_create', parent: column, title: 'B' }),
    ])

    expect(t.ws.canUndo()).toBe(true)
    await t.ws.undo()
    await t.ws.undo()
    expect(t.ws.childCards(column)).toHaveLength(0)
  })
})

describe('完整性校验', () => {
  it('parent 指向不存在的卡片时拒绝加载，并说清哪张卡', async () => {
    const t = await open()
    const orphan = card('c_orphan', { parent: 'c_ghost', title: '孤儿' })
    await writeFile(path.join(t.ws.paths.cardsDir, 'c_orphan.md'), serializeCard(orphan), 'utf8')

    await expect(t.reopen()).rejects.toThrowError(/c_orphan 的 parent 指向不存在的卡片 c_ghost/)
  })

  it('同一张子卡挂在两个父卡下时拒绝加载', async () => {
    const t = await open()
    const shared = card('c_shared', { parent: 'c_a', title: '被抢的孩子' })
    const a = card('c_a', { parent: null, title: '甲', children: [{ id: 'c_shared' }] })
    const b = card('c_b', { parent: null, title: '乙', children: [{ id: 'c_shared' }] })
    for (const item of [shared, a, b]) {
      await writeFile(path.join(t.ws.paths.cardsDir, `${item.id}.md`), serializeCard(item), 'utf8')
    }

    await expect(t.reopen()).rejects.toThrowError(/c_shared 出现在 c_b 的 children 里，但它的 parent 是 c_a/)
  })

  it('出现环时拒绝加载', async () => {
    const t = await open()
    const p = card('c_p', { parent: 'c_q', title: 'P', children: [{ id: 'c_q' }] })
    const q = card('c_q', { parent: 'c_p', title: 'Q', children: [{ id: 'c_p' }] })
    for (const item of [p, q]) {
      await writeFile(path.join(t.ws.paths.cardsDir, `${item.id}.md`), serializeCard(item), 'utf8')
    }

    await expect(t.reopen()).rejects.toThrowError(/祖先链里出现了环/)
  })

  it('缺保留根时，bootstrap: false 会拒绝加载', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kkb-bare-'))
    try {
      await expect(Workspace.open({ dir, bootstrap: false })).rejects.toThrowError(/缺少保留根卡片 000/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('保留根的文件不见了，默认会补回来', async () => {
    temp = await makeTempWorkspace()
    const board = cardFilePath(temp.ws.paths, '001')
    const columns = temp.ws.childCards('001').map((c) => c.id)
    await rm(board, { force: true })

    await temp.reopen()

    expect(temp.ws.hasCard('001')).toBe(true)
    // 补回来的看板不重建列——列还在，只是爹刚才丢了
    for (const id of columns) expect(temp.ws.getCard(id)?.parent).toBe('001')
  })
})
