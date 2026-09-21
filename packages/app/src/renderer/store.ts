import { create } from 'zustand'
import type { Card } from '@kankanban/core'
import type { Command, HistoryState, Patch, Target } from '../shared/ipc.ts'

/**
 * 渲染进程的状态：一份卡片的本地副本。
 *
 * 两点约定：
 *
 * 1. 这里**没有**任何事件应用逻辑。主进程广播的是变化后的卡片对象，
 *    直接替换就行 —— 事件流的语义只存在于 core 一个地方，不会漂移。
 *
 * 2. 组件里选状态时只选 `cards` 这个引用稳定的 map，派生数据用 selectors.ts
 *    里的纯函数算。**不要在 selector 里返回新数组**，zustand 用 Object.is 比较，
 *    每次返回新引用会导致无限重渲染。
 */

export interface AppState {
  ready: boolean
  error: string | null
  target: Target | null
  workspaceRoot: string
  workspaceName: string
  cards: Record<string, Card>
  /** 这个窗口当前聚焦在哪张卡上。每个窗口各一份，不同步。 */
  focusId: string | null
  history: HistoryState

  init(): Promise<void>
  applyPatch(patch: Patch): void
  focus(cardId: string | null): void
  run(command: Command): Promise<boolean>
  undo(): Promise<void>
  redo(): Promise<void>
  notify(message: string): void
  notice: string | null
}

const EMPTY_HISTORY: HistoryState = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  error: null,
  target: null,
  workspaceRoot: '',
  workspaceName: '',
  cards: {},
  focusId: null,
  history: EMPTY_HISTORY,
  notice: null,

  async init(): Promise<void> {
    try {
      const [boot, snapshot] = await Promise.all([window.kkb.boot(), window.kkb.snapshot()])
      const cards: Record<string, Card> = {}
      for (const card of snapshot.cards) cards[card.id] = card

      const target = boot.target
      set({
        ready: true,
        target,
        workspaceRoot: boot.workspaceRoot,
        workspaceName: boot.workspaceName,
        cards,
        focusId: target.kind === 'card' ? target.cardId : null,
        history: {
          canUndo: boot.canUndo,
          canRedo: boot.canRedo,
          undoLabel: boot.undoLabel,
          redoLabel: boot.redoLabel,
        },
      })

      window.kkb.onPatch((patch) => get().applyPatch(patch))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  applyPatch(patch: Patch): void {
    set((state) => {
      const cards = { ...state.cards }
      for (const card of patch.cards) cards[card.id] = card
      for (const id of patch.removed) delete cards[id]
      return { cards, history: patch.history }
    })
  },

  focus(cardId: string | null): void {
    set({ focusId: cardId })
  },

  async run(command: Command): Promise<boolean> {
    const reply = await window.kkb.command(command)
    if (reply.ok) {
      for (const warning of reply.warnings ?? []) get().notify(warning)
      return true
    }
    if (reply.error !== undefined) get().notify(reply.error.message)
    return false
  },

  async undo(): Promise<void> {
    await window.kkb.undo()
  },

  async redo(): Promise<void> {
    await window.kkb.redo()
  },

  notify(message: string): void {
    set({ notice: message })
    setTimeout(() => {
      if (get().notice === message) set({ notice: null })
    }, 4200)
  },
}))
