import { app, desktopCapturer, screen } from 'electron'
import type { NativeImage } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 应用本体正在跑，两个 Electron 进程不能共用同一个 userData 目录
app.setPath('userData', path.join(tmpdir(), 'kkb-capture-profile'))

/**
 * 在应用跑着的时候从外部抓一张桌面截图，并做统计。
 *
 * 为什么需要它：浮卡是无边框透明窗口，主进程那边看不到界面长什么样；
 * 写代码的 AI 也读不了图。所以这里用像素统计来回答「到底渲染出来了没有」：
 *   - 数一数有多少接近卡片底色（#fbfbfd）的像素 → 浮卡渲染了
 *   - 数一数有多少接近主色（#4a90d9）的像素 → 标题栏/强调色渲染了
 *   - 数一数有多少接近 main 板深色底（#16181c）的像素 → main 板渲染了
 *
 * 同时把 PNG 存下来 —— 人能看图，比任何统计都直接。
 */

const OUT = process.env['KKB_SHOT_OUT'] ?? '.tmp-app-shot'
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

function near(pixel: [number, number, number], target: [number, number, number], tol: number): boolean {
  return (
    Math.abs(pixel[0] - target[0]) <= tol &&
    Math.abs(pixel[1] - target[1]) <= tol &&
    Math.abs(pixel[2] - target[2]) <= tol
  )
}

async function main(): Promise<void> {
  await sleep(Number(process.env['KKB_SHOT_DELAY'] ?? 6000))
  await mkdir(OUT, { recursive: true })

  const display = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width * 2, height: display.size.height * 2 },
  })
  const first = sources[0]
  if (first === undefined) {
    process.stdout.write('===CAPTURE===\n{"error":"拿不到屏幕源"}\n===END===\n')
    app.quit()
    return
  }

  const full = first.thumbnail
  const img = toBgra(full)

  const targets = {
    '卡片底色 #fbfbfd': [251, 251, 253] as [number, number, number],
    '强调色 #4a90d9': [74, 144, 217] as [number, number, number],
    'main 底色 #16181c': [22, 24, 28] as [number, number, number],
    '深色卡片 #2b3038': [43, 48, 56] as [number, number, number],
  }

  const counts: Record<string, number> = {}
  const boxes: Record<string, { minX: number; minY: number; maxX: number; maxY: number }> = {}

  for (const key of Object.keys(targets)) {
    counts[key] = 0
    boxes[key] = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  }

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      const pixel: [number, number, number] = [img.data[i + 2] ?? 0, img.data[i + 1] ?? 0, img.data[i] ?? 0]
      for (const [key, target] of Object.entries(targets)) {
        if (near(pixel, target, 6)) {
          counts[key] = (counts[key] ?? 0) + 1
          const box = boxes[key] as { minX: number; minY: number; maxX: number; maxY: number }
          if (x < box.minX) box.minX = x
          if (y < box.minY) box.minY = y
          if (x > box.maxX) box.maxX = x
          if (y > box.maxY) box.maxY = y
        }
      }
    }
  }

  const report: Record<string, unknown> = {
    shot: { width: img.width, height: img.height, scaleFactor: display.scaleFactor },
    counts,
    boxes: Object.fromEntries(
      Object.entries(boxes).map(([key, box]) => [
        key,
        box.maxX < 0 ? null : { ...box, w: box.maxX - box.minX + 1, h: box.maxY - box.minY + 1 },
      ]),
    ),
  }

  await writeFile(path.join(OUT, 'desktop.png'), full.toPNG())
  report['saved'] = path.join(OUT, 'desktop.png')

  const small = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 900 } })
  if (small[0] !== undefined) await writeFile(path.join(OUT, 'desktop-small.png'), small[0].thumbnail.toPNG())

  process.stdout.write('\n===CAPTURE===\n' + JSON.stringify(report, null, 2) + '\n===END===\n')
  app.quit()
}

app.whenReady().then(main).catch((error: unknown) => {
  process.stdout.write('\n===CAPTURE-ERROR===\n' + String(error) + '\n===END===\n')
  app.exit(1)
})
