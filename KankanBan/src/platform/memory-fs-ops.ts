import {uiText} from '../i18n/text.ts';
/**
 * `FsOps` 的**内存实现**。
 *
 * 两个用途，都很实在：
 *   1. **无头测试**：整个应用（core + storage + 视图）能在 Node 里跑完，不需要真磁盘
 *   2. **开发预览**：`vite dev` 在浏览器里跑时用它当后端，不依赖 Tauri
 *
 * 它对**平台**没有任何要求（不 import node:fs、不碰 DOM），所以放 `src/platform`
 * 而不是 `src/node` —— core 的测试与 webview 的测试都能用它。
 *
 * 语义刻意与 `nodeFsOps` 对齐：`writeFile` 不原子、`rename` 覆盖目标、
 * `readDir` 只返回直接子项的名字。
 */

import type { FsOps } from '../core/storage/fs-ops.ts';

type Entry = { kind: 'file'; data: string } | { kind: 'dir' };

export type MemoryFs = {
  ops: FsOps;
  /** 直接看内容，测试里断言用 */
  snapshot(): Record<string, string>;
  /** 覆盖一个文件的内容（模拟外部改动） */
  poke(path: string, data: string): void;
};

/** 把路径拆成段，兼容 `/` 与 `\`（core 用 `/`，测试里可能混进 `\`）。 */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
}

function parentOf(path: string): string {
  const parts = segments(path);
  parts.pop();
  return parts.join('/');
}

function baseName(path: string): string {
  const parts = segments(path);
  return parts[parts.length - 1] ?? '';
}

export function createMemoryFs(): MemoryFs {
  const entries = new Map<string, Entry>();
  // 根永远存在，免得所有路径都要先 mkdirp
  entries.set('', { kind: 'dir' });

  const norm = (path: string): string => segments(path).join('/');

  const mustFile = (path: string): string => {
    const entry = entries.get(norm(path));
    if (entry === undefined) throw new Error(uiText("platform/memory-fs-ops.text001", {arg0: (path)}));
    if (entry.kind !== 'file') throw new Error(uiText("platform/memory-fs-ops.text002", {arg0: (path)}));
    return entry.data;
  };

  const ensureParent = (path: string): void => {
    const parent = norm(parentOf(path));
    const entry = entries.get(parent);
    if (entry === undefined) throw new Error(uiText("platform/memory-fs-ops.text003", {arg0: (parent)}));
    if (entry.kind !== 'dir') throw new Error(uiText("platform/memory-fs-ops.text004", {arg0: (parent)}));
  };

  const ops: FsOps = {
    exists: (path) => entries.has(norm(path)),

    readFile: (path) => mustFile(path),

    readDir: (path) => {
      const dir = norm(path);
      const entry = entries.get(dir);
      if (entry === undefined) throw new Error(uiText("platform/memory-fs-ops.text001", {arg0: (path)}));
      if (entry.kind !== 'dir') throw new Error(uiText("platform/memory-fs-ops.text004", {arg0: (path)}));

      const prefix = dir === '' ? '' : `${dir}/`;
      const names = new Set<string>();
      for (const key of entries.keys()) {
        if (!key.startsWith(prefix) || key === dir) continue;
        const rest = key.slice(prefix.length);
        const head = rest.split('/')[0];
        if (head !== undefined && head !== '') names.add(head);
      }
      return [...names].sort();
    },

    mkdirp: (path) => {
      const parts = segments(path);
      let cursor = '';
      entries.set('', { kind: 'dir' });
      for (const part of parts) {
        cursor = cursor === '' ? part : `${cursor}/${part}`;
        entries.set(cursor, { kind: 'dir' });
      }
    },

    writeFile: (path, data) => {
      ensureParent(path);
      entries.set(norm(path), { kind: 'file', data });
    },

    rename: (from, to) => {
      const source = entries.get(norm(from));
      if (source === undefined) throw new Error(uiText("platform/memory-fs-ops.text001", {arg0: (from)}));
      ensureParent(to);
      entries.set(norm(to), source);
      entries.delete(norm(from));
    },

    appendFile: (path, data) => {
      const key = norm(path);
      const existing = entries.get(key);
      if (existing === undefined) {
        ensureParent(path);
        entries.set(key, { kind: 'file', data });
        return;
      }
      if (existing.kind !== 'file') throw new Error(uiText("platform/memory-fs-ops.text002", {arg0: (path)}));
      entries.set(key, { kind: 'file', data: existing.data + data });
    },

    // 内存里没有"刷盘"这回事 —— 留成空操作，让调用方的次序逻辑照样跑到。
    fsync: () => {},

    remove: (path) => {
      const key = norm(path);
      entries.delete(key);
      const prefix = `${key}/`;
      for (const existing of [...entries.keys()]) {
        if (existing.startsWith(prefix)) entries.delete(existing);
      }
    },
  };

  return {
    ops,
    snapshot: () => {
      const out: Record<string, string> = {};
      for (const [key, entry] of entries) {
        if (entry.kind === 'file') out[key] = entry.data;
      }
      return out;
    },
    poke: (path, data) => {
      entries.set(norm(path), { kind: 'file', data });
    },
  };
}

/** 只是为了让 `baseName` 不被 tree-shaking 抱怨；也给测试用。 */
export { baseName as memoryFsBaseName };
