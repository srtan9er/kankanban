/**
 * 给 Node 的测试进程加一个 `.tsx` 加载钩子。
 *
 * 【为什么需要】Node 的 type stripping **只剥类型，不认 JSX**，所以 `node --test`
 * 直接 import `.tsx` 会失败。而 React 那层如果没有任何断言，"UI 代码就绪"就只剩
 * "能编译"这一个证据 —— 编译过不等于渲染对。
 *
 * 这里用 Node 24 的 `module.registerHooks`（同步钩子）在 `load` 阶段把 `.tsx`
 * 交给 esbuild 转成 ESM。**只影响测试进程**，生产构建仍走 Vite。
 *
 * 用法（已写进 package.json 的 test 脚本）：
 *     node --import ./test/tsx-hooks.mjs --test
 */

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { transformSync } from 'esbuild';

registerHooks({
  load(url, context, nextLoad) {
    // 去掉 `?query` 再判断后缀 —— 测试用 `import('…main.tsx?a1')` 来破模块缓存，
    // 那种 URL 不以 `.tsx` 结尾，不剥掉的话会漏给 Node 的默认加载器。
    const clean = url.split('?')[0];

    // 样式表在测试里没有意义（jsdom 不做布局），给它一个空模块就行。
    // 这样 `main.tsx` 这种"带着 import './style.css'"的入口也能被无头加载。
    if (clean.endsWith('.css')) {
      return { format: 'module', source: 'export default "";', shortCircuit: true };
    }

    if (!clean.endsWith('.tsx')) return nextLoad(url, context);

    const { code } = transformSync(readFileSync(fileURLToPath(clean), 'utf8'), {
      loader: 'tsx',
      format: 'esm',
      target: 'es2023',
      jsx: 'automatic',
      sourcefile: clean,
      sourcemap: 'inline',
    });

    return { format: 'module', source: code, shortCircuit: true };
  },
});
