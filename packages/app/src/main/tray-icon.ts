import { nativeImage } from 'electron'
import type { NativeImage } from 'electron'

/**
 * 托盘图标：在代码里画出来，不引入图片资源。
 *
 * 用 createFromBitmap 直接给 BGRA 原始像素，省掉 PNG 编解码和资源文件。
 * 图案是三根高低不同的竖条 —— 看板的意思。
 */

const SIZE = 16

function makeIcon(accent: [number, number, number]): NativeImage {
  const buffer = Buffer.alloc(SIZE * SIZE * 4) // BGRA

  const put = (x: number, y: number, r: number, g: number, b: number, a: number): void => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
    const i = (y * SIZE + x) * 4
    buffer[i] = b
    buffer[i + 1] = g
    buffer[i + 2] = r
    buffer[i + 3] = a
  }

  // 底色：圆角方块
  const radius = 3
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = Math.min(x, SIZE - 1 - x)
      const dy = Math.min(y, SIZE - 1 - y)
      if (dx < radius && dy < radius) {
        const cx = radius - dx - 0.5
        const cy = radius - dy - 0.5
        if (cx * cx + cy * cy > radius * radius) continue
      }
      put(x, y, accent[0], accent[1], accent[2], 255)
    }
  }

  // 三根竖条（白色）
  const bars: Array<[number, number]> = [
    [4, 7],
    [7, 10],
    [10, 6],
  ]
  for (const [x, height] of bars) {
    for (let y = SIZE - 3 - height; y < SIZE - 3; y++) put(x, y, 255, 255, 255, 255)
  }

  return nativeImage.createFromBitmap(buffer, { width: SIZE, height: SIZE })
}

/** 蓝色 —— 正常状态。 */
export function trayIcon(): NativeImage {
  return makeIcon([74, 144, 217])
}

/** 灰色 —— 工作区没打开之类。 */
export function trayIconIdle(): NativeImage {
  return makeIcon([130, 136, 145])
}
