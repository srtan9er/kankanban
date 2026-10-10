/**
 * §7.3 窗口生命周期：**启动时该打开哪些窗口**。
 *
 * ```
 * 总是打开 main（000）；其余窗口按 view-state.json 恢复上次会话中打开的集合
 * （默认开启恢复，可在设置里关掉）
 * 恢复时校验：若某卡当前 parent !== null（已被拖进容器），不恢复窗口（符合不变量 W）
 * ```
 *
 * 校验直接落在 `desktopCards` 上 —— 它已经是"未删除的根卡"，
 * 所以"被拖进容器"与"已删除"两种失效情形**自动被过滤掉**，不需要另写判断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { ensureBuiltins, createCard, deleteCard, moveCard, openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import {
  emptyViewState,
  forgetWindow,
  openWindowsOf,
  readViewState,
  rememberOpenWindows,
  setFocus,
  writeViewState,
} from '../src/core/view-state.ts';
import { restorableWindows, desktopCards } from '../src/core/windows.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

const ROOT = '/v';

function makeSession(): { session: Session; memory: ReturnType<typeof createMemoryFs> } {
  const memory = createMemoryFs();
  let counter = 0;
  const session = openSession(ROOT, {
    clientId: 'v',
    ops: memory.ops,
    clock: () => 0,
    newId: () => `c${(counter += 1)}`,
    builtins: false,
  });
  return { session, memory };
}

// ── rememberOpenWindows / openWindowsOf ───────────────────────────────────────

test('记下的窗口集合去重且排序（同一个集合永远给同一个数组）', () => {
  const view = rememberOpenWindows(emptyViewState(), ['b', 'a', 'b', 'c']);

  assert.deepEqual(openWindowsOf(view), ['a', 'b', 'c']);
});

test('集合没变时返回**同一个引用** —— 免得调用方的 setState 白重渲染', () => {
  const once = rememberOpenWindows(emptyViewState(), ['a', 'b']);
  const twice = rememberOpenWindows(once, ['b', 'a']);

  assert.equal(twice, once, '顺序不同但集合相同，应当原样返回');
});

test('集合变了就返回新对象', () => {
  const once = rememberOpenWindows(emptyViewState(), ['a']);
  const twice = rememberOpenWindows(once, ['a', 'b']);

  assert.notEqual(twice, once);
  assert.deepEqual(openWindowsOf(twice), ['a', 'b']);
});

test('forgetWindow 同时把它从恢复集合里去掉', () => {
  const view = rememberOpenWindows(emptyViewState(), ['a', 'b']);

  const after = forgetWindow(view, 'a');

  assert.deepEqual(openWindowsOf(after), ['b']);
});

test('改窗口的其它视图状态不会把恢复集合弄丢', () => {
  const view = setFocus(rememberOpenWindows(emptyViewState(), ['a', 'b']), 'a', 'x');

  assert.deepEqual(openWindowsOf(view), ['a', 'b']);
});

// ── restorableWindows ─────────────────────────────────────────────────────────

test('启动总是打开 main —— 哪怕上次一个窗口都没记', () => {
  const { session } = makeSession();
  ensureBuiltins(session);

  assert.deepEqual(restorableWindows(session.state, []), ['000']);
});

test('上次开着的窗口会被恢复', () => {
  const { session } = makeSession();
  ensureBuiltins(session);
  const mine = createCard(session, { parentId: null, title: '我的卡' });

  assert.deepEqual(restorableWindows(session.state, ['001', mine]), ['000', '001', mine].sort());
});

test('§7.3 的校验：上次开着、但现在已被拖进容器的卡**不恢复**', () => {
  const { session } = makeSession();
  ensureBuiltins(session);
  const loose = createCard(session, { parentId: null, title: '浮在外面的' });
  const container = createCard(session, { parentId: null, title: '容器' });

  // 上次两个都开着
  const remembered = [loose, container];

  // 这次启动前，loose 已经被拖进容器（parent !== null）
  moveCard(session, loose, container, 0);

  assert.deepEqual(
    restorableWindows(session.state, remembered),
    ['000', container].sort(),
    'loose 已经不是根卡，不恢复它的窗口（不变量 W）',
  );
});

test('上次开着、但现在已被删掉的卡不恢复', () => {
  const { session } = makeSession();
  ensureBuiltins(session);
  const gone = createCard(session, { parentId: null, title: '要删的' });

  deleteCard(session, gone);

  assert.deepEqual(restorableWindows(session.state, [gone]), ['000']);
});

test('设置里关掉恢复时只开 main', () => {
  const { session } = makeSession();
  ensureBuiltins(session);
  const mine = createCard(session, { parentId: null, title: '我的卡' });

  assert.deepEqual(restorableWindows(session.state, [mine], { restore: false }), ['000']);
});

test('恢复集合里有重复或多余项也不出错（去重 + 过滤）', () => {
  const { session } = makeSession();
  ensureBuiltins(session);
  const mine = createCard(session, { parentId: null, title: '我的卡' });

  assert.deepEqual(
    restorableWindows(session.state, [mine, mine, '不存在', '001']),
    ['000', '001', mine].sort(),
  );
});

test('内置卡也不存在时（builtins:false）恢复集合为空', () => {
  const { session } = makeSession();

  assert.deepEqual(restorableWindows(session.state, []), []);
  assert.deepEqual(desktopCards(session.state), []);
});

// ── 往返 ───────────────────────────────────────────────────────────────────────

test('记下的恢复集合能落盘再读回来（旧文件缺这个字段时当成没记过）', () => {
  const { memory } = makeSession();
  const view = rememberOpenWindows(emptyViewState(), ['001', 'c9']);
  writeViewState(ROOT, view, memory.ops);

  const back = readViewState(ROOT, memory.ops);

  assert.deepEqual(openWindowsOf(back), ['001', 'c9']);
});

test('旧格式的 view-state.json（没有 openWindows）不报错，按"没记过"处理', () => {
  const { memory } = makeSession();
  memory.ops.mkdirp(`${ROOT}/.kkb`);
  memory.poke(`${ROOT}/.kkb/view-state.json`, JSON.stringify({ version: 1, windows: {} }));

  const back = readViewState(ROOT, memory.ops);

  assert.deepEqual(back.windows, {});
  assert.deepEqual(openWindowsOf(back), []);
});
