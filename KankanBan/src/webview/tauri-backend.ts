/**
 * webview 侧的平台后端 —— 把 `AsyncFsOps` 建在 Tauri 的 IPC 上。
 *
 * 每个方法对应 Rust 侧的一个命令（见 `src-tauri/src/main.rs`）。
 * 之所以 fsync 也要单独一个命令：§4.2 的 WAL 承诺是"事件落盘后才算数"，
 * 而落盘这件事只有 Rust 侧能真正 FlushFileBuffers。
 */

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

import type { CardId } from '../core/types.ts';
import type { AsyncFsOps } from '../platform/async-fs-ops.ts';

export function createTauriBackend(): AsyncFsOps {
  return {
    exists: (path) => invoke<boolean>('fs_exists', { path }),
    readFile: (path) => invoke<string>('fs_read_file', { path }),
    readDir: (path) => invoke<string[]>('fs_read_dir', { path }),
    mkdirp: (path) => invoke<void>('fs_mkdirp', { path }),
    writeFile: (path, data) => invoke<void>('fs_write_file', { path, data }),
    rename: (from, to) => invoke<void>('fs_rename', { from, to }),
    appendFile: (path, data) => invoke<void>('fs_append_file', { path, data }),
    fsync: (path) => invoke<void>('fs_fsync', { path }),
    remove: (path) => invoke<void>('fs_remove', { path }),
  };
}

/** 工作区放在应用数据目录下，由 Rust 侧决定具体位置。 */
export function workspaceRoot(): Promise<string> {
  return invoke<string>('workspace_root');
}

/** 在普通浏览器里（`vite dev` 不带 Tauri）跑时为 false —— 那时退回纯内存后端。 */
export function isTauri(): boolean {
  return typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}

// ── 窗口（多窗口，§2.8 W′） ───────────────────────────────────────────────────

/**
 * **本窗口的标签** —— 靠它判断"我是谁"（`roleOfLabel`）。
 *
 * 照 `sticky-tauri` 的 `getCurrentWebviewWindow().label`：标签就是身份。
 * 不在 Tauri 里（浏览器预览）返回 null，调用方退回单窗口预览。
 */
export function currentWindowLabel(): string | null {
  if (!isTauri()) return null;
  return getCurrentWebviewWindow().label;
}

/**
 * 让真实窗口集合与 `wanted` 对齐（多退少补）。
 *
 * 只有写者（main）该调它。返回的是**过程中的问题列表**而不是抛错：
 * 一扇窗开不出来不该让整次操作失败，用户应该看到"3 扇开了，第 4 扇失败：…"。
 */
export function syncCardWindows(wanted: readonly CardId[]): Promise<string[]> {
  return invoke<string[]>('sync_card_windows', { wanted });
}

/** 当前真实存在的卡片窗口标签（对账用：内存里以为开着的可能早被用户关掉了）。 */
export function cardWindowLabels(): Promise<string[]> {
  return invoke<string[]>('card_window_labels');
}

/** 关掉一张卡片的窗口。**只关窗口，不碰树**。 */
export function closeCardWindow(cardId: CardId): Promise<void> {
  return invoke<void>('close_card_window', { cardId });
}
