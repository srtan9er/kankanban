import {uiText} from '../i18n/text.ts';
/**
 * CLI 入口 —— 只做 I/O：定工作区目录、开会话、把结果写出去、给退出码。
 *
 * 命令语义全在 `commands.ts`（那一层纯、可无头测），所以这里薄到不需要单测；
 * 但"真进程能不能跑通、退出码对不对"必须实跑验（见交付时的证据）。
 *
 * 【为什么默认动应用自己那个工作区】CLI 存在的理由是"抛开 UI 验后端"，
 * 那它就必须**读同一份数据** —— 落在别处的话，你验的是另一个世界。
 * 想另开一份就 `--workspace <目录>` 或环境变量 `KKB_WORKSPACE`。
 * 每次都会把实际路径打在**第一行**，避免"到底改了哪份"靠猜。
 */

import '../node/bootstrap.ts';

import { joinPath } from '../core/paths.ts';
import { openSession } from '../core/workspace.ts';
import { parseArgv } from './args.ts';
import { runCli } from './commands.ts';
import { acquireWorkspace } from '../node/workspace-lock.ts';

/** 与 `tauri.conf.json` 的 `identifier` 一致 —— 应用的数据目录就是按它命名的。 */
const APP_ID = 'com.kankanban.app';

function defaultWorkspace(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? joinPath(home, 'AppData/Roaming');
    return joinPath(appData, `${APP_ID}/workspace`);
  }
  if (process.platform === 'darwin') {
    return joinPath(home, `Library/Application Support/${APP_ID}/workspace`);
  }
  return joinPath(process.env['XDG_DATA_HOME'] ?? joinPath(home, '.local/share'), `${APP_ID}/workspace`);
}

/** core 的 `joinPath` 与 Rust 侧一致地给正斜杠，这里统一一下反斜杠。 */
const normalize = (path: string): string => path.replace(/\\/g, '/');

function workspaceFrom(argv: readonly string[]): string {
  try {
    const parsed = parseArgv(argv);
    if (parsed.workspace !== null) return normalize(parsed.workspace);
  } catch {
    // 参数不合法时交给 runCli 去报错；这里只需要一个能给默认值的结果
  }
  const fromEnv = process.env['KKB_WORKSPACE'];
  return normalize(fromEnv ?? defaultWorkspace());
}

function main(): number {
  const argv = process.argv.slice(2);
  const root = workspaceFrom(argv);

  // 会话**惰性**打开：看用法 / 命令打错 / 参数不合法时一个字节都不写盘
  let release: (() => void) | undefined;
  const result = runCli(() => { release = acquireWorkspace(root); return openSession(root, { clientId: 'cli' }); }, argv);
  release?.();

  let json = false;
  try {
    json = parseArgv(argv).json;
  } catch {
    json = false;
  }

  if (!json) process.stdout.write(uiText("cli/main.text001", {arg0: (root)}));
  if (result.out !== '') process.stdout.write(`${result.out}\n`);
  if (result.err !== '') process.stderr.write(`${result.err}\n`);

  return result.exitCode;
}

process.exitCode = main();
