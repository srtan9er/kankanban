/**
 * `FsOps` 的 **Node 实现**。刻意放在 `src/core` **之外**：
 * core 必须平台无关（见 `src/core/storage/fs-ops.ts` 的说明与
 * `test/platform-neutral.test.ts`），而 `node:fs` 只有 Node 有。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import type { FsOps } from '../core/storage/fs-ops.ts';

export const nodeFsOps: FsOps = {
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  readDir: (path) => readdirSync(path),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  writeFile: (path, data) => {
    writeFileSync(path, data, 'utf8');
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  appendFile: (path, data) => {
    appendFileSync(path, data, 'utf8');
  },
  fsync: (path) => {
    // 用 'a' 打开：可写句柄才能保证 FlushFileBuffers 在 Windows 上生效。
    const fd = openSync(path, 'a');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  remove: (path) => {
    rmSync(path, { force: true });
  },
};
