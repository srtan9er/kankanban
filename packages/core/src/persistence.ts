import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { CARD_FILE_EXT, parseCard, serializeCard } from './card-file.ts'
import { KkbError } from './errors.ts'
import { createClientId, createWorkspaceId } from './ids.ts'
import type { Card, WorkspaceMeta } from './types.ts'
import { WORKSPACE_FORMAT_VERSION } from './types.ts'
import { WriteQueue } from './write-queue.ts'

/**
 * 磁盘布局：
 *
 * ```
 * .kkb/
 *   cards/<card-id>.md    # frontmatter 存字段，正文存 content
 *   events.jsonl          # 事件日志
 *   workspace.json        # 工作区元数据
 *   lock                  # 防双写
 * ```
 *
 * 没有 tree.json：树结构就活在每张卡的 children 里。
 * 一张卡自包含，git diff 才可读，也不会出现两份真相。
 */

export interface KkbPaths {
  root: string
  kkbDir: string
  cardsDir: string
  eventsFile: string
  metaFile: string
  lockFile: string
}

export function kkbPaths(root: string): KkbPaths {
  const kkbDir = path.join(root, '.kkb')
  return {
    root,
    kkbDir,
    cardsDir: path.join(kkbDir, 'cards'),
    eventsFile: path.join(kkbDir, 'events.jsonl'),
    metaFile: path.join(kkbDir, 'workspace.json'),
    lockFile: path.join(kkbDir, 'lock'),
  }
}

export function cardFilePath(paths: KkbPaths, id: string): string {
  return path.join(paths.cardsDir, `${id}${CARD_FILE_EXT}`)
}

function ioError(message: string, details: Record<string, unknown> = {}): KkbError {
  return new KkbError('IO_ERROR', message, details)
}

/**
 * 原子写：先写临时文件再改名。
 * 直接覆写的话，进程在写到一半时挂掉就会留下半个卡片文件。
 */
export async function atomicWriteFile(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw ioError(`写文件失败 ${file}：${e instanceof Error ? e.message : String(e)}`, { file })
  }
}

export class Persistence {
  readonly paths: KkbPaths
  private readonly queue = new WriteQueue()

  constructor(paths: KkbPaths) {
    this.paths = paths
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.paths.cardsDir, { recursive: true })
  }

  async saveCard(card: Card): Promise<void> {
    const file = cardFilePath(this.paths, card.id)
    const content = serializeCard(card)
    await this.queue.run(() => atomicWriteFile(file, content))
  }

  /** 批量保存，顺序与传入顺序一致。 */
  async saveCards(cards: readonly Card[]): Promise<void> {
    for (const card of cards) await this.saveCard(card)
  }

  async deleteCardFile(id: string): Promise<void> {
    const file = cardFilePath(this.paths, id)
    await this.queue.run(() => rm(file, { force: true }))
  }

  async loadCards(): Promise<Map<string, Card>> {
    const out = new Map<string, Card>()

    let names: string[]
    try {
      const entries = await readdir(this.paths.cardsDir, { withFileTypes: true })
      names = entries.filter((e) => e.isFile()).map((e) => e.name)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out
      throw ioError(`读不了卡片目录 ${this.paths.cardsDir}：${e instanceof Error ? e.message : String(e)}`)
    }

    for (const name of names.sort()) {
      if (name.startsWith('.') || !name.endsWith(CARD_FILE_EXT)) continue
      const id = name.slice(0, -CARD_FILE_EXT.length)
      const file = path.join(this.paths.cardsDir, name)

      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch (e) {
        throw ioError(`读不了卡片文件 ${file}：${e instanceof Error ? e.message : String(e)}`, { file })
      }

      out.set(id, parseCard(raw, { expectedId: id, source: file }))
    }

    return out
  }

  async loadMeta(): Promise<WorkspaceMeta | null> {
    let raw: string
    try {
      raw = await readFile(this.paths.metaFile, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw ioError(`读不了工作区元数据 ${this.paths.metaFile}：${e instanceof Error ? e.message : String(e)}`)
    }

    try {
      return JSON.parse(raw) as WorkspaceMeta
    } catch (e) {
      throw ioError(`工作区元数据 ${this.paths.metaFile} 不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async saveMeta(meta: WorkspaceMeta): Promise<void> {
    await this.queue.run(() => atomicWriteFile(this.paths.metaFile, JSON.stringify(meta, null, 2) + '\n'))
  }

  async createMeta(name: string): Promise<WorkspaceMeta> {
    const meta: WorkspaceMeta = {
      version: WORKSPACE_FORMAT_VERSION,
      id: createWorkspaceId(),
      name,
      clientId: createClientId(),
      createdAt: Date.now(),
    }
    await this.saveMeta(meta)
    return meta
  }

  async drain(): Promise<void> {
    await this.queue.drain()
  }
}

// ---------------------------------------------------------------------------
// 双写保护
// ---------------------------------------------------------------------------

export interface LockInfo {
  pid: number
  host: string
  startedAt: number
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM 说明进程存在但没权限发信号，也算活着。
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readLock(lockFile: string): Promise<LockInfo | null> {
  try {
    const raw = await readFile(lockFile, 'utf8')
    const parsed = JSON.parse(raw) as LockInfo
    return typeof parsed?.pid === 'number' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 拿工作区锁。
 *
 * 为什么需要：Electron 主进程和独立 MCP server 是两个进程，
 * 同时写同一个 .kkb 会互相覆盖。阶段二起 MCP server 搬进主进程，
 * 但独立模式仍然保留给「只让 AI 用」的场景。
 */
export async function acquireLock(lockFile: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(lockFile), { recursive: true })

  const existing = await readLock(lockFile)
  // 同一个 pid 也算占用：两个 Workspace 实例指向同一个目录，一样会互相覆盖。
  if (existing !== null && isProcessAlive(existing.pid)) {
    const mine = existing.pid === process.pid ? '（就是当前进程）' : ''
    throw new KkbError(
      'WORKSPACE_LOCKED',
      `这个工作区已经被另一个进程占用了${mine}（pid ${existing.pid}，启动于 ${new Date(existing.startedAt).toLocaleString()}）。` +
        `如果那是崩溃后留下的僵尸锁，删掉 ${lockFile} 再试。`,
      { lockFile, holder: existing },
    )
  }

  const mine: LockInfo = { pid: process.pid, host: hostname(), startedAt: Date.now() }
  await atomicWriteFile(lockFile, JSON.stringify(mine, null, 2) + '\n')

  return async () => {
    const current = await readLock(lockFile)
    if (current?.pid === process.pid) await rm(lockFile, { force: true })
  }
}
