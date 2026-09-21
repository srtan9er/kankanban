import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Workspace } from '../src/index.ts'
import type { Card, OpenWorkspaceOptions } from '../src/index.ts'

/** 测试用卡片工厂。 */
export function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    parent: null,
    children: [],
    title: id,
    content: '',
    scope: 'private',
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'test',
    ...overrides,
  }
}

export function lookupOf(cards: readonly Card[]): (id: string) => Card | undefined {
  const map = new Map(cards.map((item) => [item.id, item]))
  return (id) => map.get(id)
}

export interface TempWorkspace {
  readonly ws: Workspace
  readonly dir: string
  reopen(): Promise<Workspace>
  cleanup(): Promise<void>
}

/** 每个测试一个独立的工作区，用完删干净。 */
export async function makeTempWorkspace(
  overrides: Partial<OpenWorkspaceOptions> = {},
): Promise<TempWorkspace> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kkb-test-'))
  let current: Workspace | null = await Workspace.open({ dir, ...overrides })

  return {
    get ws(): Workspace {
      if (current === null) throw new Error('工作区已经关掉了')
      return current
    },
    get dir(): string {
      return dir
    },
    async reopen(): Promise<Workspace> {
      if (current !== null) await current.close()
      current = await Workspace.open({ dir, ...overrides })
      return current
    },
    async cleanup(): Promise<void> {
      if (current !== null) {
        await current.close().catch(() => undefined)
        current = null
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** 取板上第一列。看板预置了「待办 / 进行中 / 完成」三列。 */
export function firstColumn(ws: Workspace): string {
  const column = ws.childCards('001')[0]
  if (column === undefined) throw new Error('看板上没有列')
  return column.id
}
