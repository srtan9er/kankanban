import type { Card, Command } from '@kankanban/core'

export type { Card, Command }

/**
 * 主进程 ↔ 渲染进程的契约。
 *
 * 原则：**渲染进程永远不直接改数据**，只发命令。
 * 主进程执行 → 落盘 → 广播「哪些卡变了」→ 各窗口替换即可。
 *
 * 广播的是变化后的卡片对象，不是事件流。这样渲染进程不需要把事件应用逻辑
 * 再实现一遍 —— 两份逻辑一定会漂移。事件流留给以后的同步层用。
 */

export const CHANNELS = {
  /** 渲染进程问：我是谁，工作区在哪 */
  boot: 'kkb:boot',
  /** 要一份全量树（开窗时用） */
  snapshot: 'kkb:snapshot',
  command: 'kkb:command',
  undo: 'kkb:undo',
  redo: 'kkb:redo',
  /** 主进程 → 渲染进程：哪些卡变了 */
  patch: 'kkb:patch',
  /** 弹原生右键菜单 */
  contextMenu: 'kkb:context-menu',
  /** 自己实现的窗口拖动（不能用 -webkit-app-region，见 spike/corner.ts） */
  dragStart: 'kkb:drag-start',
  dragEnd: 'kkb:drag-end',
  /** 关窗 / 最小化 / 切换置顶 */
  windowAction: 'kkb:window-action',
} as const

export type Target = { kind: 'main' } | { kind: 'card'; cardId: string }

export interface BootInfo {
  target: Target
  workspaceRoot: string
  workspaceName: string
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export interface Snapshot {
  cards: Card[]
  lastSeq: number
}

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

/** 广播单元：变化的卡片 + 被彻底删掉的 id + 撤销栈状态。 */
export interface Patch {
  cards: Card[]
  removed: string[]
  lastSeq: number
  /** 撤销栈跟着每次变更走，省掉一次额外的 IPC 往返。 */
  history: HistoryState
}

export interface KkbErrorPayload {
  code: string
  message: string
}

export interface CommandReply {
  ok: boolean
  created?: string
  changed?: string[]
  warnings?: string[]
  error?: KkbErrorPayload
}

export interface ContextMenuRequest {
  cardId: string | null
  /** 在哪弹：卡片本身 / 某个容器的空白处 */
  containerId?: string | null
}

export type WindowAction = 'close' | 'minimize' | 'toggle-always-on-top'

/** preload 通过 contextBridge 暴露给渲染进程的 API。 */
export interface KkbApi {
  boot(): Promise<BootInfo>
  snapshot(): Promise<Snapshot>
  command(command: Command): Promise<CommandReply>
  undo(): Promise<CommandReply>
  redo(): Promise<CommandReply>
  contextMenu(request: ContextMenuRequest): Promise<void>
  dragStart(): void
  dragEnd(): void
  windowAction(action: WindowAction): Promise<void>
  onPatch(listener: (patch: Patch) => void): () => void
}

declare global {
  interface Window {
    kkb: KkbApi
  }
}
