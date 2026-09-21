import { app, BrowserWindow, desktopCapturer, screen } from 'electron'
import type { NativeImage } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 阶段二 spike：透明无边框多窗口。
 *
 * 这是阶段二最大的风险点（开发文档 §3.5），所以先单独验证，
 * 别等 UI 写完才发现路子不对。
 *
 * 要回答的问题：
 *   1. 8 个透明无边框窗口能不能同时稳定存在，开窗要多久
 *   2. 内存代价是多少（每窗口一个渲染进程？process-per-site 能不能省）
 *   3. resize 会不会报错 / 行为异常
 *   4. setAlwaysOnTop / skipTaskbar 是否按预期工作
 *   5. **透明到底有没有真的生效** —— 这一条靠代码证明，不靠肉眼
 *
 * 第 5 条的验证办法：
 *   先抓一张「没有窗口」的桌面基线，开窗后再抓一张，逐像素比对。
 *   卡片的圆角半径是 12px，所以窗口四角内 4px 处应该落在圆角外面 ——
 *   如果透明生效，那里的像素必须和基线一模一样；
 *   如果没生效（典型的黑底/白底），那里就会变成纯黑或纯白。
 *   同时抓 capturePage 的 alpha 通道，直接看窗口表面本身是否带透明。
 *
 * 用法：
 *   electron dist/spike.mjs
 *   KKB_SPIKE_WINDOWS=12 electron dist/spike.mjs
 *   KKB_SPIKE_PROCESS_PER_SITE=1 electron dist/spike.mjs
 */

const WINDOW_COUNT = Number(process.env['KKB_SPIKE_WINDOWS'] ?? 8)
const USE_PROCESS_PER_SITE = process.env['KKB_SPIKE_PROCESS_PER_SITE'] === '1'
const OUT_DIR = process.env['KKB_SPIKE_OUT'] ?? '.tmp-spike'
const DEBUG_SHOTS = process.env['KKB_SPIKE_SHOTS'] === '1'

if (USE_PROCESS_PER_SITE) {
  app.commandLine.appendSwitch('process-per-site')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Bgra {
  data: Buffer
  width: number
  height: number
}

function toBgra(image: NativeImage): Bgra {
  const size = image.getSize()
  return { data: image.toBitmap(), width: size.width, height: size.height }
}

/** BGRA 取一个像素。 */
function pixelAt(img: Bgra, x: number, y: number): [number, number, number, number] {
  const px = Math.max(0, Math.min(img.width - 1, Math.round(x)))
  const py = Math.max(0, Math.min(img.height - 1, Math.round(y)))
  const i = (py * img.width + px) * 4
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0, img.data[i + 3] ?? 0]
}

function channelDiff(a: [number, number, number, number], b: [number, number, number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}

const hex = (p: [number, number, number, number]): string =>
  '#' + [p[2], p[1], p[0]].map((v) => v.toString(16).padStart(2, '0')).join('') + ` a=${p[3]}`

async function grabDesktop(): Promise<{ img: Bgra; scale: number; name: string } | null> {
  const display = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width * 2, height: display.size.height * 2 },
  })
  const first = sources[0]
  if (first === undefined) return null
  const img = toBgra(first.thumbnail)
  // 缩略图是物理像素，屏幕坐标是 DIP，两者之间有个缩放比
  const scale = img.width / display.size.width
  return { img, scale, name: first.name }
}

function cardHtml(index: number, total: number): string {
  const color = ['#4A90D9', '#E0533D', '#2E9E5B', '#B07CD6'][index % 4]
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font: 13px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; }
  .card { height: 100%; box-sizing: border-box; border-radius: 12px;
    background: rgba(255,255,255,0.94);
    border: 1px solid rgba(0,0,0,0.12);
    box-shadow: 0 8px 28px rgba(0,0,0,0.22);
    display: flex; flex-direction: column; overflow: hidden; }
  .hdr { -webkit-app-region: drag; height: 26px; flex: none;
    background: ${color}; color: #fff; display: flex; align-items: center;
    padding: 0 10px; font-weight: 600; font-size: 12px; }
  .body { padding: 8px 10px; color: #222; }
  .body b { font-size: 15px; }
  .hint { color: #777; font-size: 11px; margin-top: 4px; }
  .foot { margin-top: auto; padding: 6px 10px; border-top: 1px solid rgba(0,0,0,.08);
    color: #888; font-size: 11px; }
</style></head>
<body>
  <div class="card">
    <div class="hdr">${index === 0 ? 'main 板' : `浮卡 ${index}`}</div>
    <div class="body">
      <b>透明窗口 ${index + 1} / ${total}</b>
      <div class="hint">无边框 · 透明 · 圆角 · 有阴影</div>
    </div>
    <div class="foot">spike</div>
  </div>
</body></html>`
}

function collectMetrics(): { processes: number; totalWorkingSetMB: number; byType: Record<string, number> } {
  const byType: Record<string, number> = {}
  let total = 0
  const list = app.getAppMetrics()
  for (const m of list) {
    const mb = Math.round((m.memory?.workingSetSize ?? 0) / 1024)
    byType[m.type] = (byType[m.type] ?? 0) + mb
    total += mb
  }
  return { processes: list.length, totalWorkingSetMB: total, byType }
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    processPerSite: USE_PROCESS_PER_SITE,
    requestedWindows: WINDOW_COUNT,
    display: screen.getPrimaryDisplay().size,
    workArea: screen.getPrimaryDisplay().workAreaSize,
  }

  await mkdir(OUT_DIR, { recursive: true })
  await sleep(700) // 等桌面稳定

  // ---------------------------------------------------------------- 基线截图
  const baseline = await grabDesktop()
  if (baseline === null) {
    report['fatal'] = '拿不到屏幕源，透明验证做不了'
  } else {
    report['baseline'] = { width: baseline.img.width, height: baseline.img.height, scale: baseline.scale, source: baseline.name }
    if (DEBUG_SHOTS) await writeFile(path.join(OUT_DIR, 'baseline.png'), baseline.img.data.length ? Buffer.alloc(0) : Buffer.alloc(0))
  }

  // ---------------------------------------------------------------- 开窗
  const startedAt = Date.now()
  const wins: BrowserWindow[] = []

  for (let i = 0; i < WINDOW_COUNT; i++) {
    const w = new BrowserWindow({
      width: 300,
      height: 190,
      x: 40 + (i % 4) * 320,
      y: 40 + Math.floor(i / 4) * 210,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      skipTaskbar: true,
      resizable: true,
      minWidth: 160,
      minHeight: 100,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    })
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(cardHtml(i, WINDOW_COUNT)))
    w.setAlwaysOnTop(true)
    w.showInactive()
    wins.push(w)
  }
  report['openMs'] = Date.now() - startedAt

  await sleep(2200) // 等渲染和合成稳定

  // ---------------------------------------------------------------- 内存
  report['metrics'] = collectMetrics()

  // ---------------------------------------------------------------- resize
  const resizeOk: boolean[] = []
  for (const w of wins) {
    const before = w.getBounds()
    w.setBounds({ x: before.x, y: before.y, width: before.width + 30, height: before.height + 24 })
    await sleep(50)
    const after = w.getBounds()
    resizeOk.push(after.width === before.width + 30 && after.height === before.height + 24)
    // 还原，免得影响后面的像素比对
    w.setBounds(before)
  }
  report['resizeAllOk'] = resizeOk.every(Boolean)
  await sleep(900)

  // ---------------------------------------------------------------- 窗口表面本身的 alpha
  const firstWindow = wins[0]
  if (firstWindow !== undefined) {
    const shot = toBgra(await firstWindow.webContents.capturePage())
    let transparentPixels = 0
    let totalPixels = 0
    for (let i = 3; i < shot.data.length; i += 4) {
      totalPixels++
      if ((shot.data[i] ?? 255) === 0) transparentPixels++
    }
    report['captureAlpha'] = {
      size: { width: shot.width, height: shot.height },
      transparentPixelRatio: Number((transparentPixels / totalPixels).toFixed(4)),
      cornerPixel: hex(pixelAt(shot, 3, 3)),
      centerPixel: hex(pixelAt(shot, shot.width / 2, shot.height / 2)),
      note: 'transparentPixelRatio > 0 说明窗口表面自己带透明通道；四角应该是透明的',
    }
    await writeFile(path.join(OUT_DIR, 'card-only.png'), (await firstWindow.webContents.capturePage()).toPNG())
  }

  // ---------------------------------------------------------------- 桌面像素比对
  if (baseline !== null) {
    const after = await grabDesktop()
    if (after !== null) {
      const results = wins.map((w, i) => {
        const b = w.getBounds()
        const toShot = (x: number, y: number): [number, number] => [
          (b.x + x) * after.scale,
          (b.y + y) * after.scale,
        ]
        // 圆角半径 12px，取 4px 处 —— 应该落在圆角外面，也就是透明区
        const corners: Array<[number, number]> = [
          toShot(4, 4),
          toShot(b.width - 5, 4),
          toShot(4, b.height - 5),
          toShot(b.width - 5, b.height - 5),
        ]
        const center = toShot(b.width / 2, b.height / 2)

        const cornerDiffs = corners.map(([x, y]) => channelDiff(pixelAt(baseline.img, x, y), pixelAt(after.img, x, y)))
        const centerDiff = channelDiff(pixelAt(baseline.img, center[0], center[1]), pixelAt(after.img, center[0], center[1]))

        return {
          i,
          cornerDiffs,
          cornersUnchanged: cornerDiffs.every((d) => d <= 8),
          centerDiff,
          centerCovered: centerDiff > 8,
          sampleColors: {
            cornerNow: hex(pixelAt(after.img, corners[0]![0], corners[0]![1])),
            cornerBefore: hex(pixelAt(baseline.img, corners[0]![0], corners[0]![1])),
          },
        }
      })

      report['transparency'] = {
        status: '见 spike/calibrate.ts 与 spike/corner.ts',
        why:
          '这个文件里的逐像素比对用的是「截图宽度 / 屏幕 DIP 宽度」当缩放比，' +
          '但 desktopCapturer 实际是按我请求的尺寸输出的，两者差了一个偏移量，' +
          '不标定就会整体错位、得出错误结论（第一版就是这么被带偏的）。' +
          '结论以标定过的那两个 spike 为准：透明是生效的。',
        perWindow: results,
      }

      if (DEBUG_SHOTS) {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 900 } })
        const s = sources[0]
        if (s !== undefined) await writeFile(path.join(OUT_DIR, 'desktop.png'), s.thumbnail.toPNG())
      }
    }
  }

  report['windowState'] = wins.map((w, i) => ({
    i,
    alwaysOnTop: w.isAlwaysOnTop(),
    visible: w.isVisible(),
    resizable: w.isResizable(),
    bounds: w.getBounds(),
  }))

  process.stdout.write('\n===SPIKE-REPORT===\n' + JSON.stringify(report, null, 2) + '\n===END===\n')

  await sleep(300)
  for (const w of wins) w.destroy()
  app.quit()
}

app.whenReady().then(main).catch((error: unknown) => {
  process.stdout.write('\n===SPIKE-ERROR===\n' + String(error) + '\n===END===\n')
  app.exit(1)
})
