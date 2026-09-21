import { BrowserWindow, Menu, Tray } from 'electron'
import { trayIcon } from './tray-icon.ts'
import type { WorkspaceService } from './service.ts'

/**
 * 原生右键菜单和托盘。
 *
 * 用 Electron 的原生菜单而不是自己在页面里画一个：
 * 省掉一堆层叠、外点关闭、键盘导航的细节，而且长得像这个系统里的东西。
 */

export interface MenuHost {
  service: WorkspaceService
  openCard: (cardId: string) => void
  quit: () => void
}

export function showCardMenu(
  host: MenuHost,
  window: BrowserWindow,
  request: { cardId: string | null; containerId?: string | null },
): void {
  const { service } = host
  const items: Electron.MenuItemConstructorOptions[] = []

  const cardId = request.cardId
  const target = cardId === null ? null : service.cardView(cardId)

  if (target !== null) {
    const floating = service.isFloating(target.id)

    items.push({
      label: `「${target.title}」`,
      enabled: false,
    })
    items.push({ type: 'separator' })

    items.push({
      label: '新建子卡',
      click: () => void service.run({ type: 'card_create', parent: target.id, title: '新卡片' }),
    })

    if (floating) {
      const column = service.firstBoardColumn()
      items.push({
        label: '收回进容器（看板 · 待办）',
        enabled: column !== null,
        click: () => {
          if (column !== null) void service.run({ type: 'card_move', id: target.id, parent: column })
        },
      })
    } else {
      items.push({
        label: '浮动到桌面',
        click: () => void service.run({ type: 'card_move', id: target.id, parent: null }),
      })
      items.push({
        label: '在独立窗口里打开',
        click: () => host.openCard(target.id),
      })
    }

    items.push({ type: 'separator' })
    items.push({
      label: '删除（软删除，可恢复）',
      click: () => void service.run({ type: 'card_trash', id: target.id }),
    })
  } else {
    const container = request.containerId ?? null
    items.push({
      label: '新建卡片',
      enabled: container !== null,
      click: () => {
        if (container !== null) void service.run({ type: 'card_create', parent: container, title: '新卡片' })
      },
    })
  }

  items.push({ type: 'separator' })
  items.push({
    label: service.boot(window.webContents.id).undoLabel ?? '撤销',
    enabled: service.boot(window.webContents.id).canUndo,
    click: () => void service.undo(),
  })
  items.push({
    label: service.boot(window.webContents.id).redoLabel ?? '重做',
    enabled: service.boot(window.webContents.id).canRedo,
    click: () => void service.redo(),
  })

  Menu.buildFromTemplate(items).popup({ window })
}

let tray: Tray | null = null

export function createTray(host: MenuHost & { openMain: () => void }): Tray {
  if (tray !== null) return tray

  tray = new Tray(trayIcon())
  tray.setToolTip(`KankanBan · ${host.service.name}`)

  const refresh = (): void => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: `工作区：${host.service.root}`, enabled: false },
        { type: 'separator' },
        { label: '打开 main 板', click: () => host.openMain() },
        { type: 'separator' },
        { label: '注销工作区并退出', click: () => host.quit() },
      ]),
    )
  }

  refresh()

  // 左键开 main 板，右键出菜单
  tray.on('click', () => host.openMain())

  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
