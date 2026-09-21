import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { KkbError } from './errors.ts'
import type { KkbEvent } from './types.ts'
import { WriteQueue } from './write-queue.ts'

/**
 * 事件日志：一行一个事件，只追加。
 *
 * 定位很重要：**文件是真相，这份日志是派生的流水**。
 * 启动时从卡片文件读树，不从日志重放。日志的用途是后续同步、审计，
 * 以及回答「最近改了什么」——人和 AI 都会问这个问题。
 */

function ioError(message: string, details: Record<string, unknown> = {}): KkbError {
  return new KkbError('IO_ERROR', message, details)
}

/** 读整个日志。最后一行如果是被截断的半行，忽略它（写入中途断电的正常产物）。 */
export async function readEventsFromFile(file: string): Promise<KkbEvent[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw ioError(`读不了事件日志 ${file}：${e instanceof Error ? e.message : String(e)}`, { file })
  }

  const lines = text.split('\n')
  const out: KkbEvent[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || line.trim() === '') continue

    try {
      out.push(JSON.parse(line) as KkbEvent)
    } catch {
      const nothingAfter = lines.slice(i + 1).every((rest) => rest.trim() === '')
      if (nothingAfter) break
      throw ioError(`${file} 第 ${i + 1} 行不是合法的 JSON，事件日志损坏了。`, {
        file,
        line: i + 1,
      })
    }
  }

  return out
}

export class EventLog {
  readonly file: string
  /** 已分配的最大 seq。下一个事件用 nextSeq()。 */
  lastSeq: number
  private readonly queue = new WriteQueue()

  constructor(file: string, lastSeq = 0) {
    this.file = file
    this.lastSeq = lastSeq
  }

  static async open(file: string): Promise<EventLog> {
    await mkdir(path.dirname(file), { recursive: true })
    const events = await readEventsFromFile(file)
    const last = events.at(-1)
    return new EventLog(file, last?.seq ?? 0)
  }

  /**
   * 分配下一个 seq。
   * 单调递增是硬要求：光靠 timestamp 排序在同步时会出错（时钟回拨、同毫秒）。
   */
  nextSeq(): number {
    this.lastSeq += 1
    return this.lastSeq
  }

  /** 追加一批事件。走队列，保证落盘顺序和调用顺序一致。 */
  async append(events: readonly KkbEvent[]): Promise<void> {
    if (events.length === 0) return
    const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
    await this.queue.run(() => appendFile(this.file, text, 'utf8'))
  }

  async readAll(): Promise<KkbEvent[]> {
    await this.queue.drain()
    return readEventsFromFile(this.file)
  }

  /** 读 seq 大于给定值的事件。 */
  async readSince(seq: number, limit = 500): Promise<KkbEvent[]> {
    const all = await this.readAll()
    return all.filter((event) => event.seq > seq).slice(0, limit)
  }

  async count(): Promise<number> {
    return (await this.readAll()).length
  }

  /** 等排队中的追加全部落盘。关闭工作区前必须等，否则进程退出会砍掉还没写完的事件。 */
  async drain(): Promise<void> {
    await this.queue.drain()
  }
}
