import { app, BrowserWindow, desktopCapturer, screen } from 'electron'
import type { NativeImage } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 标定测试：把「桌面截图的坐标 ↔ 窗口坐标」这个映射关系量出来，
 * 顺便用最朴素的方式证明透明到底有没有生效。
 *
 * 做法：
 *   窗口放在固定的 (100, 100)，尺寸 300x190，背景全透明，
 *   只在两个已知位置画两个小色块（红、绿），其余什么都不画。
 *
 *   然后比开窗前后的桌面截图：
 *     - 变化了的像素应该**只有那两个色块**。如果整块窗口矩形都变了，
 *       说明窗口画了一层不透明底色 —— 透明没生效。
 *     - 从两个色块在截图里的实际位置，反解出缩放比和偏移量，
 *       这样后面所有坐标换算就都是量出来的，不是猜的。
 */

const OUT_DIR = process.env['KKB_SPIKE_OUT'] ?? '.tmp-spike'

const WIN_X = 100
const WIN_Y = 100
const WIN_W = 300
const WIN_H = 190

// 色块：内容坐标（相对窗口左上角），中心点
const MARKERS = [
  { name: 'red', css: '#ff0000', x: 20, y: 20, size: 16 },
  { name: 'green', css: '#00ff00', x: 280, y: 170, size: 16 },
] as const

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

function pixelAt(img: Bgra, x: number, y: number): [number, number, number, number] {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return [0, 0, 0, 0]
  const i = (py * img.width + px) * 4
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0, img.data[i + 3] ?? 0]
}

const rgb = (p: [number, number, number, number]): string =>
  '#' + [p[2], p[1], p[0]].map((v) => v.toString(16).padStart(2, '0')).join('')

async function grabDesktop(): Promise<Bgra | null> {
  const display = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width * 2, height: display.size.height * 2 },
  })
  const first = sources[0]
  return first === undefined ? null : toBgra(first.thumbnail)
}

function markerHtml(): string {
  const blocks = MARKERS.map(
    (m) =>
      `<div style="position:absolute;left:${m.x}px;top:${m.y}px;width:${m.size}px;height:${m.size}px;background:${m.css}"></div>`,
  ).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin:0; height:100%; background: transparent; overflow: hidden; }
  </style></head><body>${blocks}</body></html>`
}

/** 在截图里找某个颜色块的包围盒。 */
function findColorBox(
  img: Bgra,
  target: readonly [number, number, number],
  tolerance = 24,
): { minX: number; minY: number; maxX: number; maxY: number; count: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let count = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = pixelAt(img, x, y)
      if (
        Math.abs(p[2] - target[0]) <= tolerance &&
        Math.abs(p[1] - target[1]) <= tolerance &&
        Math.abs(p[0] - target[2]) <= tolerance
      ) {
        count++
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  return count === 0 ? null : { minX, minY, maxX, maxY, count }
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = {
    electron: process.versions.electron,
    displaySize: screen.getPrimaryDisplay().size,
    scaleFactor: screen.getPrimaryDisplay().scaleFactor,
    window: { x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H },
  }

  await mkdir(OUT_DIR, { recursive: true })
  await sleep(800)

  const baseline = await grabDesktop()
  if (baseline === null) {
    report['fatal'] = '拿不到屏幕源'
    process.stdout.write('\n===CALIB-REPORT===\n' + JSON.stringify(report, null, 2) + '\n===END===\n')
    app.quit()
    return
  }
  report['shot'] = { width: baseline.width, height: baseline.height, note: '这是物理像素' }
  report['impliedScale'] = Number((baseline.width / screen.getPrimaryDisplay().size.width).toFixed(4))

  // 开一个窗口
  const w = new BrowserWindow({
    x: WIN_X,
    y: WIN_Y,
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(markerHtml()))
  w.setAlwaysOnTop(true)
  w.showInactive()
  await sleep(2000)

  report['reportedBounds'] = w.getBounds()
  report['contentBounds'] = w.getContentBounds()

  const after = await grabDesktop()
  if (after === null) {
    report['fatal'] = '第二次也拿不到屏幕源'
    process.stdout.write('\n===CALIB-REPORT===\n' + JSON.stringify(report, null, 2) + '\n===END===\n')
    app.quit()
    return
  }

  // ---------------------------------------------------------------- 变了哪些像素
  let changed = 0
  let cMinX = Infinity
  let cMinY = Infinity
  let cMaxX = -Infinity
  let cMaxY = -Infinity
  for (let y = 0; y < Math.min(baseline.height, after.height); y++) {
    for (let x = 0; x < Math.min(baseline.width, after.width); x++) {
      const a = pixelAt(baseline, x, y)
      const b = pixelAt(after, x, y)
      if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) > 10) {
        changed++
        if (x < cMinX) cMinX = x
        if (y < cMinY) cMinY = y
        if (x > cMaxX) cMaxX = x
        if (y > cMaxY) cMaxY = y
      }
    }
  }
  report['changedPixels'] = {
    count: changed,
    box: changed === 0 ? null : { minX: cMinX, minY: cMinY, maxX: cMaxX, maxY: cMaxY, w: cMaxX - cMinX + 1, h: cMaxY - cMinY + 1 },
  }

  // ---------------------------------------------------------------- 找色块
  const found: Record<string, unknown> = {}
  const detectedCenters: Array<{ name: string; cx: number; cy: number; expectX: number; expectY: number }> = []

  for (const m of MARKERS) {
    const targetRgb: [number, number, number] =
      m.name === 'red' ? [255, 0, 0] : [0, 255, 0]
    const box = findColorBox(after, targetRgb)
    found[m.name] = box
    if (box !== null) {
      const cx = (box.minX + box.maxX) / 2
      const cy = (box.minY + box.maxY) / 2
      // 期望位置：窗口原点 + 块内偏移 + 半块
      detectedCenters.push({
        name: m.name,
        cx,
        cy,
        expectX: WIN_X + m.x + m.size / 2,
        expectY: WIN_Y + m.y + m.size / 2,
      })
    }
  }
  report['markers'] = found
  report['markerCenters'] = detectedCenters

  // ---------------------------------------------------------------- 反解映射
  if (detectedCenters.length === 2) {
    const [a, b] = detectedCenters as [(typeof detectedCenters)[number], (typeof detectedCenters)[number]]
    const scaleX = (b.cx - a.cx) / (b.expectX - a.expectX)
    const scaleY = (b.cy - a.cy) / (b.expectY - a.expectY)
    report['solvedMapping'] = {
      scaleX: Number(scaleX.toFixed(4)),
      scaleY: Number(scaleY.toFixed(4)),
      offsetX: Number((a.cx - a.expectX * scaleX).toFixed(1)),
      offsetY: Number((a.cy - a.expectY * scaleY).toFixed(1)),
      note: '截图坐标 ≈ expect * scale + offset',
    }
    report['windowRectInShot'] = {
      x: Number((WIN_X * scaleX + (a.cx - a.expectX * scaleX)).toFixed(1)),
      y: Number((WIN_Y * scaleY + (a.cy - a.expectY * scaleY)).toFixed(1)),
      w: Number((WIN_W * scaleX).toFixed(1)),
      h: Number((WIN_H * scaleY).toFixed(1)),
    }
  }

  // ---------------------------------------------------------------- 逐点采样
  const probe = (label: string, contentX: number, contentY: number): Record<string, unknown> => {
    const scale = (report['solvedMapping'] as { scaleX: number; offsetX: number; scaleY: number; offsetY: number } | undefined)
    const sx = scale ? (WIN_X + contentX) * scale.scaleX + scale.offsetX : WIN_X + contentX
    const sy = scale ? (WIN_Y + contentY) * scale.scaleY + scale.offsetY : WIN_Y + contentY
    return {
      label,
      content: { x: contentX, y: contentY },
      shotPos: { x: Math.round(sx), y: Math.round(sy) },
      before: rgb(pixelAt(baseline, sx, sy)),
      after: rgb(pixelAt(after, sx, sy)),
    }
  }

  report['probes'] = [
    probe('窗口左上角内侧 2px（圆角外，应该看到桌面）', 2, 2),
    probe('窗口上边中点', WIN_W / 2, 2),
    probe('窗口正中（应该也是桌面，因为什么都不画）', WIN_W / 2, WIN_H / 2),
    probe('窗口右下角内侧 2px', WIN_W - 3, WIN_H - 3),
    probe('窗口外面一点（对照组，一定不变）', -20, -20),
  ]

  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 900 } })
  const s = sources[0]
  if (s !== undefined) {
    await writeFile(path.join(OUT_DIR, 'calib-after.png'), s.thumbnail.toPNG())
    report['savedShot'] = 'calib-after.png'
  }

  process.stdout.write('\n===CALIB-REPORT===\n' + JSON.stringify(report, null, 2) + '\n===END===\n')

  await sleep(200)
  w.destroy()
  app.quit()
}

app.whenReady().then(main).catch((error: unknown) => {
  process.stdout.write('\n===CALIB-ERROR===\n' + String(error) + '\n===END===\n')
  app.exit(1)
})
