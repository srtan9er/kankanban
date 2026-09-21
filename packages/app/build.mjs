import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'

/**
 * 四个入口全用 esbuild 打。
 *
 * 为什么不用 Vite：Vite 在加载配置文件时会走 `windowsSafeRealPathSync` → `exec`，
 * 受限环境里直接 spawn EPERM（本项目最早的 vitest 就栽在这条路上）。
 * esbuild 没这个动作，一个工具把主进程、preload、renderer 全办了，
 * 依赖也少一个。代价是没有 HMR —— 这个项目现阶段不需要。
 */

const watch = process.argv.includes('--watch')
const spike = process.argv.includes('--spike')

/*
 * ESM 输出里必须补一个 require。
 *
 * core 依赖 yaml，而 yaml 是 CJS 包。esbuild 把它打进 ESM 产物时会生成
 * 一个 __require 垫片，遇到 node 内置模块就抛
 * "Dynamic require of \"process\" is not supported"。
 * 在文件头声明一个真的 require 就好，同时保住 import.meta.dirname 可用。
 */
const esmRequireBanner = {
  js: "import { createRequire as __kkbCreateRequire } from 'node:module';\nconst require = __kkbCreateRequire(import.meta.url);",
}

const targets = [
  {
    name: 'main',
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main.mjs',
    format: 'esm',
    platform: 'node',
    external: ['electron'],
    banner: esmRequireBanner,
  },
  {
    // sandbox: true 下 preload 必须是 CommonJS
    name: 'preload',
    entryPoints: ['src/preload/preload.ts'],
    outfile: 'dist/preload.cjs',
    format: 'cjs',
    platform: 'node',
    external: ['electron'],
  },
  {
    name: 'renderer',
    entryPoints: ['src/renderer/index.tsx'],
    outfile: 'dist/renderer/app.js',
    format: 'iife',
    platform: 'browser',
    target: 'chrome130',
  },
]

if (spike) {
  for (const name of ['transparent-windows', 'calibrate', 'corner', 'capture-app']) {
    targets.push({
      name,
      entryPoints: [`spike/${name}.ts`],
      outfile: `dist/${name}.mjs`,
      format: 'esm',
      platform: 'node',
      external: ['electron'],
      banner: esmRequireBanner,
    })
  }
}

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env['NODE_ENV'] ?? 'production') },
}

await mkdir('dist/renderer', { recursive: true })

for (const target of targets) {
  const { name, ...options } = target
  await build({ ...common, ...options })
  process.stdout.write(`  ✓ ${name}\n`)
}

await copyFile('src/renderer/index.html', 'dist/renderer/index.html')

if (watch) {
  process.stdout.write('\nwatch 模式还没实现，先手动重跑吧。\n')
}
