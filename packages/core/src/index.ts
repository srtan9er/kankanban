/**
 * KankanBan 核心库。
 *
 * 这一层刻意不依赖 Electron：它要能在纯 Node 下跑测试、独立启动 MCP server。
 * Electron 只在 app/ 里出现。
 *
 * 唯一的数据入口是 `Workspace.execute(command)`。
 * UI 直接调它，MCP server 把它包成工具，人和 AI 因此走同一条路。
 */

export * from './types.ts'
export * from './errors.ts'
export * from './ids.ts'
export * from './utils.ts'
export * from './write-queue.ts'
export * from './card-file.ts'
export * from './tree.ts'
export * from './event-log.ts'
export * from './persistence.ts'
export * from './commands.ts'
export * from './workspace.ts'
export * from './queries.ts'
