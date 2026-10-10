/**
 * 把"core 必须平台无关"从一句注释变成**可执行的约束**。
 *
 * 【为什么这条必须存在】
 * §9.1 的硬约束原文只说了"不得 import React，也不得依赖任何浏览器/DOM 全局"。
 * 但 core 还要跑在 **Tauri 的 webview** 里 —— 那里**也没有 Node**。
 * 所以真正的约束是**平台无关**：不碰 Node、不碰 DOM、不碰 React。
 *
 * 这一条如果只写在注释里，下一次有人图省事 `import { join } from 'node:path'`
 * 就会在**很远的地方**炸（webview 里加载失败，而 Node 侧的测试全绿）。
 * 实现期真的发生过：core 里曾有 4 行 Node 依赖，是搭 UI 时才发现的。
 *
 * 【扫描方式】按"代码位置"匹配，不剥注释 —— 因为注释里**需要**能提这些名字
 * （否则连"不要用 node:path"这种说明都写不了）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { joinPath } from '../src/core/paths.ts';
// node --test 每个测试文件跑在**独立进程**里，所以注入必须逐文件做。
import '../src/node/bootstrap.ts';

const CORE_DIR = fileURLToPath(new URL('../src/core/', import.meta.url));

/** 只在**代码位置**出现的平台 API。 */
const FORBIDDEN: Array<{ name: string; pattern: RegExp; why: string }> = [
  {
    name: 'Node 内置模块',
    pattern: /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]node:/,
    why: 'webview 里没有 Node，core 会在加载时直接失败',
  },
  {
    name: 'React',
    pattern: /(?:from\s*|require\s*\(\s*)['"]react/,
    why: '§9.1：core 不得 import React',
  },
  {
    name: 'DOM 全局 window',
    pattern: /(?<![\w.$])window\s*[.[]/,
    why: 'core 要能在 Node 里跑（MCP 服务器）',
  },
  {
    name: 'DOM 全局 document',
    pattern: /(?<![\w.$])document\s*[.[]/,
    why: 'core 要能在 Node 里跑',
  },
  {
    name: '浏览器存储',
    pattern: /(?<![\w.$])(?:localStorage|sessionStorage|indexedDB|navigator)\s*[.[]/,
    why: 'core 要能在 Node 里跑',
  },
  {
    name: 'Node 全局 process',
    pattern: /(?<![\w.$])process\s*[.[]/,
    why: 'webview 里没有 process',
  },
];

function coreFiles(prefix = ''): string[] {
  const entries = readdirSync(joinPath(CORE_DIR, prefix === '' ? '.' : prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...coreFiles(relative));
    else if (entry.name.endsWith('.ts')) files.push(relative);
  }
  return files.sort();
}

test('core 目录下确实有文件（防止扫描空转成假绿）', () => {
  const files = coreFiles();

  assert.ok(files.length >= 8, `core 文件数异常：${files.length}`);
  assert.ok(files.includes('state.ts'), '应当扫到 state.ts');
  assert.ok(files.includes('storage/workspace-io.ts'), '应当递归扫到子目录');
});

test('core 不 import 任何平台 API（Node / DOM / React）', () => {
  const violations: string[] = [];

  for (const file of coreFiles()) {
    const lines = readFileSync(joinPath(CORE_DIR, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const { name, pattern, why } of FORBIDDEN) {
        if (pattern.test(line)) {
          violations.push(`${file}:${index + 1} 出现 ${name} —— ${why}\n    ${line.trim()}`);
        }
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `core 必须平台无关。发现 ${violations.length} 处违规：\n${violations.join('\n')}`,
  );
});

test('平台实现本身确实在 core 之外（否则上面那条会变成空转）', () => {
  assert.equal(coreFiles().includes('storage/node-fs-ops.ts'), false);
  // Node 实现与注入点都在 src/node 下
  const nodeDir = fileURLToPath(new URL('../src/node/', import.meta.url));
  const nodeFiles = readdirSync(nodeDir);

  assert.ok(nodeFiles.includes('node-fs-ops.ts'), 'src/node 下应当有 node-fs-ops.ts');
  assert.ok(nodeFiles.includes('bootstrap.ts'), 'src/node 下应当有 bootstrap.ts');
});

test('没注入 FsOps 时 core 抛的是明确的错，而不是静默用一个不对的实现', async () => {
  const { clearInjectedFsOps, defaultFsOps, injectFsOps } = await import('../src/core/storage/fs-ops.ts');

  const original = defaultFsOps();
  try {
    clearInjectedFsOps();
    assert.throws(() => defaultFsOps(), /未注入 FsOps/);
  } finally {
    // 还原，免得影响同进程里后面的用例
    injectFsOps(original);
  }
});
