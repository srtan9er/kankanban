import {uiText} from '../i18n/text.ts';
/**
 * MCP 服务器入口（stdio）。
 *
 *     node src/mcp/main.ts [工作区路径]
 *
 * 省略路径时用当前目录。会话里的每次写操作都会立刻落盘（见 workspace.ts 的 emit）。
 */

import '../node/bootstrap.ts';
import { serveStdio } from './server.ts';
import { acquireWorkspace } from '../node/workspace-lock.ts';

async function main(): Promise<void> {
  const root = process.argv[2] ?? process.cwd();
  const release = acquireWorkspace(root);
  process.on('exit', release);
  const server = await serveStdio(root, { clientId: 'mcp' });

  const shutdown = async (): Promise<void> => {
    await server.close();
    release();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // stderr 是安全的：stdout 是 MCP 协议通道，往里写日志会破坏帧。
  process.stderr.write(uiText("mcp/main.text001", {arg0: (root)}));
}

await main();
