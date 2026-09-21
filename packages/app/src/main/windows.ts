import { BrowserWindow, screen, shell } from 'electron'
import type { WindowOp, WindowState } from '@kankanban/core'

/**
 * 窗口管理：一张浮卡一个系统窗口。
 *
 * 两个从这里长出来的决定：
 *
 * 1. **不用 `-webkit-app-region: drag`，自己实现拖动。**
 *    只要卡片 DOM 里出现那个属性，CSS 圆角裁剪就整体失效
 *    （见 spike/corner.ts 的四组对照实验）。卡片好不好看是这个项目的硬需求，
 *    所以宁可自己为主进程写一个轮询拖动。
 *
 * 2. **广播是「变化的卡片对象」，不是事件流。**
 *    渲染进程直接替换即可，不需要把事件应用逻辑再实现一遍。
 */

const DEFAULTS = { width: 340, height: 260, minWidth: 220, minHeight: 140 }

export interface WindowManagerOptions {
  indexHtml: string
  preload: string
}

export class WindowManager {
  private readonly options: WindowManagerOptions
  private readonly cards = new Map<string, BrowserWindow>()
  private main: BrowserWindow | null = null

  /** 卡片窗口位置变了要落盘 —— 由 WorkspaceService 接上。 */
  onBoundsChanged: ((cardId: string, state: WindowState) => void) | null = null

  private dragWindow: BrowserWindow | null = null
  private dragOffset = { x: 0, y: 0 }
  private dragTimer: NodeJS.Timeout | null = null
  private readonly persistTimers = new Map<number, NodeJS.Timeout>()

  constructor(options: WindowManagerOptions) {
    this.options = options
  }

  /** 卡片正文里的链接走系统浏览器，不在应用里开新窗口。 */
  private static allowExternalLinks(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
  }

  /**
   * 把渲染进程的 console 转出来。
   *
   * 浮卡是无边框透明窗口，没有标题栏也没有开发者工具入口 ——
   * 里面报的错如果不转发出来，就是彻底静默的。
   */
  private static forwardConsole(window: BrowserWindow, label: string): void {
    window.webContents.on('console-message', (...args: unknown[]) => {
      // Electron 44 传的是一个带 level/message 的事件对象；老版本是位置参数
      const first = args[0] as { level?: string; message?: string } | undefined
      const level = typeof first?.level === 'string' ? first.level : String(args[1] ?? 'log')
      const message = typeof first?.message === 'string' ? first.message : String(args[2] ?? '')
      process.stdout.write(`[renderer:${label}] ${level}: ${message}\n`)
    })

    window.webContents.on('render-process-gone', (_event, details) => {
      process.stdout.write(`[renderer:${label}] 进程没了：${details.reason}\n`)
    })
  }

  // -------------------------------------------------------------------------
  // main 板
  // -------------------------------------------------------------------------

  openMain(): BrowserWindow {
    if (this.main !== null && !this.main.isDestroyed()) {
      this.main.show()
      this.main.focus()
      return this.main
    }

    const window = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 720,
      minHeight: 480,
      title: 'KankanBan',
      backgroundColor: '#1b1d21',
      show: false,
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        sandbox: true,
      },
    })

    void window.loadFile(this.options.indexHtml, { hash: '/main' })
    WindowManager.allowExternalLinks(window)
    WindowManager.forwardConsole(window, 'main')
    window.once('ready-to-show', () => window.show())

    // 「可关闭但不结束应用」：关掉只是隐藏，托盘还在
    window.on('close', (event) => {
      event.preventDefault()
      window.hide()
    })

    this.main = window
    return window
  }

  // -------------------------------------------------------------------------
  // 浮卡窗口
  // -------------------------------------------------------------------------

  openCard(cardId: string, state?: WindowState): BrowserWindow {
    const existing = this.cards.get(cardId)
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return existing
    }

    const bounds = state ?? {
      x: 140 + this.cards.size * 28,
      y: 140 + this.cards.size * 28,
      width: DEFAULTS.width,
      height: DEFAULTS.height,
      alwaysOnTop: false,
      minimized: false,
    }

    const window = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: DEFAULTS.minWidth,
      minHeight: DEFAULTS.minHeight,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      // 阴影由卡片的 CSS 自己画，窗口不要插一脚
      hasShadow: false,
      // 圆角也是 CSS 画的；交给系统画会把我们留出来给阴影的边距一起裁掉
      roundedCorners: false,
      skipTaskbar: true,
      resizable: true,
      show: false,
      alwaysOnTop: bounds.alwaysOnTop,
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        sandbox: true,
      },
    })

    void window.loadFile(this.options.indexHtml, { hash: `/card/${cardId}` })
    WindowManager.allowExternalLinks(window)
    WindowManager.forwardConsole(window, cardId)
    window.once('ready-to-show', () => {
      window.show()
      if (bounds.minimized) window.minimize()
    })

    /*
     * 「关闭浮卡窗口只是隐藏，不是删卡。」
     *
     * 美术同学点错那个叉子不该丢东西。卡还在树里，
     * main 板的窗口列表能把窗口重新叫出来。
     */
    window.on('close', (event) => {
      if (!window.isDestroyed()) {
        event.preventDefault()
        window.hide()
      }
    })

    const schedule = (): void => this.schedulePersist(cardId, window)
    window.on('moved', schedule)
    window.on('resized', schedule)

    this.cards.set(cardId, window)
    return window
  }

  closeCard(cardId: string): void {
    const window = this.cards.get(cardId)
    if (window === undefined) return
    this.cards.delete(cardId)
    this.flushPersist(cardId, window)
    // 这里是真要销毁：卡被收进容器了，窗口不该再留着
    window.removeAllListeners('close')
    window.destroy()
  }

  /** 被隐藏（不是销毁）的浮卡窗口。 */
  hiddenCards(): string[] {
    return [...this.cards.entries()].filter(([, w]) => !w.isDestroyed() && !w.isVisible()).map(([id]) => id)
  }

  openCards(): string[] {
    return [...this.cards.keys()].filter((id) => {
      const w = this.cards.get(id)
      return w !== undefined && !w.isDestroyed()
    })
  }

  applyWindowOps(ops: readonly WindowOp[], stateOf: (cardId: string) => WindowState | undefined): void {
    for (const op of ops) {
      if (op.op === 'open') this.openCard(op.cardId, stateOf(op.cardId))
      else this.closeCard(op.cardId)
    }
  }

  /** 卡片的窗口状态，用于落盘。窗口不存在时返回 undefined。 */
  stateOf(cardId: string): WindowState | undefined {
    const window = this.cards.get(cardId)
    if (window === undefined || window.isDestroyed()) return undefined
    const bounds = window.getBounds()
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      alwaysOnTop: window.isAlwaysOnTop(),
      minimized: window.isMinimized(),
    }
  }

  // -------------------------------------------------------------------------
  // 自己实现的窗口拖动
  // -------------------------------------------------------------------------

  startDrag(window: BrowserWindow): void {
    this.endDrag()
    const cursor = screen.getCursorScreenPoint()
    const bounds = window.getBounds()
    this.dragWindow = window
    // 记下抓取点相对窗口左上角的偏移，拖动时保持不变
    this.dragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }

    /*
     * 为什么在主进程轮询光标，而不是听渲染进程的 pointermove：
     *   - 坐标来源统一。事件里的 screenX 是 CSS 像素，多屏不同缩放比时
     *     和 setPosition 要的 DIP 对不上，得自己换算，容易错。
     *   - getCursorScreenPoint() 和 getBounds() 都是同一套坐标系，不用换算。
     * 15ms ≈ 66Hz，比显示刷新率略高一点，够跟手。
     */
    this.dragTimer = setInterval(() => {
      const target = this.dragWindow
      if (target === null || target.isDestroyed()) {
        this.endDrag()
        return
      }
      const point = screen.getCursorScreenPoint()
      target.setPosition(point.x - this.dragOffset.x, point.y - this.dragOffset.y)
    }, 15)
  }

  endDrag(): void {
    if (this.dragTimer !== null) {
      clearInterval(this.dragTimer)
      this.dragTimer = null
    }
    const window = this.dragWindow
    this.dragWindow = null
    if (window !== null && !window.isDestroyed()) {
      const cardId = [...this.cards.entries()].find(([, w]) => w === window)?.[0]
      if (cardId !== undefined) this.flushPersist(cardId, window)
    }
  }

  // -------------------------------------------------------------------------
  // 广播
  // -------------------------------------------------------------------------

  /** 给所有窗口发消息（含 main 板）。 */
  broadcast(channel: string, payload: unknown): void {
    for (const window of this.allWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }

  allWindows(): BrowserWindow[] {
    const out: BrowserWindow[] = []
    if (this.main !== null && !this.main.isDestroyed()) out.push(this.main)
    for (const window of this.cards.values()) {
      if (!window.isDestroyed()) out.push(window)
    }
    return out
  }

  /** 带标签的窗口列表，给开发期自查抓图用。 */
  labeledWindows(): Array<{ label: string; window: BrowserWindow }> {
    const out: Array<{ label: string; window: BrowserWindow }> = []
    if (this.main !== null && !this.main.isDestroyed()) out.push({ label: 'main', window: this.main })
    for (const [cardId, window] of this.cards) {
      if (!window.isDestroyed()) out.push({ label: `card-${cardId}`, window })
    }
    return out
  }

  /** webContents 对应哪张卡。main 板返回 null。 */
  cardIdOf(webContentsId: number): string | null {
    for (const [cardId, window] of this.cards) {
      if (!window.isDestroyed() && window.webContents.id === webContentsId) return cardId
    }
    return null
  }

  windowOf(webContentsId: number): BrowserWindow | null {
    return this.allWindows().find((w) => w.webContents.id === webContentsId) ?? null
  }

  quit(): void {
    this.endDrag()
    for (const window of this.cards.values()) {
      if (!window.isDestroyed()) {
        window.removeAllListeners('close')
        window.destroy()
      }
    }
    if (this.main !== null && !this.main.isDestroyed()) {
      this.main.removeAllListeners('close')
      this.main.destroy()
    }
    this.cards.clear()
  }

  // -------------------------------------------------------------------------
  // 位置落盘（去抖）
  // -------------------------------------------------------------------------

  private schedulePersist(cardId: string, window: BrowserWindow): void {
    const existing = this.persistTimers.get(window.id)
    if (existing !== undefined) clearTimeout(existing)
    this.persistTimers.set(
      window.id,
      setTimeout(() => {
        this.persistTimers.delete(window.id)
        if (!window.isDestroyed()) this.emitBounds(cardId, window)
      }, 400),
    )
  }

  private flushPersist(cardId: string, window: BrowserWindow): void {
    const existing = this.persistTimers.get(window.id)
    if (existing !== undefined) {
      clearTimeout(existing)
      this.persistTimers.delete(window.id)
    }
    if (!window.isDestroyed()) this.emitBounds(cardId, window)
  }

  private emitBounds(cardId: string, window: BrowserWindow): void {
    const bounds = window.getBounds()
    this.onBoundsChanged?.(cardId, {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      alwaysOnTop: window.isAlwaysOnTop(),
      minimized: window.isMinimized(),
    })
  }
}
