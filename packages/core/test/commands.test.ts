import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KkbError, Workspace } from '../src/index.ts'
import type { Card } from '../src/index.ts'
import { makeTempWorkspace } from './helpers.ts'
import type { TempWorkspace } from './helpers.ts'

let temp: TempWorkspace | null = null
let ws: Workspace
let todo: string
let doing: string

beforeEach(async () => {
  temp = await makeTempWorkspace()
  ws = temp.ws
  const columns = ws.childCards('001')
  todo = columns[0]!.id
  doing = columns[1]!.id
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

function childrenIds(parentId: string): string[] {
  return ws.requireCard(parentId).children.map((entry) => entry.id)
}

/** 断言这次操作失败，并且错误码是期望的那个。 */
async function expectCode(promise: Promise<unknown>, code: string): Promise<KkbError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(KkbError)
    const kkb = error as KkbError
    expect(kkb.code).toBe(code)
    return kkb
  }
  throw new Error(`本应失败，但成功了（期望错误码 ${code}）`)
}

// ---------------------------------------------------------------------------

describe('card_create', () => {
  it('建在看板列里就是公有的', async () => {
    const id = await createTask(todo, '画一张概念图')
    const card = ws.requireCard(id)
    expect(card.parent).toBe(todo)
    expect(card.scope).toBe('public')
    expect(childrenIds(todo)).toEqual([id])
  })

  it('建在浮卡底下就是私有的', async () => {
    const floating = await createTask(null, '桌面上的卡')
    const child = await createTask(floating, '浮卡的孩子')
    expect(ws.requireCard(floating).scope).toBe('private')
    expect(ws.requireCard(child).scope).toBe('private')
  })

  it('建在看板上时缺省视图是「一列」', async () => {
    const column = await createTask('001', '新的列')
    expect(ws.requireCard(column).view).toBe('column')
  })

  it('建在普通卡里时缺省视图是「一行」', async () => {
    const card = await createTask(todo, '普通卡')
    expect(ws.requireCard(card).view).toBe('row')
  })

  it('可以指定落点', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B')
    const c = await createTask(todo, 'C', { index: 1 })
    expect(childrenIds(todo)).toEqual([a, c, b])
  })

  it('落点越界会被夹到合法范围，而不是报错', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B', { index: 99 })
    expect(childrenIds(todo)).toEqual([a, b])
  })

  it('显式 id 撞车会报 ID_DUPLICATE', async () => {
    await createTask(todo, 'A', { id: 'c_fixed' })
    await expectCode(ws.execute({ type: 'card_create', parent: todo, id: 'c_fixed', title: 'B' }), 'ID_DUPLICATE')
  })

  it('不能往回收站里的卡里建卡', async () => {
    const id = await createTask(todo, '要被删的')
    await ws.execute({ type: 'card_trash', id })
    await expect(ws.execute({ type: 'card_create', parent: id, title: 'X' })).rejects.toThrowError(
      /已在回收站里/,
    )
  })

  it('父卡不存在时报 CARD_NOT_FOUND', async () => {
    await expect(ws.execute({ type: 'card_create', parent: 'c_ghost', title: 'X' })).rejects.toThrowError(
      /找不到卡片 c_ghost/,
    )
  })

  it('新建的浮卡会错开位置，不会叠在一起', async () => {
    const ids = [await createTask(null, '浮卡一'), await createTask(null, '浮卡二'), await createTask(null, '浮卡三')]
    const keys = ids.map((id) => {
      const win = ws.requireCard(id).window
      return `${win?.x},${win?.y}`
    })
    expect(keys.every((k) => !k.startsWith('undefined'))).toBe(true)
    expect(new Set(keys).size).toBe(3)
  })

  it('发出的是 child_add，after 里带整张卡（同步端要能靠它还原）', async () => {
    const outcome = await ws.execute({ type: 'card_create', parent: todo, title: '带快照' })
    expect(outcome.events).toHaveLength(1)
    const event = outcome.events[0]!
    expect(event.type).toBe('child_add')
    expect(event.cardId).toBe(todo)
    expect(event.path).toBe('/children/0')
    const after = event.after as { entry: { id: string }; card: Card }
    expect(after.entry.id).toBe(outcome.created)
    expect(after.card.title).toBe('带快照')
  })
})

// ---------------------------------------------------------------------------

describe('card_update', () => {
  it('改标题、正文、颜色、日期、标签', async () => {
    const id = await createTask(todo, '原题')
    await ws.execute({
      type: 'card_update',
      id,
      patch: { title: '新题', content: '# 正文', color: '#FF0000', due: '2025-06-01', tags: ['art'] },
    })
    const card = ws.requireCard(id)
    expect(card.title).toBe('新题')
    expect(card.content).toBe('# 正文')
    expect(card.color).toBe('#FF0000')
    expect(card.due).toBe('2025-06-01')
    expect(card.tags).toEqual(['art'])
  })

  it('标签会去重并去掉空白', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({ type: 'card_update', id, patch: { tags: ['art', ' art ', '', 'code', 'code'] } })
    expect(ws.requireCard(id).tags).toEqual(['art', 'code'])
  })

  it('null 表示清除可选字段', async () => {
    const id = await createTask(todo, 'A', { color: '#FF0000', due: '2025-06-01' })
    await ws.execute({ type: 'card_update', id, patch: { color: null, due: null } })
    expect(ws.requireCard(id).color).toBeUndefined()
    expect(ws.requireCard(id).due).toBeUndefined()
  })

  it('日期格式不对会报错', async () => {
    const id = await createTask(todo, 'A')
    await expect(ws.execute({ type: 'card_update', id, patch: { due: '六月一号' } })).rejects.toThrowError(
      /due 应该是 YYYY-MM-DD 形式的日期/,
    )
  })

  it('颜色格式不对会报错', async () => {
    const id = await createTask(todo, 'A')
    await expect(ws.execute({ type: 'card_update', id, patch: { color: 'red' } })).rejects.toThrowError(
      /color 应该是 #RRGGBB 形式的颜色/,
    )
  })

  it('想改结构类字段会被引导到正确的命令', async () => {
    const id = await createTask(todo, 'A')
    await expect(
      ws.execute({ type: 'card_update', id, patch: { children: [] } as never }),
    ).rejects.toThrowError(/请用 card_move \/ children_reorder/)
  })

  it('保留根的 view 不能改', async () => {
    await expect(ws.execute({ type: 'card_update', id: '001', patch: { view: 'grid' } })).rejects.toThrowError(
      /保留根卡片，不能把 view 改成/,
    )
  })

  it('保留根的标题可以改', async () => {
    await ws.execute({ type: 'card_update', id: '001', patch: { title: '主看板' } })
    expect(ws.requireCard('001').title).toBe('主看板')
  })

  it('值没变就不产生事件，也不进撤销栈', async () => {
    const id = await createTask(todo, 'A')
    const outcome = await ws.execute({ type: 'card_update', id, patch: { title: 'A' } })
    expect(outcome.events).toHaveLength(0)
    expect(outcome.recorded).toBe(false)
  })

  it('改回收站里的卡会被拒绝', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({ type: 'card_trash', id })
    await expect(ws.execute({ type: 'card_update', id, patch: { title: 'B' } })).rejects.toThrowError(
      /已在回收站里/,
    )
  })

  it('中途校验失败时，前面已经改掉的字段也要回滚（命令是原子的）', async () => {
    const id = await createTask(todo, 'A', { color: '#111111' })
    const before = ws.requireCard(id)
    const eventsBefore = (await ws.readEvents()).length

    await expect(
      ws.execute({ type: 'card_update', id, patch: { color: '#FF0000', due: '不是日期' } }),
    ).rejects.toThrowError(/due 应该是 YYYY-MM-DD/)

    const after = ws.requireCard(id)
    expect(after.color).toBe('#111111')
    expect(after.updatedAt).toBe(before.updatedAt)
    expect((await ws.readEvents()).length).toBe(eventsBefore)
  })
})

// ---------------------------------------------------------------------------

describe('card_move', () => {
  it('跨列移动：两张列的 children 都对，parent 也更新了', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B')
    await ws.execute({ type: 'card_move', id: a, parent: doing })

    expect(childrenIds(todo)).toEqual([b])
    expect(childrenIds(doing)).toEqual([a])
    expect(ws.requireCard(a).parent).toBe(doing)
  })

  it('同列内换位', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B')
    const c = await createTask(todo, 'C')
    await ws.execute({ type: 'card_move', id: a, parent: todo, index: 2 })
    expect(childrenIds(todo)).toEqual([b, c, a])
  })

  it('原地不动是空操作', async () => {
    const a = await createTask(todo, 'A')
    await createTask(todo, 'B')
    const outcome = await ws.execute({ type: 'card_move', id: a, parent: todo, index: 0 })
    expect(outcome.events).toHaveLength(0)
    expect(outcome.recorded).toBe(false)
  })

  it('移动到自己的后代里会被拒绝', async () => {
    const parent = await createTask(todo, '父')
    const child = await createTask(parent, '子')
    await expectCode(ws.execute({ type: 'card_move', id: parent, parent: child }), 'CYCLE_DETECTED')
  })

  it('保留根不能被移动', async () => {
    await expect(ws.execute({ type: 'card_move', id: '001', parent: doing })).rejects.toThrowError(
      /保留根卡片，不能移动/,
    )
  })

  it('移到 null 就变成浮卡，带上窗口状态，作用域变私有', async () => {
    const id = await createTask(todo, '要浮起来的')
    const outcome = await ws.execute({ type: 'card_move', id, parent: null })

    const card = ws.requireCard(id)
    expect(card.parent).toBeNull()
    expect(card.window).toBeDefined()
    expect(card.scope).toBe('private')
    expect(childrenIds(todo)).toEqual([])
    expect(outcome.windowOps).toEqual([{ op: 'open', cardId: id }])
  })

  it('从浮卡收回容器里会要求关窗', async () => {
    const floating = await createTask(null, '浮卡')
    const outcome = await ws.execute({ type: 'card_move', id: floating, parent: doing })
    expect(outcome.windowOps).toEqual([{ op: 'close', cardId: floating }])
    expect(ws.requireCard(floating).parent).toBe(doing)
  })

  it('作用域跟着所在的树走，整棵子树一起变', async () => {
    const floating = await createTask(null, '浮卡的根')
    const child = await createTask(floating, '浮卡的孩子')
    expect(ws.requireCard(child).scope).toBe('private')

    await ws.execute({ type: 'card_move', id: floating, parent: doing })

    expect(ws.requireCard(floating).scope).toBe('public')
    expect(ws.requireCard(child).scope).toBe('public')

    await ws.execute({ type: 'card_move', id: floating, parent: null })
    expect(ws.requireCard(floating).scope).toBe('private')
    expect(ws.requireCard(child).scope).toBe('private')
  })

  it('移进灵感台（plane）会拿到坐标，移回看板坐标消失', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({ type: 'card_move', id, parent: '002' })

    const entry = ws.requireCard('002').children.find((e) => e.id === id)
    expect(entry?.layout).toBeDefined()
    expect(entry?.layout?.w).toBe(200)

    await ws.execute({ type: 'card_move', id, parent: doing })
    const back = ws.requireCard(doing).children.find((e) => e.id === id)
    expect(back?.layout).toBeUndefined()
  })

  it('可以指定落点坐标', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({
      type: 'card_move',
      id,
      parent: '002',
      layout: { x: 11, y: 22, w: 33, h: 44, z: 5 },
    })
    const entry = ws.requireCard('002').children.find((e) => e.id === id)
    expect(entry?.layout).toEqual({ x: 11, y: 22, w: 33, h: 44, z: 5 })
  })

  it('不能移进回收站里的父卡', async () => {
    const graveyard = await createTask(todo, '回收站')
    const victim = await createTask(todo, '无辜的卡')
    await ws.execute({ type: 'card_trash', id: graveyard })
    await expect(ws.execute({ type: 'card_move', id: victim, parent: graveyard })).rejects.toThrowError(
      /「回收站」\(.*\) 已在回收站里/,
    )
  })

  it('可以把卡从回收站的父卡底下捞出来', async () => {
    const graveyard = await createTask(todo, '回收站')
    const victim = await createTask(graveyard, '被困的卡')
    await ws.execute({ type: 'card_trash', id: graveyard })

    await ws.execute({ type: 'card_move', id: victim, parent: doing })
    expect(ws.requireCard(victim).parent).toBe(doing)
    expect(ws.isHidden(victim)).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('card_trash / card_restore', () => {
  it('删掉后从可见集合消失，但没有真的消失', async () => {
    const id = await createTask(todo, '要删的')
    await ws.execute({ type: 'card_trash', id })

    expect(ws.getCard(id)).toBeDefined()
    expect(ws.requireCard(id, { allowTrashed: true }).trashed).toBe(true)
    expect(ws.visibleCards().map((c) => c.id)).not.toContain(id)
    // 父卡的 children 里仍然留着它——删除是标记，不是拆树
    expect(childrenIds(todo)).toEqual([id])
    expect(ws.isHidden(id)).toBe(true)
  })

  it('删一张卡会连它的子树一起从视图里拿走', async () => {
    const parent = await createTask(todo, '父')
    const child = await createTask(parent, '子')
    await ws.execute({ type: 'card_trash', id: parent })

    expect(ws.isHidden(child)).toBe(true)
    expect(ws.requireCard(child).trashed).toBeUndefined()
  })

  it('删掉时提醒你下面还有子卡', async () => {
    const parent = await createTask(todo, '父')
    await createTask(parent, '子')
    await createTask(parent, '子二号')
    const outcome = await ws.execute({ type: 'card_trash', id: parent })
    expect(outcome.warnings[0]).toMatch(/下面还有 2 张子卡/)
  })

  it('保留根不能被删', async () => {
    await expect(ws.execute({ type: 'card_trash', id: '001' })).rejects.toThrowError(/保留根卡片，不能删除/)
  })

  it('删浮卡时会要求关窗', async () => {
    const floating = await createTask(null, '浮卡')
    const outcome = await ws.execute({ type: 'card_trash', id: floating })
    expect(outcome.windowOps).toEqual([{ op: 'close', cardId: floating }])
  })

  it('重复删是空操作', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({ type: 'card_trash', id })
    const again = await ws.execute({ type: 'card_trash', id })
    expect(again.events).toHaveLength(0)
    expect(again.recorded).toBe(false)
  })

  it('恢复之后重新出现', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({ type: 'card_trash', id })
    await ws.execute({ type: 'card_restore', id })

    expect(ws.requireCard(id).trashed).toBeUndefined()
    expect(ws.isHidden(id)).toBe(false)
    expect(ws.visibleCards().map((c) => c.id)).toContain(id)
  })

  it('父卡还在回收站里时，恢复子卡会给出提醒', async () => {
    const parent = await createTask(todo, '父')
    const child = await createTask(parent, '子')
    await ws.execute({ type: 'card_trash', id: child })
    await ws.execute({ type: 'card_trash', id: parent })

    const outcome = await ws.execute({ type: 'card_restore', id: child })

    expect(outcome.warnings[0]).toMatch(/还在回收站里/)
    expect(ws.requireCard(child).trashed).toBeUndefined()
    // 自己恢复干净了，但祖先还压着，所以仍然看不见
    expect(ws.isHidden(child)).toBe(true)
  })

  it('没被删、只是被祖先压住的卡，恢复时会解释原因', async () => {
    const parent = await createTask(todo, '父')
    const child = await createTask(parent, '子')
    await ws.execute({ type: 'card_trash', id: parent })

    const outcome = await ws.execute({ type: 'card_restore', id: child })

    expect(outcome.events).toHaveLength(0)
    expect(outcome.warnings[0]).toMatch(/自己不在回收站里/)
    expect(outcome.warnings[0]).toMatch(/父/)
  })
})

// ---------------------------------------------------------------------------

describe('children_reorder', () => {
  it('按给定顺序重排', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B')
    const c = await createTask(todo, 'C')
    await ws.execute({ type: 'children_reorder', parent: todo, order: [c, a, b] })
    expect(childrenIds(todo)).toEqual([c, a, b])
  })

  it('数量对不上会报错', async () => {
    const a = await createTask(todo, 'A')
    await createTask(todo, 'B')
    await expect(ws.execute({ type: 'children_reorder', parent: todo, order: [a] })).rejects.toThrowError(
      /新的顺序有 1 项，但「待办」下面有 2 张子卡/,
    )
  })

  it('混进别的父卡下的子卡会报错', async () => {
    const a = await createTask(todo, 'A')
    await createTask(todo, 'B')
    const outsider = await createTask(doing, '别人家的')
    await expect(
      ws.execute({ type: 'children_reorder', parent: todo, order: [a, outsider] }),
    ).rejects.toThrowError(/不在「待办」下面/)
  })

  it('重复的 id 会报错', async () => {
    const a = await createTask(todo, 'A')
    await createTask(todo, 'B')
    await expect(ws.execute({ type: 'children_reorder', parent: todo, order: [a, a] })).rejects.toThrowError(
      /出现了多次/,
    )
  })

  it('顺序没变是空操作', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B')
    const outcome = await ws.execute({ type: 'children_reorder', parent: todo, order: [a, b] })
    expect(outcome.events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('children_layout', () => {
  it('设置和清除坐标', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({ type: 'card_move', id, parent: '002' })

    await ws.execute({
      type: 'children_layout',
      parent: '002',
      id,
      layout: { x: 1, y: 2, w: 3, h: 4, z: 5 },
    })
    expect(ws.requireCard('002').children.find((e) => e.id === id)?.layout).toEqual({
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      z: 5,
    })

    await ws.execute({ type: 'children_layout', parent: '002', id })
    expect(ws.requireCard('002').children.find((e) => e.id === id)?.layout).toBeUndefined()
  })

  it('子卡不在这个父卡下会报错', async () => {
    const id = await createTask(todo, 'A')
    await expect(
      ws.execute({ type: 'children_layout', parent: doing, id, layout: { x: 0, y: 0, w: 1, h: 1, z: 0 } }),
    ).rejects.toThrowError(/不在「进行中」下面/)
  })
})

// ---------------------------------------------------------------------------

describe('事件日志', () => {
  it('seq 单调递增', async () => {
    await createTask(todo, 'A')
    await createTask(todo, 'B')
    await createTask(doing, 'C')
    const events = await ws.readEvents()
    const seqs = events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('每条事件都带 id / clientId / timestamp / path', async () => {
    await createTask(todo, 'A')
    const [event] = await ws.readEvents()
    expect(event?.id).toMatch(/^e_/)
    expect(event?.clientId).toBe(ws.meta.clientId)
    expect(typeof event?.timestamp).toBe('number')
    expect(event?.path).toBe('/children/0')
  })

  it('字段修改事件带 before 和 after', async () => {
    const id = await createTask(todo, '老的')
    await ws.execute({ type: 'card_update', id, patch: { title: '新的' } })
    const events = await ws.readEvents()
    const titleEvent = events.find((e) => e.path === '/title')
    expect(titleEvent?.before).toBe('老的')
    expect(titleEvent?.after).toBe('新的')
    expect(titleEvent?.type).toBe('field_set')
  })

  it('readSince 只拿新事件', async () => {
    await createTask(todo, 'A')
    const mark = ws.lastSeq()
    await createTask(todo, 'B')
    const newer = await ws.readEvents({ since: mark })
    expect(newer).toHaveLength(1)
    expect(newer[0]?.seq).toBe(mark + 1)
  })

  it('重启后 seq 不会回退到 0，日志继续追加', async () => {
    const first = await createTask(todo, 'A')
    const mark = ws.lastSeq()
    await temp!.reopen()
    ws = temp!.ws
    expect(ws.lastSeq()).toBe(mark)

    await ws.execute({ type: 'card_create', parent: todo, title: 'B' })
    expect(ws.lastSeq()).toBe(mark + 1)
    expect(ws.getCard(first)?.title).toBe('A')
  })

  it('事件日志最后一行被截断时不影响加载', async () => {
    await createTask(todo, 'A')
    const { appendFile } = await import('node:fs/promises')
    await appendFile(ws.paths.eventsFile, '{"seq":999,"id":"e_broken"', 'utf8')

    await temp!.reopen()
    ws = temp!.ws
    expect(ws.lastSeq()).toBe(1)
  })

  it('中间某行坏掉会明确报错', async () => {
    await createTask(todo, 'A')
    const { appendFile } = await import('node:fs/promises')
    await appendFile(ws.paths.eventsFile, '这行根本不是 JSON\n{"seq":2}\n', 'utf8')

    await expect(ws.readEvents()).rejects.toThrowError(/不是合法的 JSON/)
  })
})
