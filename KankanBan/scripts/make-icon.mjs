/**
 * 生成一张 1024×1024 的源图标（不引任何图像库，PNG 用 zlib 手写）。
 *
 * 之所以要有这个东西：`tauri-build` 在 Windows 上生成资源文件时**硬要求**
 * `icons/icon.ico`，缺了连 `cargo check` 都过不去（这在 sticky-tauri 原型上踩过）。
 *
 *     node scripts/make-icon.mjs && npx tauri icon icon-source.png
 *
 * 图案：深底上一个浅蓝圆角方块，里面再套一个更小的方块 —— 对应"卡片里还有卡片"。
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 1024;

// ── 最小 PNG 编码器 ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10..12 = compression / filter / interlace，全 0

  // 每行前面加一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 画图 ───────────────────────────────────────────────────────────────────────

const rgba = Buffer.alloc(SIZE * SIZE * 4);
const RADIUS = SIZE * 0.22;

/** 圆角矩形覆盖判定，带 1px 抗锯齿（按到边界的距离做线性过渡）。 */
function coverage(x, y, left, top, right, bottom, radius) {
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const distance = Math.hypot(x - cx, y - cy);
  return Math.min(Math.max(radius + 0.5 - distance, 0), 1);
}

function paint(x, y, [r, g, b], alpha) {
  if (alpha <= 0) return;
  const index = (y * SIZE + x) * 4;
  const existing = rgba[index + 3] / 255;
  const out = alpha + existing * (1 - alpha);
  if (out <= 0) return;
  rgba[index] = Math.round((r * alpha + rgba[index] * existing * (1 - alpha)) / out);
  rgba[index + 1] = Math.round((g * alpha + rgba[index + 1] * existing * (1 - alpha)) / out);
  rgba[index + 2] = Math.round((b * alpha + rgba[index + 2] * existing * (1 - alpha)) / out);
  rgba[index + 3] = Math.round(out * 255);
}

const INK = [0x8a, 0xb4, 0xf8];
const PAPER = [0x20, 0x21, 0x24];

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const outer = coverage(x, y, 0, 0, SIZE - 1, SIZE - 1, RADIUS);
    if (outer > 0) paint(x, y, INK, outer);

    const inner = coverage(x, y, SIZE * 0.16, SIZE * 0.16, SIZE * 0.84, SIZE * 0.84, RADIUS * 0.45);
    if (inner > 0) paint(x, y, PAPER, inner);

    const core = coverage(x, y, SIZE * 0.3, SIZE * 0.3, SIZE * 0.7, SIZE * 0.7, RADIUS * 0.25);
    if (core > 0) paint(x, y, INK, core);
  }
}

writeFileSync('icon-source.png', encodePng(SIZE, SIZE, rgba));
console.log(`已生成 icon-source.png（${SIZE}×${SIZE}）`);
