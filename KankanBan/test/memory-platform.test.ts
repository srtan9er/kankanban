/**
 * 内存平台的 `FsOps` —— 它存在的意义不只是"测试快一点"：
 *
 * **它证明 core 真的与平台无关。** webview 里没有 Node，所以 core 必须能在一个
 * 不 import 任何 Node 模块、不碰 DOM 的 `FsOps` 上跑完整套 §4.3 断言。
 * 这里就是把那套断言在**第二个平台**上再跑一遍。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { replay } from '../src/core/replay.ts';
import { emptyState } from '../src/core/state.ts';
import type { CoreState } from '../src/core/state.ts';
import { crashingOps, SimulatedCrash } from '../src/core/storage/fs-ops.ts';
import { openWorkspace, readEvents } from '../src/core/storage/workspace-io.ts';
import { createCard, deleteCard, moveCard, openSession, setField, undoLast } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { viewOf, type CardView } from '../src/core/view-model.ts';
import { emptyViewState, readViewState, setFocus, setRegionSize, writeViewState, type ViewState } from '../src/core/view-state.ts';
/** `viewOf` 现在可能返回 null（根卡没了）。这里测的场景里根卡一直在，所以断言非空。 */
function mustView(...args: Parameters<typeof viewOf>): CardView {
  const model = viewOf(...args);
  assert.ok(model !== null, 'viewOf 不该返回 null：这些场景里窗口根卡一直存在');
  return model;
}

const ROOT = '/ws';

function sessionOn(memory = createMemoryFs()): { session: Session; memory: ReturnType<typeof createMemoryFs> } {
  let counter = 0;
  const session = openSession(ROOT, {
      builtins: false,
    clientId: 'mem',
    ops: memory.ops,
    clock: () => 1_700_000_000_000,
    newId: () => `c${(counter += 1)}`,
  });
  return { session, memory };
}

function snap(state: CoreState): string {
  const byKey = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return JSON.stringify({
    seq: state.lastAppliedSeq,
    cards: [...state.cards.entries()].sort(byKey),
    children: [...state.children.entries()].sort(byKey),
  });
}

// ── 内存 FS 本身的语义要与 nodeFsOps 对齐 ────────────────────────────────────

test('mkdirp 建中间目录，readDir 只列直接子项', () => {
  const memory = createMemoryFs();
  memory.ops.mkdirp('/ws/.kkb/cards');

  assert.equal(memory.ops.exists('/ws/.kkb/cards'), true);
  assert.equal(memory.ops.exists('/ws/.kkb'), true);
  assert.deepEqual(memory.ops.readDir('/ws/.kkb'), ['cards']);
});

test('writeFile 需要父目录存在（与 node 一致，不隐式建目录）', () => {
  const memory = createMemoryFs();

  assert.throws(() => memory.ops.writeFile('/nope/a.txt', 'x'), /父目录不存在/);
});

test('appendFile 在文件不存在时创建', () => {
  const memory = createMemoryFs();
  memory.ops.mkdirp('/d');
  memory.ops.appendFile('/d/a.txt', 'one');
  memory.ops.appendFile('/d/a.txt', 'two');

  assert.equal(memory.ops.readFile('/d/a.txt'), 'onetwo');
});

test('rename 移动内容并删掉源', () => {
  const memory = createMemoryFs();
  memory.ops.mkdirp('/d');
  memory.ops.writeFile('/d/a.tmp', 'x');
  memory.ops.rename('/d/a.tmp', '/d/a.txt');

  assert.equal(memory.ops.readFile('/d/a.txt'), 'x');
  assert.equal(memory.ops.exists('/d/a.tmp'), false);
});

test('remove 连子目录一起删', () => {
  const memory = createMemoryFs();
  memory.ops.mkdirp('/d/sub');
  memory.ops.writeFile('/d/sub/a.txt', 'x');
  memory.ops.remove('/d');

  assert.equal(memory.ops.exists('/d/sub/a.txt'), false);
  assert.equal(memory.ops.exists('/d'), false);
});

test('路径分隔符混用也能对上（core 用 /，测试可能给 \\）', () => {
  const memory = createMemoryFs();
  memory.ops.mkdirp('/d');
  memory.ops.writeFile('\\d\\a.txt', 'x');

  assert.equal(memory.ops.readFile('/d/a.txt'), 'x');
});

// ── §4.3 断言在内存平台上重跑一遍 ───────────────────────────────────────────

test('断言一 · 内存平台上 replay(空, events) === 当前状态', () => {
  const { session } = sessionOn();
  const p = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
  const a = createCard(session, { parentId: p, title: 'A' });
  setField(session, a, '/content', '正文');

  assert.equal(snap(replay(session.events)), snap(session.state));
  assert.notEqual(snap(replay([])), snap(session.state));
  assert.equal(snap(replay([])), snap(emptyState()));
});

test('断言二 · 内存平台上 undo 回到上一状态，且会落盘', () => {
  const { session, memory } = sessionOn();
  const p = createCard(session, { parentId: null, title: 'P' });
  const a = createCard(session, { parentId: p, title: 'A' });
  const afterTwo = snap(session.state);

  undoLast(session);

  // 撤销后的状态应当正好等于"只应用第一条事件"的重放
  const first = session.events[0];
  assert.ok(first !== undefined);
  assert.equal(snap(session.state), snap(replay([first])));

  // 而且已经落盘：重开时看不到被撤掉的那张卡
  const reopened = openWorkspace(ROOT, memory.ops);
  assert.equal(reopened.events.length, 1, '撤销后日志里应当只剩一条');
  assert.equal(snap(reopened.state), snap(session.state));
  assert.notEqual(snap(reopened.state), afterTwo);
  assert.equal(reopened.state.cards.has(a), false);
});

test('断言三 · 内存平台上任意写点被杀，重启后状态仍等于日志重放', () => {
  const runScenario = (session: Session): void => {
    const p = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
    const a = createCard(session, { parentId: p, title: 'A' });
    const b = createCard(session, { parentId: p, title: 'B' });
    moveCard(session, b, p, 0);
    setField(session, a, '/title', '改过');
    deleteCard(session, p);
  };

  // 参照状态：不崩，跑完整条
  const clean = createMemoryFs();
  const cleanSession = openSession(ROOT, {
      builtins: false,
    clientId: 'mem',
    ops: clean.ops,
    clock: () => 0,
    newId: (() => {
      let n = 0;
      return () => `c${(n += 1)}`;
    })(),
  });
  runScenario(cleanSession);

  // 逐写点崩
  let total = 0;
  {
    const probe = createMemoryFs();
    const original = probe.ops;
    const counting = new Proxy(original, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (prop !== 'exists' && prop !== 'readFile' && prop !== 'readDir') total += 1;
          return (value as (...a: unknown[]) => unknown)(...args);
        };
      },
    });
    const session = openSession(ROOT, { builtins: false, clientId: 'mem', ops: counting, clock: () => 0 });
    try {
      runScenario(session);
    } catch {
      /* 计数阶段不该崩，崩了也无所谓 */
    }
  }
  assert.ok(total > 0);

  let checked = 0;
  for (let crashAfter = 0; crashAfter < total; crashAfter += 1) {
    const memory = createMemoryFs();
    try {
      const session = openSession(ROOT, {
      builtins: false,
        clientId: 'mem',
        ops: crashingOps(memory.ops, crashAfter),
        clock: () => 0,
        newId: (() => {
          let n = 0;
          return () => `c${(n += 1)}`;
        })(),
      });
      runScenario(session);
      continue; // 没崩
    } catch (error) {
      if (!(error instanceof SimulatedCrash)) throw error;
    }

    const { state, events } = openWorkspace(ROOT, memory.ops);
    assert.equal(snap(state), snap(replay(events)), `崩溃点 ${crashAfter}：磁盘状态与日志不一致`);
    checked += 1;
  }

  assert.ok(checked > 0, `一个崩溃点都没触发（总写点 ${total}）`);
  console.log(`  · 内存平台崩溃点覆盖：${checked} / ${total}`);
});

test('断言四 · 内存平台上存取往返成立', () => {
  const { session, memory } = sessionOn();
  const p = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
  createCard(session, { parentId: p, title: 'A' });
  deleteCard(session, createCard(session, { parentId: null, title: '要删的' }));

  const { state } = openWorkspace(ROOT, memory.ops);

  assert.equal(snap(state), snap(session.state));
  assert.equal(readEvents(ROOT, memory.ops).droppedTailLines, 0);
});

// ── 视图层也在内存平台上跑通（这是 webview 真正要用的组合） ──────────────────

test('内存平台上 view-state 往返 + viewOf 出结果', () => {
  const { session, memory } = sessionOn();
  const root = createCard(session, { parentId: null, title: '根' });
  const mid = createCard(session, { parentId: root, title: '中' });

  let view: ViewState = { ...emptyViewState(), skin: 'dark', theme: 'custom.css', canvasSwapButtons: false, cardRadius: 14 };
  view = setFocus(view, root, mid);
  view = setRegionSize(view, root, 'content', 300);
  writeViewState(ROOT, view, memory.ops);

  const back = readViewState(ROOT, memory.ops);
  assert.deepEqual(back, view);

  const card = mustView(session.state, back, root);
  assert.equal(card.id, mid);
  assert.deepEqual(card.breadcrumb.map((c) => c.id), [root, mid]);
  assert.equal(card.regions.content.size, 300);
});

test('view-state 写坏了也不阻塞（读不动就退回空状态）', () => {
  const memory = createMemoryFs();
  memory.ops.mkdirp(`${ROOT}/.kkb`);
  memory.poke(`${ROOT}/.kkb/view-state.json`, '');

  assert.deepEqual(readViewState(ROOT, memory.ops), emptyViewState());
});
