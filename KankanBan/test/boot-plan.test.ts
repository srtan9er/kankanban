/**
 * 启动决策的断言。
 *
 * 这段逻辑原来内联在 `main.tsx` 的 `boot()` 里，而那个函数一上来就 `createRoot` ——
 * 于是"第一次打开该不该播示例、先挂哪个窗口"从来没被任何断言覆盖过。
 * 抽成纯函数之后就能逐条钉住了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { BUILTIN_CARDS } from '../src/core/builtins.ts';
import { emptyViewState, rememberOpenWindows } from '../src/core/view-state.ts';
import { createCard, deleteCard, ensureBuiltins, openSession } from '../src/core/workspace.ts';
import { desktopCards } from '../src/core/windows.ts';
import type { Session } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { missingBuiltins, planBoot } from '../src/webview/boot-plan.ts';

function makeSession(withBuiltins = true): Session {
  let counter = 0;
  return openSession('/boot', {
    clientId: 'b',
    ops: createMemoryFs().ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
    builtins: withBuiltins,
  });
}

// ── 播种决策 ───────────────────────────────────────────────────────────────────

test('全新工作区要播示例；窗口 id 留空 —— 卡还没建，id 要等建完才知道', () => {
  const session = makeSession();

  const plan = planBoot(session.state, []);

  assert.deepEqual(plan, { seedDemo: true, windowId: null });
});

test('已经有用户卡的工作区**不再**播示例 —— 判据不能再用"看板还没有列"', () => {
  const session = makeSession();
  createCard(session, { parentId: null, title: '第一张卡' });

  // 单卡示例**根本不建列**，所以"看板没有列"永远为真 ——
  // 拿它当"没播过示例"的代理，会导致每次启动都再建一张"第一张卡"（真实工作区上实测到）。
  const plan = planBoot(session.state, []);

  assert.equal(plan.seedDemo, false, '第二次启动不该再建一遍示例');
  assert.equal(plan.windowId, 'c1', '优先挂到用户自己的卡上，而不是那张空的看板');
});

test('工作区里已经有用户建的卡（哪怕只是看板下的一列）就不播种', () => {
  const session = makeSession();
  createCard(session, { parentId: '001', title: '已有的列', layout: 'ordered' });

  assert.equal(planBoot(session.state, []).seedDemo, false);
});

test('判据是"有没有**用户**卡"，而不是"有没有卡" —— 内置卡一定在', () => {
  const session = makeSession();

  assert.equal(session.state.cards.size, BUILTIN_CARDS.length, '内置卡确实已经在了');
  assert.equal(
    planBoot(session.state, []).seedDemo,
    true,
    '但内置卡不算"用户卡"，所以仍然判定为"要播种"',
  );
});

test('用户卡全被删掉时又回到"要播种" —— 空工作区给点东西看', () => {
  const session = makeSession();
  const mine = createCard(session, { parentId: null, title: '我的卡' });
  assert.equal(planBoot(session.state, []).seedDemo, false);

  deleteCard(session, mine);

  assert.equal(planBoot(session.state, []).seedDemo, true, '软删的卡不算"有内容"');
});

test('看板有列、别人的卡却挂在不存在的容器下时也不播种', () => {
  const session = makeSession();
  createCard(session, { parentId: '001', title: '列', layout: 'ordered' });

  assert.equal(planBoot(session.state, []).seedDemo, false);
});

// ── 窗口选择 ───────────────────────────────────────────────────────────────────

test('已有内容时优先挑一张**非 main** 的窗口（单窗口的权宜）', () => {
  const session = makeSession();
  // 注意：列卡是**看板的子卡**，不是根卡 —— 它不该出现在窗口候选里
  createCard(session, { parentId: '001', title: '列', layout: 'ordered' });
  createCard(session, { parentId: null, title: '我的卡' });

  const plan = planBoot(session.state, []);
  const roots = desktopCards(session.state);

  assert.equal(plan.seedDemo, false);
  assert.notEqual(plan.windowId, '000', '不该先开 main —— tabs 呈现还没做，main 现在是一张空白卡');
  assert.ok(roots.includes(plan.windowId ?? ''), `选的必须是根卡，实际 ${String(plan.windowId)}`);
  // 内置卡此刻都是空壳，而且按 id 排序还排在前面（'001' < 'c…'）。
  // 先显示看板 = 先显示一块白板，所以这里**优先用户自己的卡**。
  assert.equal(plan.windowId, 'c2', '优先用户自己的卡，而不是按 id 排在最前的看板');
});

test('记过别的窗口时优先用它（比"退而挑一张"更贴合用户上次的样子）', () => {
  const session = makeSession();
  createCard(session, { parentId: '001', title: '列', layout: 'ordered' });
  const mine = createCard(session, { parentId: null, title: '我的卡' });

  assert.equal(planBoot(session.state, [mine]).windowId, mine);
});

test('只有 main 与看板时，会开看板而不是 main', () => {
  const session = makeSession();
  createCard(session, { parentId: '001', title: '列', layout: 'ordered' });

  assert.equal(planBoot(session.state, []).windowId, '001');
});

test('恢复集合会参与选择：记过的窗口排在前面', () => {
  const session = makeSession();
  createCard(session, { parentId: '001', title: '列', layout: 'ordered' });
  const a = createCard(session, { parentId: null, title: 'AAA' });
  const b = createCard(session, { parentId: null, title: 'BBB' });

  // 只记过 b
  const remember = rememberOpenWindows(emptyViewState(), [b]);

  assert.equal(planBoot(session.state, remember.openWindows).windowId, b);
  assert.notEqual(a, b);
});

test('一张卡都没有时也走"播种"分支：调用方会建第一张卡', () => {
  const session = makeSession(false); // builtins: false → 什么卡都没有

  const plan = planBoot(session.state, []);

  assert.equal(plan.seedDemo, true);
  assert.equal(plan.windowId, null, '窗口 id 由建卡那一步给出');
});

// ── 自检 ───────────────────────────────────────────────────────────────────────

test('missingBuiltins 报出缺哪几张内置卡', () => {
  const session = makeSession(false);

  assert.deepEqual(missingBuiltins(session.state), ['000', '001', '002', '003']);
});

test('内置卡齐全时 missingBuiltins 为空', () => {
  const session = makeSession();
  ensureBuiltins(session);

  assert.deepEqual(missingBuiltins(session.state), []);
});
