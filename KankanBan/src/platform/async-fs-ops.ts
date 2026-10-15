/**
 * **异步**文件系统后端 —— Tauri 的 `invoke` 是异步的，所以真正落盘那一侧必须是异步接口。
 *
 * 分工：
 *   - 应用启动时 `hydrate` 把工作区**读进内存**（异步，只做一次）
 *   - 之后 core 在内存上**同步**跑（`MemoryFs` / `BufferedFs` 的读都是同步的）
 *   - 每次操作后 `flushTo(backend)` 把写操作**按原顺序**刷到后端（异步）
 *
 * 这样 core 与它的 159 条测试一行都不用改成 async，而真机上又是真正落盘的。
 */

import type { FsOps } from '../core/storage/fs-ops.ts';
import type { MemoryFs } from './memory-fs-ops.ts';

export type AsyncFsOps = {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  readDir(path: string): Promise<string[]>;
  mkdirp(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  fsync(path: string): Promise<void>;
  remove(path: string): Promise<void>;
};

/** 把同步实现包成异步（内存、Node 都用得上）。 */
export function toAsync(ops: FsOps): AsyncFsOps {
  return {
    exists: async (path) => ops.exists(path),
    readFile: async (path) => ops.readFile(path),
    readDir: async (path) => ops.readDir(path),
    mkdirp: async (path) => {
      ops.mkdirp(path);
    },
    writeFile: async (path, data) => {
      ops.writeFile(path, data);
    },
    rename: async (from, to) => {
      ops.rename(from, to);
    },
    appendFile: async (path, data) => {
      ops.appendFile(path, data);
    },
    fsync: async (path) => {
      ops.fsync(path);
    },
    remove: async (path) => {
      ops.remove(path);
    },
  };
}

/**
 * 把后端上的一棵目录树读进内存。
 *
 * 只递归 `.kkb` 这一棵树 —— 工作区的全部状态都在里面（§8）。
 * 目录不存在就什么都不做（全新工作区）。
 */
export async function hydrate(memory: MemoryFs, backend: AsyncFsOps, dir: string): Promise<void> {
  if (!(await backend.exists(dir))) return;
  memory.ops.mkdirp(dir);

  for (const name of await backend.readDir(dir)) {
    // Host-only metadata and backups must not enter the live card filesystem.
    if (dir.replaceAll('\\','/').endsWith('/.kkb') && ['assets','backups','writer.lock','window-prefs.json','window-prefs.tmp','mcp-bridge.json','mcp-bridge.tmp'].includes(name)) continue;
    const child = `${dir}/${name}`;
    // 判断是文件还是目录：后端没有 stat，用"能不能 readDir"来试。
    // 比让每个平台各自实现 stat 更省事，且这里只跑一次。
    const listing = await tryReadDir(backend, child);
    if (listing !== null) {
      await hydrate(memory, backend, child);
      continue;
    }
    memory.poke(child, await backend.readFile(child));
  }
}

async function tryReadDir(backend: AsyncFsOps, path: string): Promise<string[] | null> {
  try {
    return await backend.readDir(path);
  } catch {
    return null;
  }
}
