/**
 * **写回缓冲**：让同步的 core 跑在异步后端（Tauri IPC）之上。
 *
 * 【要解决的问题】core 的 `FsOps` 是同步接口（`readFile` 直接返回字符串），
 * 而 Tauri 的 `invoke` 是异步的 —— 同步接口没法直接建在异步 IPC 上。
 *
 * 两条路：
 *   (a) 把 core 的存储层整个改成 async —— 会牵动 core、操作层、MCP 与**全部测试**
 *   (b) 内存里同步读写，把**变更按顺序记成日志**，之后批量刷到后端 —— 这里选的就是它
 *
 * 选 (b) 的额外好处：一次操作原本要几十次 IPC 往返（每个卡片文件 tmp→fsync→rename），
 * 现在合成**一批**发过去，而且**次序原样保留** —— §4.2 的"日志先于状态"在批内仍然成立。
 *
 * 【耐久性语义】core 返回时数据只在内存里；调用方必须在一次操作后 `await flushTo(backend)`
 * 才算落盘。所以刷盘失败**不丢日志**：journal 保留，可以重试。
 *
 * 【重试的前提】`flushTo` 用游标保证"已经成功的不重放"，这**以"后端是同一个"为前提**。
 * 换一个后端重试是说不通的（已消费的 `mkdirp` 之类不会重来），别那么用。
 */

import type { FsOpName, FsOps } from '../core/storage/fs-ops.ts';
import type { AsyncFsOps } from './async-fs-ops.ts';
import { createMemoryFs, type MemoryFs } from './memory-fs-ops.ts';

type JournalEntry = { op: FsOpName; args: string[] };

export type BufferedFs = {
  /** 给 core 用的同步实现 */
  ops: FsOps;
  /** 内部的内存文件系统 —— 启动时用 `hydrate` 灌数据进来（不走 journal，不算改动） */
  memory: MemoryFs;
  /** 还没刷到后端的写操作数 */
  pendingCount(): number;
  /** 按原顺序刷到后端；成功后清空 journal。失败时保留未完成的部分以便重试。 */
  flushTo(backend: AsyncFsOps): Promise<void>;
  /** 直接看内存内容（测试断言用） */
  snapshot(): Record<string, string>;
  /** 当前积压的 journal（测试断言用） */
  journal(): readonly JournalEntry[];
};

export function createBufferedFs(): BufferedFs {
  const memory = createMemoryFs();
  const entries: JournalEntry[] = [];
  let flushed = 0;
  let flushing: Promise<void> | null = null;

  const drain = async (backend: AsyncFsOps): Promise<void> => {
    while (flushed < entries.length) {
      const entry = entries[flushed];
      if (entry === undefined) break;
      await applyOne(backend, entry);
      flushed += 1;
    }
    entries.length = 0;
    flushed = 0;
  };

  const record =
    <A extends string[]>(op: FsOpName, fn: (...args: A) => void) =>
    (...args: A): void => {
      entries.push({ op, args: [...args] });
      fn(...args);
    };

  const ops: FsOps = {
    // 读永远走内存 —— 这是"同步接口"能成立的全部原因
    exists: memory.ops.exists,
    readFile: memory.ops.readFile,
    readDir: memory.ops.readDir,

    mkdirp: record('mkdirp', (path: string) => memory.ops.mkdirp(path)),
    writeFile: record('writeFile', (path: string, data: string) => memory.ops.writeFile(path, data)),
    rename: record('rename', (from: string, to: string) => memory.ops.rename(from, to)),
    appendFile: record('appendFile', (path: string, data: string) => memory.ops.appendFile(path, data)),
    fsync: record('fsync', (path: string) => memory.ops.fsync(path)),
    remove: record('remove', (path: string) => memory.ops.remove(path)),
  };

  return {
    ops,
    memory,
    pendingCount: () => entries.length - flushed,
    snapshot: memory.snapshot,
    journal: () => entries,

    flushTo: (backend: AsyncFsOps): Promise<void> => {
      // 只推进 `flushed` 游标：中途失败时已成功的那些不会重放，
      // 未完成的留到下一次重试 —— 重放已经做过的写操作是幂等的，
      // 但重放 appendFile 会**重复追加**，所以游标必须精确。
      if (flushing !== null) return flushing;
      flushing = drain(backend).finally(() => { flushing = null; });
      return flushing;
    },
  };
}

async function applyOne(backend: AsyncFsOps, entry: JournalEntry): Promise<void> {
  const [first, second] = entry.args;
  switch (entry.op) {
    case 'mkdirp':
      await backend.mkdirp(first as string);
      return;
    case 'writeFile':
      await backend.writeFile(first as string, second as string);
      return;
    case 'rename':
      await backend.rename(first as string, second as string);
      return;
    case 'appendFile':
      await backend.appendFile(first as string, second as string);
      return;
    case 'fsync':
      await backend.fsync(first as string);
      return;
    case 'remove':
      await backend.remove(first as string);
      return;
  }
}
