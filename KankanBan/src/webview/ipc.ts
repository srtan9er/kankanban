/**
 * webview ↔ webview 的命令通道（Tauri 的 `emit` / `listen`）。
 *
 * 【为什么只用全局广播，不用 `emitTo` 定点】
 * `sticky-tauri` 踩过这个坑：JS `listen` 的 target 默认是 `{ kind: 'Any' }`，
 * 而 `Any` 会**短路掉发送侧的过滤**（`tauri/src/event/listener.rs`），
 * 于是"按 label 精确投递"并不像看上去那样可靠 —— 只能反过来要求发送方定点发。
 *
 * 这里两条通道的语义本来就是广播，用 `emit` 最直白，也绕开了整套过滤：
 *   - 镜像 → main：`kkb:command` —— 只有 main 注册这个事件，别的镜像不注册
 *   - main → 全部镜像：`kkb:changed` —— 所有镜像都要重载（谁改的、改了什么都可能影响它）
 *
 * 两条都要求 `core:event:allow-emit` / `allow-listen`，见 `capabilities/*.json`。
 *
 * 【不在 Tauri 里时全部退化成空操作】浏览器预览下没有 IPC，也不该有人监听。
 */

import { emit, listen } from '@tauri-apps/api/event';

import type { CardId } from '../core/types.ts';
import type { Command } from './operations.ts';
import { isTauri } from './tauri-backend.ts';

export const COMMAND_EVENT = 'kkb:command';
export const CHANGED_EVENT = 'kkb:changed';

/** 镜像发给 main 的一条命令。`from` 是发起窗口的标签，用来把结果送回给它。 */
export type CommandMessage = { from: string; command: Command };

/**
 * main 广播"工作区变了，去重载"。
 *
 * `createdId` 只有一种用途：让**发起建卡的那个窗口**建完就切进标题编辑
 * （别的窗口虽然也会重载，但不该抢走输入焦点）。
 */
export type ChangedMessage = { from: string; createdId?: CardId | undefined };

export async function emitCommand(from: string, command: Command): Promise<void> {
  if (!isTauri()) return;
  await emit(COMMAND_EVENT, { from, command } satisfies CommandMessage);
}

export async function emitChanged(from: string, createdId?: CardId | undefined): Promise<void> {
  if (!isTauri()) return;
  await emit(CHANGED_EVENT, { from, createdId } satisfies ChangedMessage);
}

/** 只在 main 里注册。不在 Tauri 里时返回一个什么都不做的退订函数。 */
export async function onCommand(handler: (message: CommandMessage) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  return listen<CommandMessage>(COMMAND_EVENT, (event) => handler(event.payload));
}

/** 只在卡片窗口里注册。 */
export async function onChanged(handler: (message: ChangedMessage) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  return listen<ChangedMessage>(CHANGED_EVENT, (event) => handler(event.payload));
}
