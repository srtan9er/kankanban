import { app, BrowserWindow, desktopCapturer, screen } from 'electron'
import type { NativeImage } from 'electron'
import { mkdir } from 'node:fs/promises'

/**
 * 圆角裁剪对照实验。
 *
 * 疑点：第一次 spike 里，卡片圆角外面的像素显示的是标题栏颜色，而不是桌面。
 * 说明 border-radius + overflow:hidden 没把子元素裁掉。
 *
 * 怀疑对象：`-webkit-app-region: drag`。Windows 上带拖拽区域的元素
 * 会被提升成独立的合成层，很可能逃出父元素的 overflow 裁剪。
 *
 * 做法：并排放两个窗口，卡片结构完全一样，
 * 唯一区别是 A 的标题栏没有 app-region、B 的有。
 * 然后沿对角线采样 (1,1) → (18,18)：
 *   圆角半径 12px，所以 (8,8) 及以前应该被裁掉（看到桌面），(13,13) 以后应该在卡片里。
 */

const OUT_DIR = process.env['KKB_SPIKE_OUT'] ?? '.tmp-spike'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// 屏幕是 1707x1067 DIP，scaleFactor 1.5；截到的是 3414x2134 物理像素。
// 上一轮标定出来的映射：shot ≈ dip * 2.0038 - 1.5
const SCALE = 2.0038
const OFFSET = -1.5

const A = { x: 100, y: 100, w: 300, h: 190 }
const B = { x: 500, y: 100, w: 300, h: 190 }
const C = { x: 900, y: 100, w: 300, h: 190 }
const D = { x: 1300, y: 100, w: 300, h: 190 }

type Variant = 'nodrag' | 'drag' | 'drag+selfradius' | 'drag-overlay'

const VARIANTS: Array<{ box: typeof A; variant: Variant; label: string }> = [
  { box: A, variant: 'nodrag', label: 'A 无拖拽区域' },
  { box: B, variant: 'drag', label: 'B 拖拽区域在标题栏上' },
  { box: C, variant: 'drag+selfradius', label: 'C 标题栏自己加圆角' },
  { box: D, variant: 'drag-overlay', label: 'D 透明覆盖层当拖拽区域' },
]

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

function cardHtml(variant: Variant, label: string): string {
  const onHeader = variant === 'drag' || variant === 'drag+selfradius'
  const drag = onHeader ? '-webkit-app-region: drag;' : ''
  const selfRadius = variant === 'drag+selfradius' ? 'border-radius: 12px 12px 0 0;' : ''
  const overlay =
    variant === 'drag-overlay'
      ? '<div style="position:absolute;top:0;left:0;right:0;height:30px;-webkit-app-region:drag;background:transparent"></div>'
      : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin:0; height:100%; background: transparent; overflow:hidden;
    font: 12px "Segoe UI","Microsoft YaHei",sans-serif; }
  .card { position:relative; height:100%; box-sizing:border-box; border-radius:12px;
    background: rgba(255,255,255,0.96); overflow:hidden;
    display:flex; flex-direction:column; }
  .hdr { ${drag} ${selfRadius} height:30px; flex:none; background:#4A90D9; color:#fff;
    display:flex; align-items:center; padding:0 10px; font-weight:600; }
  .body { padding:8px 10px; color:#222; }
</style></head><body>
  <div class="card">
    <div class="hdr">${label}</div>
    <div class="body">圆角外面应该是桌面</div>
    ${overlay}
  </div>
</body></html>`
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  await sleep(700)

  const before = await grabDesktop()

  const wins: BrowserWindow[] = []
  for (const { box, variant, label } of VARIANTS) {
    const w = new BrowserWindow({
      ...box,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true },
    })
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(cardHtml(variant, label)))
    w.setAlwaysOnTop(true)
    w.showInactive()
    wins.push(w)
  }

  await sleep(2200)
  const after = await grabDesktop()

  const report: Record<string, unknown> = { scale: SCALE, offset: OFFSET }

  if (before === null || after === null) {
    report['fatal'] = '拿不到屏幕源'
  } else {
    const sample = (dipX: number, dipY: number): { after: string; before: string; changed: boolean } => {
      const sx = dipX * SCALE + OFFSET
      const sy = dipY * SCALE + OFFSET
      const b = pixelAt(before, sx, sy)
      const a = pixelAt(after, sx, sy)
      const diff = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
      return { after: rgb(a), before: rgb(b), changed: diff > 10 }
    }

    for (const { box, label } of VARIANTS) {
      const diagonal = [1, 2, 3, 4, 6, 8, 10, 14].map((d) => ({ d, ...sample(box.x + d, box.y + d) }))
      const topEdge = [1, 2, 4, 8, 16].map((d) => ({ y: d, ...sample(box.x + box.w / 2, box.y + d) }))
      const leftEdge = [1, 2, 4, 8, 16].map((d) => ({ x: d, ...sample(box.x + d, box.y + box.h / 2) }))

      report[label] = {
        左上角对角线: diagonal.map((r) => `d=${r.d}:${r.changed ? r.after : '桌面'}`),
        上边中点竖切: topEdge.map((r) => `y=${r.y}:${r.changed ? r.after : '桌面'}`),
        左边中点横切: leftEdge.map((r) => `x=${r.x}:${r.changed ? r.after : '桌面'}`),
      }
    }
  }

  process.stdout.write('\n===CORNER-REPORT===\n' + JSON.stringify(report, null, 2) + '\n===END===\n')
  await sleep(200)
  for (const w of wins) w.destroy()
  app.quit()
}

app.whenReady().then(main).catch((error: unknown) => {
  process.stdout.write('\n===CORNER-ERROR===\n' + String(error) + '\n===END===\n')
  app.exit(1)
})
