/**
 * 平台无关的默认 id 生成。
 *
 * 【为什么不用 `node:crypto` 的 `randomUUID`】core 必须能跑在 webview 里，而那里没有 Node。
 * 这里只用 ECMAScript 自带的能力（`Date.now` / `Math.random`），
 * 因此在 Node、webview、测试里行为一致。
 *
 * 真正需要强唯一性的场景（跨设备同步、导入）应当**注入**自己的 `newId`
 * —— `SessionOptions.newId` 就是为此留的口子。
 */

let counter = 0;

export function defaultNewId(): string {
  counter += 1;
  const stamp = Date.now().toString(36);
  const noise = Math.floor(Math.random() * 0xffffffff).toString(36);
  const sequence = counter.toString(36);
  return `c${stamp}${sequence}-${noise}`;
}

/** 仅供测试重置计数器，避免同一进程内多次运行互相影响。 */
export function resetIdCounter(): void {
  counter = 0;
}
