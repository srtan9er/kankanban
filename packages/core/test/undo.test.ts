import { readFile, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cardFilePath, Workspace } from '../src/index.ts'
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

async function fileText(id: string): Promise<string> {
  return readFile(cardFilePath(ws.paths, id), 'utf8')
}

async function fileExists(id: string): Promise<boolean> {
  try {
    await stat(cardFilePath(ws.paths, id))
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------

describe('撤销建卡', () => {
  it('撤销后卡片和文件都消失，重做后同样的 id 回来', async () => {
    const { created } = await ws.execute({ type: 'card_create', parent: todo, title: '临时任务' })
    const id = created as string
    expect(await fileExists(id)).toBe(true)

    await ws.undo()
    expect(ws.getCard(id)).toBeUndefined()
    expect(await fileExists(id)).toBe(false)
    expect(childrenIds(todo)).toEqual([])

    await ws.redo()
    expect(ws.getCard(id)?.title).toBe('临时任务')
    expect(await fileExists(id)).toBe(true)
    expect(childrenIds(todo)).toEqual([id])
  })

  it('撤销建卡是逐字节干净的——文件真的不在了，而不是留一个空壳', async () => {
    const { created } = await ws.execute({ type: 'card_create', parent: todo, title: '甲' })
    await ws.execute({ type: 'card_create', parent: todo, title: '乙' })
    const id = created as string

    await ws.undo()
    await ws.undo()

    expect(await fileExists(id)).toBe(false)
    expect(childrenIds(todo)).toEqual([])
  })
})

describe('撤销改字段', () => {
  it('撤销后文件逐字节回到原样，重做后逐字节回到改完的样子', async () => {
    const id = await createTask(todo, '原始标题')
    const before = await fileText(id)

    await ws.execute({
      type: 'card_update',
      id,
      patch: { title: '改过的标题', content: '# 正文\n\n写了点东西', color: '#FF0000' },
    })
    const afterChange = await fileText(id)
    expect(afterChange).not.toBe(before)

    await ws.undo()
    expect(await fileText(id)).toBe(before)
    expect(ws.requireCard(id).title).toBe('原始标题')

    await ws.redo()
    expect(await fileText(id)).toBe(afterChange)
    expect(ws.requireCard(id).title).toBe('改过的标题')
  })

  it('撤销「清除字段」会把字段放回去', async () => {
    const id = await createTask(todo, 'A', { color: '#123456' })
    await ws.execute({ type: 'card_update', id, patch: { color: null } })
    expect(ws.requireCard(id).color).toBeUndefined()

    await ws.undo()
    expect(ws.requireCard(id).color).toBe('#123456')
  })

  it('撤销只回滚这次命令碰过的字段', async () => {
    const id = await createTask(todo, 'A', { color: '#111111', due: '2025-01-01' })
    await ws.execute({ type: 'card_update', id, patch: { title: '新标题' } })
    await ws.execute({ type: 'card_update', id, patch: { color: '#222222' } })

    await ws.undo()
    expect(ws.requireCard(id).color).toBe('#111111')
    expect(ws.requireCard(id).title).toBe('新标题')
    expect(ws.requireCard(id).due).toBe('2025-01-01')
  })
})

describe('撤销移动', () => {
  it('位置、父卡关系都回去', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B')
    await ws.execute({ type: 'card_move', id: a, parent: doing })

    await ws.undo()
    expect(childrenIds(todo)).toEqual([a, b])
    expect(childrenIds(doing)).toEqual([])
    expect(ws.requireCard(a).parent).toBe(todo)
  })

  it('同列换位也能撤销', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B')
    const c = await createTask(todo, 'C')
    await ws.execute({ type: 'card_move', id: a, parent: todo, index: 2 })
    expect(childrenIds(todo)).toEqual([b, c, a])

    await ws.undo()
    expect(childrenIds(todo)).toEqual([a, b, c])
  })

  it('作用域的变化也一起回滚', async () => {
    const id = await createTask(todo, 'A')
    expect(ws.requireCard(id).scope).toBe('public')

    await ws.execute({ type: 'card_move', id, parent: null })
    expect(ws.requireCard(id).scope).toBe('private')

    await ws.undo()
    expect(ws.requireCard(id).scope).toBe('public')
    expect(ws.requireCard(id).parent).toBe(todo)
    expect(ws.floatingCards()).toEqual([])
  })

  it('移动的文件内容也能逐字节还原', async () => {
    const id = await createTask(todo, 'A')
    const parentFile = cardFilePath(ws.paths, todo)
    const before = await readFile(parentFile, 'utf8')

    await ws.execute({ type: 'card_move', id, parent: doing })
    await ws.undo()

    expect(await readFile(parentFile, 'utf8')).toBe(before)
  })

  it('坐标的变化也能撤销', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({ type: 'card_move', id, parent: '002', layout: { x: 5, y: 5, w: 100, h: 100, z: 1 } })
    await ws.execute({
      type: 'children_layout',
      parent: '002',
      id,
      layout: { x: 90, y: 90, w: 300, h: 300, z: 9 },
    })
    expect(ws.requireCard('002').children.find((e) => e.id === id)?.layout?.x).toBe(90)

    await ws.undo()
    expect(ws.requireCard('002').children.find((e) => e.id === id)?.layout?.x).toBe(5)
  })
})

describe('撤销删除', () => {
  it('撤销删除把卡片放回可见集合', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({ type: 'card_trash', id })
    expect(ws.isHidden(id)).toBe(true)

    await ws.undo()
    expect(ws.requireCard(id).trashed).toBeUndefined()
    expect(ws.isHidden(id)).toBe(false)
  })

  it('撤销删除整棵子树', async () => {
    const parent = await createTask(todo, '父')
    const child = await createTask(parent, '子')
    await ws.execute({ type: 'card_trash', id: parent })
    await ws.undo()

    expect(ws.isHidden(parent)).toBe(false)
    expect(ws.isHidden(child)).toBe(false)
    expect(childrenIds(parent)).toEqual([child])
  })
})

describe('撤销重排', () => {
  it('顺序回到原样', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B')
    const c = await createTask(todo, 'C')
    await ws.execute({ type: 'children_reorder', parent: todo, order: [c, b, a] })

    await ws.undo()
    expect(childrenIds(todo)).toEqual([a, b, c])

    await ws.redo()
    expect(childrenIds(todo)).toEqual([c, b, a])
  })
})

describe('撤销栈的行为', () => {
  it('连续撤销多步', async () => {
    const a = await createTask(todo, 'A')
    const b = await createTask(todo, 'B')
    await ws.execute({ type: 'card_update', id: a, patch: { title: 'A2' } })

    await ws.undo()
    await ws.undo()
    await ws.undo()

    expect(ws.getCard(a)).toBeUndefined()
    expect(ws.getCard(b)).toBeUndefined()
    expect(ws.canUndo()).toBe(false)
  })

  it('栈空时 undo / redo 返回 null', async () => {
    expect(await ws.redo()).toBeNull()
    const id = await createTask(todo, 'A')
    await ws.undo()
    await ws.undo()
    expect(await ws.undo()).toBeNull()
    expect(ws.getCard(id)).toBeUndefined()
  })

  it('撤销之后做新操作，重做栈就清空了', async () => {
    await createTask(todo, 'A')
    await ws.undo()
    expect(ws.canRedo()).toBe(true)

    await createTask(todo, 'B')
    expect(ws.canRedo()).toBe(false)
  })

  it('撤销和重做不产生新的撤销记录', async () => {
    await createTask(todo, 'A')
    const label = ws.undoLabel()

    await ws.undo()
    await ws.redo()

    expect(ws.undoLabel()).toBe(label)
  })

  it('给出能看懂的操作名', async () => {
    const id = await createTask(todo, '画概念图')
    expect(ws.undoLabel()).toBe('建立卡片「画概念图」')

    await ws.execute({ type: 'card_update', id, patch: { title: '画概念图 v2' } })
    expect(ws.undoLabel()).toBe('修改卡片「画概念图」的 title')

    await ws.execute({ type: 'card_trash', id })
    expect(ws.undoLabel()).toBe('删除卡片「画概念图 v2」')
  })

  it('命令失败时不会污染撤销栈', async () => {
    const id = await createTask(todo, 'A')
    const label = ws.undoLabel()

    await expect(ws.execute({ type: 'card_update', id, patch: { due: '六月' } })).rejects.toThrow()

    expect(ws.undoLabel()).toBe(label)
    expect(ws.canRedo()).toBe(false)
  })
})

describe('撤销之后的重启', () => {
  it('撤销过的状态能正确落盘', async () => {
    const id = await createTask(todo, 'A')
    await ws.execute({ type: 'card_update', id, patch: { title: 'B' } })
    await ws.undo()

    await temp!.reopen()
    ws = temp!.ws

    expect(ws.requireCard(id).title).toBe('A')
    expect(ws.canUndo()).toBe(false)
  })
})
