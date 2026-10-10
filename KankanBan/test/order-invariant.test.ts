/**
 * 不变量 O：顺序型父卡内，`order` 非递减且 `order[j] ≥ j`。
 *
 * 【为什么需要这条】
 * §2.4.1 说渲染"按 `order` 升序"，而事件用**数组下标**寻址。两者若在某些操作后
 * 给出不同的顺序，就是同一事实有两处表示 —— §2.3 最想避免的那种。
 *
 * 【结论】操作层按 `order = 插入下标` 赋值即可维持本不变量：
 * 插入位置 i 的两侧邻居满足 `order[i-1] ≤ i-1 < i ≤ order[i]`，
 * 所以**按 order 稳定排序 == 数组顺序**，两个口径不会打架。
 *
 * 这个文件用固定种子的随机操作序列去**找反例**，而不是只跑几个我想到的例子。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import '../src/node/bootstrap.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openWorkspace } from '../src/core/storage/workspace-io.ts';
import { createCard, deleteCard, moveCard, openSession, setField, undoLast } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import type { CardId, ChildEntry, Layout, OrderedEntry } from '../src/core/types.ts';

const ORDERED_LAYOUTS: Layout[] = ['tabs', 'columns', 'ordered', 'grid'];

function isOrdered(layout: Layout): boolean {
  return ORDERED_LAYOUTS.includes(layout);
}

function isOrderedEntry(entry: ChildEntry): entry is OrderedEntry {
  return 'order' in entry && typeof (entry as OrderedEntry).order === 'number';
}

/** mulberry32：小而确定的 PRNG，保证失败可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 检查每一个顺序型父卡：`order` **严格递增**，
 * 且因此**按 order 排序后的结果与数组顺序逐项相同**。
 *
 * 严格递增比"非递减 + 稳定排序"更强也更好查：只要严格递增，
 * 数组顺序就是唯一的 order 顺序，不存在"靠排序稳定才碰巧对"的余地。
 */
function assertOrderInvariant(session: Session, context: string): void {
  for (const [parentId, list] of session.state.children) {
    const layout = session.state.cards.get(parentId)?.layout;
    if (layout === undefined || !isOrdered(layout)) continue;

    const ordered: OrderedEntry[] = [];
    for (const entry of list) {
      assert.ok(isOrderedEntry(entry), `${context}: 顺序型父卡 ${parentId} 下出现非顺序型条目`);
      ordered.push(entry);
    }

    for (let j = 1; j < ordered.length; j += 1) {
      const previous = ordered[j - 1] as OrderedEntry;
      const current = ordered[j] as OrderedEntry;
      assert.ok(
        previous.order < current.order,
        `${context}: parent=${parentId} j=${j} order ${previous.order} >= ${current.order}，不是严格递增`,
      );
    }

    // 渲染器实际依赖的性质：直接按 order 排序，顺序不变。
    const sorted = [...ordered].sort((a, b) => a.order - b.order);
    assert.deepEqual(
      sorted.map((e) => e.id),
      ordered.map((e) => e.id),
      `${context}: parent=${parentId} 按 order 排序改变了顺序`,
    );
  }
}

test('随机操作序列下，order 始终非递减且与数组顺序一致', () => {
  const root = mkdtempSync(join(tmpdir(), 'kkb-order-'));
  try {
    let counter = 0;
    const session = openSession(root, {
      builtins: false,
      clientId: 'prop',
      clock: () => 1_700_000_000_000,
      newId: () => `c${(counter += 1)}`,
    });

    // 三个顺序型容器 + 一个 plain 容器，作为移动目标池
    const containers: CardId[] = ORDERED_LAYOUTS.map((layout) =>
      createCard(session, { parentId: null, title: `容器-${layout}`, layout }),
    );
    const plainBox = createCard(session, { parentId: null, title: '普通容器' });
    const boxed = new Set<CardId>([...containers, plainBox]);

    /**
     * 每次操作前**从状态里现算**候选叶卡。
     * 不能用自己维护的集合：`undo` 会把 card_create 撤掉，簿记当场失效
     * （第一版就是这么炸出"卡片不存在 c14"的）。
     */
    const liveLeaves = (): CardId[] =>
      [...session.state.cards.values()]
        .filter((fields) => !fields.deleted && !boxed.has(fields.id))
        .map((fields) => fields.id);

    const random = mulberry32(0x5eed);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;

    for (let step = 0; step < 400; step += 1) {
      const roll = random();
      const context = `step=${step}`;
      const leaves = liveLeaves();

      try {
      if (roll < 0.35 || leaves.length === 0) {
        // 建子卡：随机挂到某个顺序型容器，或建成根卡
        const parentId = random() < 0.85 ? pick(containers) : null;
        createCard(session, { parentId, title: `叶-${step}` });
      } else if (roll < 0.7) {
        // 移卡：随机挑一张叶卡，移到随机容器的随机下标
        const id = pick(leaves);
        const target = pick(containers);
        const count = (session.state.children.get(target) ?? []).length;
        const index = Math.floor(random() * (count + 1));
        const alreadyChild = session.state.children.get(target)?.some(entry => entry.id === id);
        if (session.state.cards.get(target)?.layout === 'columns' && !alreadyChild) {
          assert.throws(() => moveCard(session, id, target, index), /看板层级|固定三列/);
        } else moveCard(session, id, target, index);
      } else if (roll < 0.8) {
        // 浮动到桌面：toParent === null 那条路
        moveCard(session, pick(leaves), null, 0);
      } else if (roll < 0.88) {
        // 移到 plain 容器：条目形状要跟着换
        moveCard(session, pick(leaves), plainBox, 0);
      } else if (roll < 0.94) {
        // 改字段
        setField(session, pick(leaves), '/content', `正文 ${step}`);
      } else if (roll < 0.97) {
        // 删卡（软删）
        deleteCard(session, pick(leaves));
      } else {
        undoLast(session);
      }

      } catch (error) {
        assert.match(String(error), /看板固定三列/, context);
      }
      assertOrderInvariant(session, context);
    }

    // 落盘再读回来，不变量必须仍然成立（replay 与实时应用走的是同一个 reducer，
    // 但这条断言能顺带证明"文件写对了"）。
    const { state } = openWorkspace(root);
    assertOrderInvariant({ ...session, state }, '重新打开工作区后');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('把卡插到中间不会让 order 与数组下标脱钩（最小可读样例）', () => {
  const root = mkdtempSync(join(tmpdir(), 'kkb-order-min-'));
  try {
    let counter = 0;
    const session = openSession(root, {
      builtins: false,
      clientId: 't',
      clock: () => 0,
      newId: () => `c${(counter += 1)}`,
    });

    const parent = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
    const a = createCard(session, { parentId: parent, title: 'A' });
    const b = createCard(session, { parentId: parent, title: 'B' });
    const c = createCard(session, { parentId: parent, title: 'C' });
    const tail = createCard(session, { parentId: null, title: 'T' });

    moveCard(session, tail, parent, 1);

    const list = session.state.children.get(parent) as OrderedEntry[];
    assert.deepEqual(list.map((e) => e.id), [a, tail, b, c]);
    // 插到 A@0 与 B@1 之间 → 取中点 0.5。
    // 旧方案（order = 下标）会给出 [0, 1, 1, 2]，再插一次就与数组顺序分叉。
    assert.deepEqual(list.map((e) => e.order), [0, 0.5, 1, 2]);
    assertOrderInvariant(session, '插入中间之后');

    // 再往同一个位置连插，order 只会继续细分，顺序始终不变。
    const extra = createCard(session, { parentId: null, title: 'E' });
    const extra2 = createCard(session, { parentId: null, title: 'F' });
    moveCard(session, extra, parent, 1);
    moveCard(session, extra2, parent, 1);

    const after = session.state.children.get(parent) as OrderedEntry[];
    assert.deepEqual(after.map((e) => e.id), [a, extra2, extra, tail, b, c]);
    assert.deepEqual(after.map((e) => e.order), [0, 0.125, 0.25, 0.5, 1, 2]);
    assertOrderInvariant(session, '同一位置连插之后');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同父重排时 index 指的是"最终列表里的位置"，不是"摘除之后的位置"', () => {
  const root = mkdtempSync(join(tmpdir(), 'kkb-order-same-'));
  try {
    let counter = 0;
    const session = openSession(root, {
      builtins: false,
      clientId: 't',
      clock: () => 0,
      newId: () => `c${(counter += 1)}`,
    });

    const parent = createCard(session, { parentId: null, title: 'P', layout: 'ordered' });
    const a = createCard(session, { parentId: parent, title: 'A' });
    const b = createCard(session, { parentId: parent, title: 'B' });
    const c = createCard(session, { parentId: parent, title: 'C' });

    // 把 A 拖到最后一位：调用方说 index=2，期望结果是 [B, C, A]
    moveCard(session, a, parent, 2);
    assert.deepEqual(
      (session.state.children.get(parent) as OrderedEntry[]).map((e) => e.id),
      [b, c, a],
    );

    // 把 A 拖回第一位
    moveCard(session, a, parent, 0);
    assert.deepEqual(
      (session.state.children.get(parent) as OrderedEntry[]).map((e) => e.id),
      [a, b, c],
    );

    // 越界的 index 夹到最近的合法位置（拖过头就落到末尾），不是抛错
    moveCard(session, a, parent, 99);
    assert.deepEqual(
      (session.state.children.get(parent) as OrderedEntry[]).map((e) => e.id),
      [b, c, a],
    );

    assertOrderInvariant(session, '同父重排之后');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
