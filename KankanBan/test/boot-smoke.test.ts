/**
 * 启动冒烟：**真的把入口跑一遍**，看它会不会崩、会不会画出东西。
 *
 * 这个文件补的是一个很实在的空洞：`main.tsx` 的 `boot()` 从写出来那天起就
 * **一次都没执行过**（它一 import 就 `createRoot`，还要 Tauri 环境）。
 * 而它是整个应用唯一没人验证过的一段 —— 其它都是纯逻辑，只有它是接线。
 *
 * 做法：装作"不在 Tauri 里"（`isTauri()` 读 `__TAURI_INTERNALS__`，
 * 测试环境里没有，自然为假），于是入口会退回内存后端 + 示例工作区，
 * 整条路径（注入 FsOps → 开会话 → 决策 → 建卡 → 落盘 → 渲染）都在 jsdom 里跑完。
 *
 * **它验证不了 Tauri IPC 与真实文件系统** —— 那要真跑起来才算。但"接线是否接错"
 * 这类错误它能拦住。
 */

import './dom-setup.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';

/** 入口是 import 即执行，所以每个用例都得重新加载一次模块（用 query 串破缓存）。 */
async function bootOnce(tag: string): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="root"></div>';
  const mount = document.getElementById('root');
  assert.ok(mount !== null);

  await act(async () => {
    await import(`../src/webview/main.tsx?${tag}`);
    // 让 boot() 里的几个 await 走完
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });

  return mount;
}

test('入口打开原型式管理器，不再将示例卡当作 main', async () => {
  const mount = await bootOnce('a1');

  const html = mount.innerHTML;
  assert.ok(html.length > 0, '入口没有渲染任何东西');
  assert.match(html, /class="manager-home"/);
  assert.match(html, /新建卡片/);
  assert.doesNotMatch(html, /第一张卡/);
});

test('入口的看板导航展示真实的三列', async () => {
  const mount = await bootOnce('a2');

  const button = [...mount.querySelectorAll('button')].find(e => e.textContent === '看板');
  assert.ok(button);
  await act(async () => button.click());
  assert.equal(mount.querySelectorAll('.kanban-column').length, 3);
  for (const title of ['待办', '进行中', '完成']) assert.ok(mount.textContent?.includes(title));
});

test('入口里的会话是**可用**的：状态里有卡、没有抛错', async () => {
  const mount = await bootOnce('a3');

  // 状态栏是入口接线是否走通的直接证据（它会显示工作区路径与事件数）
  assert.match(mount.innerHTML, /class="workspace-footer"/);
  assert.match(mount.innerHTML, /已保存/);
});

test('两次启动互不干扰（模块缓存被 query 串破开了）', async () => {
  const first = await bootOnce('b1');
  const firstHtml = first.innerHTML;
  const second = await bootOnce('b2');

  assert.ok(firstHtml.length > 0);
  assert.match(second.innerHTML, /class="manager-home"/);
  assert.doesNotMatch(second.innerHTML, /工作区未能打开/);
});
