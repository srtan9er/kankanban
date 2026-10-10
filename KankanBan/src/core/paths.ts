/**
 * 平台无关的路径拼接。
 *
 * 【为什么不直接用 `node:path`】core 必须能同时跑在 Node（MCP 服务器）与
 * Tauri 的 webview（React UI）里 —— webview **没有 Node**。
 * 见 §9.1 的硬约束与 `test/platform-neutral.test.ts`。
 *
 * 一律用 `/` 拼接：Windows 的 Node 与 WebView 都接受正斜杠，
 * 所以同一个字符串在两边都能当路径用，不需要知道自己在哪个平台。
 */

export function joinPath(...parts: string[]): string {
  const cleaned: string[] = [];
  for (const part of parts) {
    if (part === '') continue;
    cleaned.push(part);
  }
  if (cleaned.length === 0) return '';

  return cleaned
    .map((part, index) => {
      // 只在中间的部分去掉首尾斜杠；首段保留（可能是 `/` 或 `C:\`）。
      if (index === 0) return part.replace(/\/+$/, '');
      return part.replace(/^\/+/, '').replace(/\/+$/, '');
    })
    .filter((part) => part !== '')
    .join('/');
}
