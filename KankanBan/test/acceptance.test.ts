/**
 * 阶段一验收 —— 逐条对应 ARCHITECTURE.md §4.3 的五条可执行断言。
 *
 *     replay(空, events) === 当前状态          # 重放一致性
 *     undo(events)       === 上一状态          # 撤销正确性
 *     杀掉进程于任意写入点 → 重启后状态一致      # 崩溃一致性
 *     write(读(工作区)) === 工作区             # 存取往返
 *     能通过 MCP 工具建卡、移卡、改字段、读树
 *
 * 与前面的单元测试不同，这里**用同一条端到端场景**把五条串起来跑：
 * 单元测试证明每一块对，验收测试证明它们合起来也对。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { replay } from '../src/core/replay.ts';
import { emptyState } from '../src/core/state.ts';
import type { CoreState } from '../src/core/state.ts';
import { SimulatedCrash, crashingOps } from '../src/core/storage/fs-ops.ts';
import { nodeFsOps } from '../src/node/node-fs-ops.ts';
import '../src/node/bootstrap.ts';
import type { FsOps } from '../src/core/storage/fs-ops.ts';
import { openWorkspace } from '../src/core/storage/workspace-io.ts';
import { createCard, deleteCard, moveCard, openSession, setField, undoLast } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createServer } from '../src/mcp/server.ts';

// ── 场景 ───────────────────────────────────────────────────────────────────────

/** 五个操作，覆盖建卡 / 建子卡 / 改字段 / 移卡 / 删子树。 */
const SCRIPT: Array<(session: Session, ids: Record<string, string>) => void> = [
  (s, ids) => {
    ids['P'] = createCard(s, { parentId: null, title: '看板', layout: 'ordered' });
  },
  (s, ids) => {
    ids['A'] = createCard(s, { parentId: ids['P'] as string, title: '任务甲' });
  },
  (s, ids) => {
    setField(s, ids['A'] as string, '/content', '# 正文');
  },
  (s, ids) => {
    // 浮动到桌面 —— 走的是 card_move 的 toParent === null 那条路
    moveCard(s, ids['A'] as string, null, 0);
  },
  (s, ids) => {
    deleteCard(s, ids['P'] as string);
  },
];

function deterministicSession(root: string, ops: FsOps = nodeFsOps): Session {
  let counter = 0;
  return openSession(root, {
      builtins: false,
    clientId: 'test',
    ops,
    clock: () => 1_700_000_000_000,
    newId: () => `c${(counter += 1)}`,
  });
}

function runWholeScript(root: string, ops: FsOps = nodeFsOps): { session: Session; states: CoreState[] } {
  const session = deterministicSession(root, ops);
  const ids: Record<string, string> = {};
  const states: CoreState[] = [session.state];

  for (const step of SCRIPT) {
    step(session, ids);
    states.push(session.state);
  }

  return { session, states };
}

/** 状态的完整可比表示（含 lastAppliedSeq）。 */
function snap(state: CoreState): string {
  const byKey = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return JSON.stringify({
    seq: state.lastAppliedSeq,
    cards: [...state.cards.entries()].sort(byKey),
    children: [...state.children.entries()].sort(byKey),
  });
}

function tempRoot(tag: string): string {
  return mkdtempSync(join(tmpdir(), `kkb-acc-${tag}-`));
}

// ── 断言一：重放一致性 ─────────────────────────────────────────────────────────

test('断言一 · replay(空, events) === 当前状态', () => {
  const root = tempRoot('replay');
  try {
    const { session } = runWholeScript(root);

    assert.equal(session.events.length, 5, '五个操作应当正好产生五条事件');
    assert.equal(snap(replay(session.events)), snap(session.state));
    assert.equal(snap(replay([])), snap(emptyState()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 断言二：撤销正确性 ─────────────────────────────────────────────────────────

test('断言二 · undo(events) === 上一状态', () => {
  const root = tempRoot('undo');
  try {
    const { session, states } = runWholeScript(root);

    // 逐个撤回去，每一步都要等于"这一步之前"的状态。
    for (let i = SCRIPT.length; i >= 1; i -= 1) {
      assert.equal(undoLast(session), true);
      assert.equal(snap(session.state), snap(states[i - 1] as CoreState), `撤销第 ${i} 步后状态不对`);
    }

    assert.equal(undoLast(session), false, '撤到底之后再撤应当返回 false');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('断言二补充 · 撤销会落盘，重开工作区不会把撤销结果找回来', () => {
  const root = tempRoot('undo-persist');
  try {
    const { session } = runWholeScript(root);
    undoLast(session);

    const { state, events } = openWorkspace(root);

    assert.equal(events.length, 4);
    assert.equal(snap(state), snap(replay(events)));
    assert.equal([...state.cards.values()].some((c) => c.id === 'P' && c.deleted), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 断言三：崩溃一致性 ─────────────────────────────────────────────────────────

test('断言三 · 在任意写入点被杀，重启后状态一定是"某一步做完"的状态，不会半途', () => {
  const reference = tempRoot('crash-ref');
  const referenceStates = (() => {
    try {
      return runWholeScript(reference).states.map(snap);
    } finally {
      rmSync(reference, { recursive: true, force: true });
    }
  })();

  // 先量出整条场景要写多少点
  const probe = tempRoot('crash-probe');
  let totalOps = 0;
  try {
    const session = deterministicSession(probe);
    const ids: Record<string, string> = {};
    for (const step of SCRIPT) {
      totalOps += countOps(session, step, ids);
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  assert.ok(totalOps > 0);

  let checked = 0;
  for (let crashAfter = 0; crashAfter < totalOps; crashAfter += 1) {
    const root = tempRoot('crash');
    try {
      // 崩溃点可能落在 openSession 自己的首写里，所以整段都要包在 try 内。
      try {
        const session = deterministicSession(root, crashingOps(nodeFsOps, crashAfter));
        const ids: Record<string, string> = {};
        for (const step of SCRIPT) step(session, ids);
        continue; // 这一点没崩，跳过
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) throw error;
      }

      const { state, events } = openWorkspace(root);

      // (a) 磁盘状态必须是日志的忠实重放结果
      assert.equal(snap(state), snap(replay(events)), `崩溃点 ${crashAfter}：磁盘状态与日志不一致`);
      // (b) 而且必须**正好等于某一步做完**的状态 —— 不许出现"半条事件"拼出来的第三种状态
      assert.ok(
        referenceStates.includes(snap(state)),
        `崩溃点 ${crashAfter}：恢复出的状态不属于任何一步做完的结果`,
      );
      checked += 1;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  assert.ok(checked > 0, `一个崩溃点都没触发，测试是空转的（总写点 ${totalOps}）`);
  console.log(`  · 断言三崩溃点覆盖：${checked} / ${totalOps}`);
});

const WRITE_OPS: ReadonlySet<string> = new Set(['mkdirp', 'writeFile', 'rename', 'appendFile', 'fsync', 'remove']);

/** 数一个操作会写几次盘。口径必须与 `crashingOps` 一致（只数写，读不算）。 */
function countOps(
  session: Session,
  step: (s: Session, ids: Record<string, string>) => void,
  ids: Record<string, string>,
): number {
  let count = 0;
  const original = session.ops;

  const wrapped = new Proxy(original, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const isWrite = typeof prop === 'string' && WRITE_OPS.has(prop);
      return (...args: unknown[]) => {
        if (isWrite) count += 1;
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as FsOps;

  session.ops = wrapped;
  try {
    step(session, ids);
  } finally {
    session.ops = original;
  }
  return count;
}

// ── 断言四：存取往返 ───────────────────────────────────────────────────────────

test('断言四 · write(读(工作区)) === 工作区', () => {
  const root = tempRoot('roundtrip');
  try {
    const { session } = runWholeScript(root);
    const written = snap(session.state);

    const { state: readBack } = openWorkspace(root);
    assert.equal(snap(readBack), written);

    // 再写一遍、再读一遍，仍然一致（幂等）
    const reopened = openSession(root, { builtins: false, clientId: 'test' });
    const { state: secondRead } = openWorkspace(root);
    assert.equal(snap(secondRead), snap(reopened.state));
    assert.equal(snap(secondRead), written);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 断言五：MCP ────────────────────────────────────────────────────────────────

test('断言五 · 能通过 MCP 工具建卡、移卡、改字段、读树', async () => {
  const root = tempRoot('mcp');
  try {
    const session = openSession(root, { builtins: false, clientId: 'ai' });
    const server = createServer(session);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'acceptance', version: '0.0.0' });
    await client.connect(clientTransport);

    try {
      const parse = <T>(result: unknown): T => {
        const content = (result as { content: Array<{ text?: string }> }).content;
        return JSON.parse(content[0]?.text ?? 'null') as T;
      };

      // 建卡
      const parent = parse<{ id: string }>(
        await client.callTool({ name: 'create_card', arguments: { title: '板', layout: 'ordered' } }),
      );
      const child = parse<{ id: string }>(
        await client.callTool({ name: 'create_card', arguments: { title: '卡' } }),
      );

      // 移卡
      await client.callTool({
        name: 'move_card',
        arguments: { cardId: child.id, toParentId: parent.id, index: 0 },
      });

      // 改字段
      await client.callTool({
        name: 'set_field',
        arguments: { cardId: child.id, path: '/title', value: '改过的卡' },
      });

      // 读树
      const tree = parse<{ nodes: Array<{ id: string; children: Array<{ id: string; title: string }> }> }>(
        await client.callTool({ name: 'read_tree', arguments: { maxDepth: 2 } }),
      );

      assert.deepEqual(tree.nodes.map((n) => n.id), [parent.id]);
      assert.equal(tree.nodes[0]?.children[0]?.title, '改过的卡');

      // 协议之外复核：确实落盘了
      const { state } = openWorkspace(root);
      assert.equal(state.cards.get(child.id)?.title, '改过的卡');
      assert.deepEqual(state.children.get(parent.id)?.map((e) => e.id), [child.id]);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
