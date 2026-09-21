import { app, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { toKkbError } from '@kankanban/core'
import { CHANNELS } from '../shared/ipc.ts'
import type { Command, ContextMenuRequest, WindowAction } from '../shared/ipc.ts'
import { createTray, destroyTray, showCardMenu } from './menu.ts'
import { scheduleCapture } from './debug-capture.ts'
import { runVerification } from './debug-verify.ts'
import { WorkspaceService } from './service.ts'
import { WindowManager } from './windows.ts'

/**
 * 主进程入口。
 *
 * 进程里的分工：
 *   main.ts      生命周期和接线
 *   windows.ts   窗口管理 + 自己实现的拖动
 *   service.ts   唯一写者：命令、落盘、广播
 *   menu.ts      原生右键菜单和托盘
 */

function resolveWorkspaceDir(): string {
  const argv = process.argv.slice(1)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--workspace' || arg === '-w') {
      const next = argv[i + 1]
      if (next !== undefined) return path.resolve(next)
    }
    if (arg?.startsWith('--workspace=')) {
      return path.resolve(arg.slice('--workspace='.length))
    }
  }
  return path.resolve(process.env['KKB_WORKSPACE'] ?? process.cwd())
}

// 单实例：两个实例同时写一个工作区会互相覆盖
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const rendererDir = path.join(import.meta.dirname, 'renderer')

app.whenReady().then(async () => {
  const windows = new WindowManager({
    indexHtml: path.join(rendererDir, 'index.html'),
    preload: path.join(import.meta.dirname, 'preload.cjs'),
  })

  const dir = resolveWorkspaceDir()
  let service: WorkspaceService

  try {
    service = await WorkspaceService.open(dir, windows)
  } catch (error) {
    const kkb = toKkbError(error)
    dialog.showErrorBox('KankanBan 打不开这个工作区', `${kkb.message}\n\n${dir}`)
    app.exit(1)
    return
  }

  const host = {
    service,
    openCard: (cardId: string) => windows.openCard(cardId, service.cardState(cardId)),
    openMain: () => windows.openMain(),
    quit: () => {
      void shutdown()
    },
  }

  // ---------------------------------------------------------------- IPC
  ipcMain.handle(CHANNELS.boot, (event) => service.boot(event.sender.id))
  ipcMain.handle(CHANNELS.snapshot, () => service.snapshot())
  ipcMain.handle(CHANNELS.command, (_event, command: Command) => service.run(command))
  ipcMain.handle(CHANNELS.undo, () => service.undo())
  ipcMain.handle(CHANNELS.redo, () => service.redo())

  ipcMain.handle(CHANNELS.contextMenu, (event, request: ContextMenuRequest) => {
    const window = windows.windowOf(event.sender.id)
    if (window !== null) showCardMenu(host, window, request)
  })

  ipcMain.handle(CHANNELS.windowAction, (event, action: WindowAction) => {
    const window = windows.windowOf(event.sender.id)
    if (window === null) return
    if (action === 'close') window.hide()
    else if (action === 'minimize') window.minimize()
    else if (action === 'toggle-always-on-top') window.setAlwaysOnTop(!window.isAlwaysOnTop())
  })

  ipcMain.on(CHANNELS.dragStart, (event) => {
    const window = windows.windowOf(event.sender.id)
    if (window !== null) windows.startDrag(window)
  })
  ipcMain.on(CHANNELS.dragEnd, () => windows.endDrag())

  // ---------------------------------------------------------------- 开场
  windows.openMain()
  createTray(host)

  // 开发期自查：KKB_CAPTURE_AFTER=<毫秒> 时抓一轮窗口内容（含字符画）
  scheduleCapture(
    () => windows.labeledWindows(),
    process.env['KKB_CAPTURE_OUT'] ?? path.join(process.cwd(), '.tmp-app-shot'),
    () => void shutdown(),
  )

  // 开发期自查：KKB_VERIFY=1 时把阶段二的验收标准逐条跑一遍
  if (process.env['KKB_VERIFY'] === '1') {
    void runVerification(service, windows, () => void shutdown())
  }

  let closing = false
  async function shutdown(): Promise<void> {
    if (closing) return
    closing = true
    destroyTray()
    await service.close().catch(() => undefined)
    windows.quit()
    app.exit(0)
  }

  app.on('second-instance', () => windows.openMain())
  app.on('before-quit', () => {
    void shutdown()
  })
  // 托盘应用：窗口全关了也不退出
  app.on('window-all-closed', () => undefined)

  process.stdout.write(`[kankanban-app] 工作区 ${service.root}\n`)
})

app.on('activate', () => {
  // macOS 上点 dock 图标
})
