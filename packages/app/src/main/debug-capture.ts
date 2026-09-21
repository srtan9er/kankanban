import { BrowserWindow, desktopCapturer, screen } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 开发期自查：把窗口内容抓下来，既存 PNG 也打成字符画。
 *
 * 为什么需要字符画：写代码的这个 AI 读不了图片。把窗口降采样成
 * 亮度字符之后，布局在纯文本里也是可见的 —— 左栏、舞台、看板三列、
 * 卡片的位置都能看出来，比任何像素统计都直接。
 *
 * 由 KKB_CAPTURE_AFTER 环境变量触发（毫秒）。
 */

const RAMP = ' .:-=+*#%@'

interface Bgra {
  data: Buffer
  width: number
  height: number
}

function toBgra(image: Electron.NativeImage): Bgra {
  const size = image.getSize()
  return { data: image.toBitmap(), width: size.width, height: size.height }
}

function asciiArt(img: Bgra, cols = 76, rows = 30): string {
  const lines: string[] = []
  const cellW = img.width / cols
  const cellH = img.height / rows

  for (let row = 0; row < rows; row++) {
    let line = ''
    for (let col = 0; col < cols; col++) {
      let sum = 0
      let count = 0
      const x0 = Math.floor(col * cellW)
      const x1 = Math.min(img.width, Math.floor((col + 1) * cellW))
      const y0 = Math.floor(row * cellH)
      const y1 = Math.min(img.height, Math.floor((row + 1) * cellH))

      // 每格抽样 4x4 个点就够了
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4))
      const stepY = Math.max(1, Math.floor((y1 - y0) / 4))

      for (let y = y0; y < y1; y += stepY) {
        for (let x = x0; x < x1; x += stepX) {
          const i = (y * img.width + x) * 4
          const b = img.data[i] ?? 0
          const g = img.data[i + 1] ?? 0
          const r = img.data[i + 2] ?? 0
          // 亮度（感知加权）
          sum += 0.2126 * r + 0.7152 * g + 0.0722 * b
          count++
        }
      }

      const luminance = count === 0 ? 0 : sum / count
      const index = Math.min(RAMP.length - 1, Math.max(0, Math.round((luminance / 255) * (RAMP.length - 1))))
      line += RAMP[index]
    }
    lines.push(line)
  }

  return lines.join('\n')
}

function colorBuckets(img: Bgra, top = 8): Array<{ hex: string; count: number; ratio: number }> {
  const buckets = new Map<string, number>()
  for (let y = 0; y < img.height; y += 3) {
    for (let x = 0; x < img.width; x += 3) {
      const i = (y * img.width + x) * 4
      // 量化到 16 级，避免颜色太散
      const r = ((img.data[i + 2] ?? 0) >> 4) << 4
      const g = ((img.data[i + 1] ?? 0) >> 4) << 4
      const b = ((img.data[i] ?? 0) >> 4) << 4
      const key = `${r},${g},${b}`
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
    }
  }
  const total = [...buckets.values()].reduce((a, b) => a + b, 0)
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([key, count]) => {
      const [r, g, b] = key.split(',').map(Number) as [number, number, number]
      const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
      return { hex, count, ratio: Number((count / total).toFixed(3)) }
    })
}

export async function captureWindows(
  windows: Array<{ label: string; window: BrowserWindow }>,
  outDir: string,
): Promise<void> {
  await mkdir(outDir, { recursive: true })
  const report: Record<string, unknown> = {}

  for (const { label, window } of windows) {
    if (window.isDestroyed()) continue
    try {
      const image = await window.webContents.capturePage()
      const img = toBgra(image)
      const size = image.getSize()

      await writeFile(path.join(outDir, `${label}.png`), image.toPNG())

      report[label] = {
        size,
        bounds: window.getBounds(),
        visible: window.isVisible(),
        topColors: colorBuckets(img),
      }

      process.stdout.write(`\n===== 窗口 ${label}  ${size.width}x${size.height} =====\n`)
      process.stdout.write(asciiArt(img) + '\n')
    } catch (error) {
      report[label] = { error: error instanceof Error ? error.message : String(error) }
    }
  }

  process.stdout.write('\n===WINDOW-CAPTURE===\n' + JSON.stringify(report, null, 2) + '\n===END===\n')
}

/** 顺带抓一张整个桌面，方便看浮卡叠在真实桌面上的效果。 */
export async function captureDesktop(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true })
  const display = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width * 2, height: display.size.height * 2 },
  })
  const first = sources[0]
  if (first === undefined) return
  await writeFile(path.join(outDir, 'desktop.png'), first.thumbnail.toPNG())
}

/** 由 KKB_CAPTURE_AFTER 触发：等界面稳定之后抓一轮然后退出。 */
export function scheduleCapture(
  collect: () => Array<{ label: string; window: BrowserWindow }>,
  outDir: string,
  quit?: () => void,
): void {
  const delay = Number(process.env['KKB_CAPTURE_AFTER'] ?? 0)
  if (!Number.isFinite(delay) || delay <= 0) return

  setTimeout(() => {
    void (async () => {
      await captureWindows(collect(), outDir)
      if (process.env['KKB_CAPTURE_DESKTOP'] === '1') await captureDesktop(outDir)
      if (process.env['KKB_CAPTURE_EXIT'] === '1') {
        // 走正常关闭流程，别用 app.exit —— 那样会跳过 before-quit，
        // 工作区锁就留在磁盘上了
        quit?.()
        return
      }
      process.stdout.write('\n[capture] 抓完一轮，应用继续跑着。\n')
    })()
  }, delay)
}
