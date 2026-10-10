import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { replay } from '../src/core/replay.ts';
import { applyEvent, emptyState } from '../src/core/state.ts';
import type { CoreState } from '../src/core/state.ts';
import { KKB_DIR, commit, openWorkspace, readEvents } from '../src/core/storage/workspace-io.ts';
import { SimulatedCrash, countWriteOps, crashingOps } from '../src/core/storage/fs-ops.ts';
import { nodeFsOps } from '../src/node/node-fs-ops.ts';
import '../src/node/bootstrap.ts';
import { serializeCard } from '../src/core/storage/frontmatter.ts';
import type { CardEvent, CardFields, ChildEntry, OrderedEntry, PlainEntry, SubtreeSnapshot } from '../src/core/types.ts';

// ── 夹具 ───────────────────────────────────────────────────────────────────────

function card(id: string, over: Partial<CardFields> = {}): CardFields {
  return {
    id,
    title: id,
    content: '',
    type: null,
    layout: 'plain',
    isPrefab: false,
    prefabRef: null,
    overrides: [],
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'test',
    editingBy: null,
    deleted: false,
    ...over,
  };
}

const plain = (id: string): PlainEntry => ({ id });
const ord = (id: string, order: number): OrderedEntry => ({ id, order });

function env(seq: number, cardId: string) {
  return { id: `e${seq}`, seq, clientId: 'test', timestamp: seq * 1000, cardId };
}

/** P(ordered) ← A, B, C；B ← D；然后改标题、重排序、移动、删 B。 */
function script(): CardEvent[] {
  const subtree: SubtreeSnapshot = {
    fields: card('B'),
    cards: { B: card('B'), D: card('D'), C: card('C') },
    children: { B: [ord('D', 0), ord('C', 1)] },
  };
  return [
    { ...env(1, 'P'), type: 'card_create', parentId: null, entry: null, fields: card('P', { layout: 'ordered' }) },
    { ...env(2, 'A'), type: 'card_create', parentId: 'P', entry: ord('A', 0), fields: card('A') },
    { ...env(3, 'B'), type: 'card_create', parentId: 'P', entry: ord('B', 1), fields: card('B') },
    { ...env(4, 'C'), type: 'card_create', parentId: 'P', entry: ord('C', 2), fields: card('C') },
    { ...env(5, 'A'), type: 'field_set', path: '/title', from: 'A', to: '甲' },
    { ...env(6, 'C'), type: 'child_update', parentId: 'P', entry: ord('C', 0), from: ord('C', 2), index: 2 },
    { ...env(7, 'D'), type: 'card_create', parentId: 'B', entry: ord('D', 0), fields: card('D') },
    { ...env(8, 'C'), type: 'card_move', fromParent: 'P', toParent: 'B', fromIndex: 2, removedEntry: ord('C', 0), addedEntry: ord('C', 1), index: 1 },
    { ...env(9, 'B'), type: 'card_delete', parentId: 'P', removedEntry: ord('B', 1), removedIndex: 1, subtree },
  ];
}

function fold(events: readonly CardEvent[]): CoreState {
  return events.reduce(applyEvent, emptyState());
}

/** 建一个全新的空工作区目录（`.kkb` 已就绪，tree.json 为空树）。 */
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kkb-'));
  const kkb = join(root, KKB_DIR);
  mkdirSync(join(kkb, 'cards'), { recursive: true });
  writeFileSync(join(kkb, 'tree.json'), JSON.stringify({ version: 1, lastAppliedSeq: 0, children: {} }), 'utf8');
  writeFileSync(join(kkb, 'events.jsonl'), '', 'utf8');
  return root;
}

function withRoot(body: (root: string) => void): void {
  const root = freshRoot();
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 状态的完整可比表示。 */
function snap(state: CoreState) {
  const byKey = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {
    lastAppliedSeq: state.lastAppliedSeq,
    cards: [...state.cards.entries()].sort(byKey),
    children: [...state.children.entries()].sort(byKey),
  };
}

// ── §4.3 断言四：write(读(工作区)) === 工作区 ─────────────────────────────────

test('commit 后 openWorkspace 读回的状态与写入时一致（存取往返）', () => {
  withRoot((root) => {
    const events = script();
    const before = fold(events);

    commit(root, events, before);
    const { state: after } = openWorkspace(root);

    assert.deepEqual(snap(after), snap(before));
  });
});

test('存取往返对空工作区也成立', () => {
  withRoot((root) => {
    commit(root, [], emptyState());

    const { state, events, droppedTailLines } = openWorkspace(root);

    assert.equal(state.cards.size, 0);
    assert.equal(state.children.size, 0);
    assert.equal(events.length, 0);
    assert.equal(droppedTailLines, 0);
  });
});

test('cards/ 下每张卡一个 .md 文件，字段与正文分离', () => {
  withRoot((root) => {
    const events = script();
    commit(root, events, fold(events));

    const text = readFileSync(join(root, KKB_DIR, 'cards', 'A.md'), 'utf8');

    assert.match(text, /^---\n/);
    assert.match(text, /title: "甲"/);
  });
});

test('events.jsonl 每行一个事件，且能原样读回', () => {
  withRoot((root) => {
    const events = script();
    commit(root, events, fold(events));

    const { events: back, droppedTailLines } = readEvents(root);

    assert.equal(droppedTailLines, 0);
    assert.deepEqual(back, events);
  });
});

test('第二次 commit 只追加新事件，不重写旧日志', () => {
  withRoot((root) => {
    const first = script();
    commit(root, first, fold(first));

    const extra: CardEvent[] = [{ ...env(10, 'P'), type: 'child_add', parentId: 'P', entry: plain('Z'), index: 1 }];
    commit(root, extra, fold([...first, ...extra]));

    const { events } = readEvents(root);
    assert.equal(events.length, 10);
    assert.deepEqual(events.slice(0, 9), first);
    assert.equal(events[9]?.type, 'child_add');
  });
});

// ── §4.2：启动恢复 ────────────────────────────────────────────────────────────

test('tree.json 落后于日志时，尾部事件在启动时被重放', () => {
  withRoot((root) => {
    const events = script();
    // 只把日志写进去，模拟"事件已落盘、状态文件还没写"的中间态。
    for (const e of events) appendFileSync(join(root, KKB_DIR, 'events.jsonl'), `${JSON.stringify(e)}\n`, 'utf8');

    const { state } = openWorkspace(root);

    assert.deepEqual(snap(state), snap(fold(events)));
  });
});

test('日志尾部的截断半行被丢弃，前面的照常恢复', () => {
  withRoot((root) => {
    const events = script().slice(0, 3);
    for (const e of events) appendFileSync(join(root, KKB_DIR, 'events.jsonl'), `${JSON.stringify(e)}\n`, 'utf8');
    // 模拟写到一半被杀：最后一行没有换行、JSON 不完整。
    appendFileSync(join(root, KKB_DIR, 'events.jsonl'), '{"id":"e4","seq":4,"cli', 'utf8');

    const { state, droppedTailLines } = openWorkspace(root);

    assert.equal(droppedTailLines, 1);
    assert.deepEqual(snap(state), snap(fold(events)));
  });
});

test('日志中间出现损坏行时抛错，而不是静默跳过', () => {
  withRoot((root) => {
    const events = script().slice(0, 3);
    for (const e of events) appendFileSync(join(root, KKB_DIR, 'events.jsonl'), `${JSON.stringify(e)}\n`, 'utf8');
    appendFileSync(join(root, KKB_DIR, 'events.jsonl'), '这不是 JSON\n', 'utf8');
    appendFileSync(join(root, KKB_DIR, 'events.jsonl'), `${JSON.stringify(events[0])}\n`, 'utf8');

    assert.throws(() => openWorkspace(root), /第 4 行/);
  });
});

// ── §4.3 断言三：崩溃一致性 ───────────────────────────────────────────────────

/**
 * 在**一次性目录**上量出一次 commit 有多少个写点。
 *
 * 不能拿被测目录来量 —— 量写点数的过程本身就会真的提交一次，把目录污染成"已经提交成功"。
 */
function measureWriteOps(base: readonly CardEvent[], extra: readonly CardEvent[], nextState: CoreState): number {
  const probe = freshRoot();
  try {
    commit(probe, base, fold(base));
    return countWriteOps(nodeFsOps, (ops) => {
      commit(probe, extra, nextState, ops);
    });
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** 新建目录并把 `base` 提交好，用于逐个崩溃点的独立复现。 */
function rootWithBase(base: readonly CardEvent[]): string {
  const root = freshRoot();
  commit(root, base, fold(base));
  return root;
}

test('在任意一次写操作前被杀，重启后磁盘状态都等于日志的重放结果', (t) => {
  const base = script().slice(0, 5);
  const extra: CardEvent[] = [
    { ...env(6, 'C'), type: 'child_update', parentId: 'P', entry: ord('C', 0), from: ord('C', 2), index: 2 },
    { ...env(7, 'A'), type: 'field_set', path: '/content', from: '', to: '正文' },
  ];
  const nextState = fold([...base, ...extra]);

  const totalOps = measureWriteOps(base, extra, nextState);
  assert.ok(totalOps > 0, '崩溃测试至少要有一个写点，否则它是空转的');
  t.diagnostic(`一次 commit 共 ${totalOps} 个写点，逐个崩溃位置都验过`);

  for (let crashAfter = 0; crashAfter < totalOps; crashAfter += 1) {
    const caseDir = rootWithBase(base);
    try {
      assert.throws(
        () => commit(caseDir, extra, nextState, crashingOps(nodeFsOps, crashAfter)),
        SimulatedCrash,
        `崩溃点 ${crashAfter} 应当抛出 SimulatedCrash`,
      );

      const { state, events } = openWorkspace(caseDir);

      // 核心性质：磁盘状态必须是日志的忠实重放结果（不许出现第三种状态）。
      assert.deepEqual(
        snap(state),
        snap(replay(events)),
        `崩溃点 ${crashAfter}：磁盘状态与日志重放结果不一致`,
      );
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  }
});

test('崩溃点落在全部卡片文件之后、tree.json 之前时，重启靠重放补上新值', () => {
  const base = script().slice(0, 5);
  const extra: CardEvent[] = [{ ...env(6, 'A'), type: 'field_set', path: '/title', from: 'A', to: '甲' }];
  const nextState = fold([...base, ...extra]);

  const totalOps = measureWriteOps(base, extra, nextState);
  const root = rootWithBase(base);
  try {
    // 崩在最后一次写操作之前。这一条同时锁住"tree.json 必须最后由原子替换写入"这个次序：
    // 若有人把 tree.json 提到卡片文件之前，这里就会拿到旧字段，测试当场失败。
    assert.throws(() => commit(root, extra, nextState, crashingOps(nodeFsOps, totalOps - 1)), SimulatedCrash);

    const { state, events } = openWorkspace(root);

    assert.equal(state.cards.get('A')?.title, '甲', '重放尾部事件必须把新值补上');
    assert.deepEqual(snap(state), snap(nextState));
    assert.equal(events.length, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 加载期校验：坏数据要吵，不要静默降级 ──────────────────────────────────────

test('tree.json 引用不存在的卡时抛错', () => {
  withRoot((root) => {
    writeFileSync(
      join(root, KKB_DIR, 'tree.json'),
      JSON.stringify({ version: 1, lastAppliedSeq: 0, children: { P: [ord('ghost', 0)] } }),
      'utf8',
    );
    writeFileSync(join(root, KKB_DIR, 'cards', 'P.md'), serializeCard(card('P', { layout: 'ordered' })), 'utf8');

    assert.throws(() => openWorkspace(root), /不存在的卡|ghost/);
  });
});

test('条目形状与父卡 layout 不匹配时抛错', () => {
  withRoot((root) => {
    writeFileSync(
      join(root, KKB_DIR, 'tree.json'),
      JSON.stringify({ version: 1, lastAppliedSeq: 0, children: { P: [plain('A')] } }),
      'utf8',
    );
    writeFileSync(join(root, KKB_DIR, 'cards', 'P.md'), serializeCard(card('P', { layout: 'ordered' })), 'utf8');
    writeFileSync(join(root, KKB_DIR, 'cards', 'A.md'), serializeCard(card('A')), 'utf8');

    assert.throws(() => openWorkspace(root), /形状|layout/);
  });
});

test('cards/ 文件名与 frontmatter 里的 id 不一致时抛错', () => {
  withRoot((root) => {
    writeFileSync(join(root, KKB_DIR, 'cards', 'wrong-name.md'), serializeCard(card('A')), 'utf8');

    assert.throws(() => openWorkspace(root), /文件名|wrong-name|id/);
  });
});

test('同一张卡被两个父卡引用时抛错（森林不能退化成图）', () => {
  withRoot((root) => {
    writeFileSync(
      join(root, KKB_DIR, 'tree.json'),
      JSON.stringify({
        version: 1,
        lastAppliedSeq: 0,
        children: { P1: [plain('A')], P2: [plain('A')] },
      }),
      'utf8',
    );
    for (const id of ['P1', 'P2', 'A']) {
      writeFileSync(join(root, KKB_DIR, 'cards', `${id}.md`), serializeCard(card(id)), 'utf8');
    }

    assert.throws(() => openWorkspace(root), /两个父卡|重复/);
  });
});

test('首次创建写到一半被杀（.kkb 在、tree.json 不在、无数据）当成空工作区，不报错', () => {
  withRoot((root) => {
    // writeState 先 mkdirp、最后才写 tree.json，所以崩溃点正落在两者之间。
    rmSync(join(root, KKB_DIR, 'tree.json'), { force: true });
    writeFileSync(join(root, KKB_DIR, 'events.jsonl'), '', 'utf8');

    const { state } = openWorkspace(root);

    assert.equal(state.cards.size, 0);
    assert.equal(state.lastAppliedSeq, 0);
  });
});

test('已经有数据却没有 tree.json 时抛错（结构真丢了，不能当成空工作区）', () => {
  withRoot((root) => {
    rmSync(join(root, KKB_DIR, 'tree.json'), { force: true });
    writeFileSync(join(root, KKB_DIR, 'cards', 'A.md'), serializeCard(card('A')), 'utf8');

    assert.throws(() => openWorkspace(root), /结构文件丢了|tree\.json/);
  });
});

test('删除崩在"卡片文件已写、tree.json 未写"之间时，重放必须幂等', async () => {
  const { createCard, deleteCard, openSession } = await import('../src/core/workspace.ts');

  // 先在一次性探针目录里量出 deleteCard 有几个写点。
  const probeRoot = freshRoot();
  let total = 0;
  try {
    const probe = openSession(probeRoot, { builtins: false, clientId: 't' });
    const p = createCard(probe, { parentId: null, title: 'P' });
    createCard(probe, { parentId: p, title: 'C' });

    const original = probe.ops;
    total = countWriteOps(nodeFsOps, (ops) => {
      probe.ops = ops;
      try {
        deleteCard(probe, p);
      } finally {
        probe.ops = original;
      }
    });
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
  assert.ok(total > 0);

  withRoot((root) => {
    const session = openSession(root, { builtins: false, clientId: 't' });
    const p = createCard(session, { parentId: null, title: 'P' });
    createCard(session, { parentId: p, title: 'C' });

    // 崩在最后一次写（tree.json 的原子替换）之前 ——
    // 此刻 cards/*.md 已带 deleted:true，而 tree.json 还停在删除前。
    session.ops = crashingOps(nodeFsOps, total - 1);
    assert.throws(() => deleteCard(session, p), SimulatedCrash);

    // 这条曾经抛 "card_delete 指向已经删除的卡" / "快照与实际子树不一致"：
    // 严格校验把一次**正常的崩溃恢复**判成了数据损坏。
    const { state, events } = openWorkspace(root);

    assert.equal(state.cards.get(p)?.deleted, true);
    assert.equal(state.children.has(p), false);
    assert.deepEqual(snap(state), snap(replay(events)));
  });
});
