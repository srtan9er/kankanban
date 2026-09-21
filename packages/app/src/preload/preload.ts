import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from '../shared/ipc.ts'
import type { CommandReply, Command, ContextMenuRequest, KkbApi, Patch, WindowAction } from '../shared/ipc.ts'

/**
 * 渲染进程能碰到的东西全在这里，多一个都没有。
 *
 * contextIsolation + sandbox 都开着，所以渲染进程没有 Node，只能走这几个口子。
 * 每个口子的另一端都是主进程的命令层 —— 没有「渲染进程直接写文件」这条路。
 */

const api: KkbApi = {
  boot: () => ipcRenderer.invoke(CHANNELS.boot),
  snapshot: () => ipcRenderer.invoke(CHANNELS.snapshot),
  command: (command: Command) => ipcRenderer.invoke(CHANNELS.command, command) as Promise<CommandReply>,
  undo: () => ipcRenderer.invoke(CHANNELS.undo) as Promise<CommandReply>,
  redo: () => ipcRenderer.invoke(CHANNELS.redo) as Promise<CommandReply>,
  contextMenu: (request: ContextMenuRequest) => ipcRenderer.invoke(CHANNELS.contextMenu, request) as Promise<void>,
  dragStart: () => ipcRenderer.send(CHANNELS.dragStart),
  dragEnd: () => ipcRenderer.send(CHANNELS.dragEnd),
  windowAction: (action: WindowAction) => ipcRenderer.invoke(CHANNELS.windowAction, action) as Promise<void>,

  onPatch: (listener: (patch: Patch) => void) => {
    const handler = (_event: unknown, patch: Patch): void => listener(patch)
    ipcRenderer.on(CHANNELS.patch, handler)
    return () => {
      ipcRenderer.off(CHANNELS.patch, handler)
    }
  },
}

contextBridge.exposeInMainWorld('kkb', api)
