/**
 * Node 侧的平台入口 —— 把 `FsOps` 的 Node 实现注入 core。
 *
 * **所有 Node 入口（MCP 服务器、测试、以后的 CLI）都必须先 import 这个模块一次**，
 * 否则 core 里的 `defaultFsOps()` 会抛"未注入"。
 *
 * 刻意做成"显式注入"而不是让 core 自己 `import 'node:fs'`：
 * 后者会让 core 在 webview 里直接加载失败，而那时错误会出现在很远的地方。
 */

import { injectFsOps } from '../core/storage/fs-ops.ts';
import { nodeFsOps } from './node-fs-ops.ts';

injectFsOps(nodeFsOps);

export { nodeFsOps };
