/**
 * `updatedAt` 的维护。
 *
 * 【缺陷】它原来只在建卡时被写一次，之后**再也没有人动过** ——
 * 于是 `show` 里"创建/更新"永远一样，磁盘上也一样，等于一个骗人的字段。
 *
 * 【定义】修完之后的规则只有一条，而且是**派生**的：
 *
 * ```
 * 一张卡的 updatedAt ≡ 指向它的最后一条事件的时间
 * ```
 *
 * 这条定义顺带回答了"什么算一次改动"：事件里 `cardId` 指谁，就是谁被改了。
 *
 * 【为什么要在撤销上一起做】`updatedAt` 一旦会动，就进入"撤销 == 前缀重放"的比较范围：
 * `undoEvent` 只看状态与那一条事件、看不到日志，不改的话撤销之后
 * `replay(剩余事件)` 会算出旧时间、而状态里是新时间 —— 重放一致性当场报红。
 * 这个文件里最硬的一条断言就是它（第 4 条）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { replay } from '../src/core/replay.ts';
import { stateFingerprint } from '../src/core/subtree.ts';
import {
  createCard,
  deleteCard,
  moveCard,
  openSession,
  setField,
  setLayout,
  undoLast,
} from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';
import { runCli } from '../src/cli/commands.ts';

/** 每次读时钟都前进 1000，好让"时间有没有动"看得见。 */
function makeSession(): Session {
  let counter = 0;
  let now = 1_000;
  return openSession('/w', {
    builtins: false,
    clientId: 't',
    ops: createMemoryFs().ops,
    clock: () => (now += 1_000),
    newId: () => `c${(counter += 1)}`,
  });
}

function updatedAt(session: Session, id: string): number {
  const card = session.state.cards.get(id);
  assert.ok(card !== undefined, `卡片 ${id} 应当存在`);
  return card.updatedAt;
}

function title(session: Session, id: string): string {
  return session.state.cards.get(id)?.title ?? '';
}

// ── 基本行为 ─────────────────────────────────────────────────────────────────

test('新建的卡：updatedAt 等于 createdAt（那一刻它同时是"创建"也是"最后改动"）', () => {
  const session = makeSession();
  const id = createCard(session, { parentId: null, title: '卡' });
  const card = session.state.cards.get(id);

  assert.ok(card !== undefined);
  assert.equal(card.updatedAt, card.createdAt);
});

test('改标题：updatedAt 前进，createdAt 一动不动', () => {
  const session = makeSession();
  const id = createCard(session, { parentId: null, title: '原名' });
  const createdAt = session.state.cards.get(id)?.createdAt ?? 0;
  const before = updatedAt(session, id);

  setField(session, id, '/title', '改过');

  assert.ok(updatedAt(session, id) > before, `updatedAt 应当前进：${before} → ${updatedAt(session, id)}`);
  assert.equal(session.state.cards.get(id)?.createdAt, createdAt, 'createdAt 是出身时间，不许跟着变');
});

test('改正文也一样推进（这条就是用户报的那个现象）', () => {
  const session = makeSession();
  const id = createCard(session, { parentId: null, title: '卡' });
  const before = updatedAt(session, id);

  setField(session, id, '/content', '正文');

  assert.ok(updatedAt(session, id) > before);
});

test('**每一种**改动这张卡的事件都推进它：layout / move / delete', () => {
  const session = makeSession();

  const layoutCard = createCard(session, { parentId: null, title: '改布局' });
  const beforeLayout = updatedAt(session, layoutCard);
  setLayout(session, layoutCard, 'ordered');
  assert.ok(updatedAt(session, layoutCard) > beforeLayout, 'layout_change 应当推进');

  const root = createCard(session, { parentId: null, title: '父' });
  const mover = createCard(session, { parentId: null, title: '要移的' });
  const beforeMove = updatedAt(session, mover);
  moveCard(session, mover, root, 0);
  assert.ok(updatedAt(session, mover) > beforeMove, 'card_move 应当推进');

  const doomed = createCard(session, { parentId: null, title: '要删的' });
  const beforeDelete = updatedAt(session, doomed);
  deleteCard(session, doomed);
  assert.ok(updatedAt(session, doomed) > beforeDelete, 'card_delete 应当推进');
});

test('值没变时不产生事件，也就不该推进（空操作不该刷新时间）', () => {
  const session = makeSession();
  const id = createCard(session, { parentId: null, title: '同名' });
  const before = updatedAt(session, id);

  setField(session, id, '/title', '同名');

  assert.equal(updatedAt(session, id), before);
  assert.equal(title(session, id), '同名');
});

test('时钟回拨也不许把更新时间往回退', () => {
  let counter = 0;
  let now = 5_000;
  const session = openSession('/w', {
    builtins: false,
    clientId: 't',
    ops: createMemoryFs().ops,
    // 每次读时钟都**倒退** 1000
    clock: () => (now -= 1_000),
    newId: () => `c${(counter += 1)}`,
  });

  const id = createCard(session, { parentId: null, title: '卡' });
  const before = updatedAt(session, id);

  setField(session, id, '/title', '改过');

  assert.equal(updatedAt(session, id), before, '时间戳倒退不该让 updatedAt 跟着退');
});

// ── 与撤销 / 重放一致性的一致性（最硬的一条） ──────────────────────────────

test('撤销之后 updatedAt 回到改动之前的值', () => {
  const session = makeSession();
  const id = createCard(session, { parentId: null, title: '原名' });
  const before = updatedAt(session, id);

  setField(session, id, '/title', '改过');
  assert.ok(updatedAt(session, id) > before);

  assert.equal(undoLast(session), true);

  assert.equal(updatedAt(session, id), before, '撤销必须把更新时间也对回去');
  assert.equal(title(session, id), '原名');
});

test('**撤销之后 state ≡ replay(剩余事件)** —— 重放一致性不能被 updatedAt 打破', () => {
  const session = makeSession();
  const id = createCard(session, { parentId: null, title: '原名' });
  setField(session, id, '/title', '改一次');
  setField(session, id, '/content', '改两次');
  setLayout(session, id, 'ordered');
  setField(session, id, '/title', '改三次');

  // 连撤四次：每一步都必须与"前缀重放"逐字段等价
  for (let step = 0; step < 4; step += 1) {
    assert.equal(undoLast(session), true);
    assert.equal(
      stateFingerprint(session.state),
      stateFingerprint(replay(session.events)),
      `第 ${step + 1} 次撤销之后，状态与剩余事件的重放结果不一致`,
    );
  }
});

test('撤销一次建卡：卡整个消失，不该留下半张带时间的卡', () => {
  const session = makeSession();
  const id = createCard(session, { parentId: null, title: '待撤' });

  assert.equal(undoLast(session), true);

  assert.equal(session.state.cards.has(id), false);
  assert.equal(
    stateFingerprint(session.state),
    stateFingerprint(replay(session.events)),
  );
});

// ── 它是派生的，所以不能手改 ─────────────────────────────────────────────────

test('/updatedAt 不允许直接写：它是派生的，写了也会被事件时间覆盖', () => {
  const session = makeSession();
  const id = createCard(session, { parentId: null, title: '卡' });

  assert.throws(() => setField(session, id, '/updatedAt', 123), /updatedAt|派生/);
});

// ── 旧工作区（老语义写下的数据）也要自洽 ─────────────────────────────────────

/**
 * 造一份"老代码写的"日志：**没有 `prevUpdatedAt`**，卡片文件里的 `updatedAt` 还等于 `createdAt`。
 * 这正是你真实工作区的样子（22 条事件全是这样），也是 `check` 当时报红的原因。
 */
function legacyWorkspace(): { ops: ReturnType<typeof createMemoryFs>['ops']; id: string } {
  const memoryFs = createMemoryFs();
  const ops = memoryFs.ops;
  const id = 'Card1';

  ops.mkdirp('/old/.kkb/cards');
  ops.writeFile(
    '/old/.kkb/tree.json',
    JSON.stringify({ version: 1, lastAppliedSeq: 2, cards: [id], children: {} }),
  );
  ops.writeFile(
    `/old/.kkb/cards/${id}.md`,
    [
      '---',
      `id: "${id}"`,
      // 状态要与 `lastAppliedSeq: 2` 自洽：e2 已经把标题改成"改过"
      'title: "改过"',
      'type: null',
      'layout: "plain"',
      'isPrefab: false',
      'prefabRef: null',
      'overrides: []',
      'createdAt: 1000',
      // 老语义：它永远等于 createdAt
      'updatedAt: 1000',
      'createdBy: "old"',
      'editingBy: null',
      'deleted: false',
      '---',
      // 紧跟结束围栏就是正文 —— 与真实写入格式一致（多插空行会让正文多出换行）
      '老正文',
    ].join('\n'),
  );
  // 两条老事件：建卡（ts 1000）与改标题（ts 2000），都没有 prevUpdatedAt
  const rows = [
    { id: 'e1', seq: 1, clientId: 'old', timestamp: 1000, cardId: id, type: 'card_create', parentId: null, entry: null,
      fields: { id, title: '老卡', content: '老正文', type: null, layout: 'plain', isPrefab: false, prefabRef: null,
        overrides: [], createdAt: 1000, updatedAt: 1000, createdBy: 'old', editingBy: null, deleted: false } },
    { id: 'e2', seq: 2, clientId: 'old', timestamp: 2000, cardId: id, type: 'field_set', path: '/title', from: '老卡', to: '改过' },
  ];
  ops.writeFile('/old/.kkb/events.jsonl', `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  return { ops, id };
}

test('打开旧工作区：按日志把 updatedAt 物化回来，于是 check 的重放一致性不再误报', () => {
  const { ops, id } = legacyWorkspace();

  const session = openSession('/old', { clientId: 't', ops, builtins: false });

  assert.equal(session.state.cards.get(id)?.updatedAt, 2000, '老日志里它的最后一条事件是 e2');
  assert.equal(
    stateFingerprint(session.state),
    stateFingerprint(replay(session.events)),
    '物化之后应当与重放结果逐字段一致',
  );
});

test('撤销**旧日志**里的最后一条：updatedAt 也要退回去（没有 prevUpdatedAt 时按剩余日志重算）', () => {
  const { ops, id } = legacyWorkspace();
  const session = openSession('/old', { clientId: 't', ops, builtins: false });

  assert.equal(undoLast(session), true);

  assert.equal(session.state.cards.get(id)?.updatedAt, 1000, '退回 e1 的时间');
  assert.equal(
    stateFingerprint(session.state),
    stateFingerprint(replay(session.events)),
    '撤销之后仍然必须与剩余日志的重放一致',
  );
});

// ── 读操作不该改它 ───────────────────────────────────────────────────────────

test('读操作（列子卡 / 读树 / 搜索结果）一个字节都不改', () => {
  const session = makeSession();
  const id = createCard(session, { parentId: null, title: '卡' });
  createCard(session, { parentId: id, title: '子' });
  const before = updatedAt(session, id);

  // 直接读模型：它们不该产生事件，也不该改任何字段
  session.state.children.get(id);
  session.state.cards.get(id);

  assert.equal(updatedAt(session, id), before);
  assert.equal(session.events.length, 2, '没有新事件');
});

// ── CLI 上能看见（用户就是从这里发现问题的） ─────────────────────────────────

test('CLI 的 show：改过之后"创建/更新"两个时间必须不一样', () => {
  const session = makeSession();
  const created = runCli(() => session, ['create', 'Card1', '-t', '卡']);
  assert.equal(created.exitCode, 0, created.err);

  const before = runCli(() => session, ['show', 'Card1']).out;

  // 没动过：两个时间相同
  const sameLine = before.split('\n').find((line) => line.includes('创建/更新')) ?? '';
  const [createdShown, updatedShown] = sameLine.replace('创建/更新', '').trim().split(' / ');
  assert.equal(createdShown, updatedShown, `没改过时两个时间应当相同：${sameLine}`);

  // 改一次
  const edited = runCli(() => session, ['edit', 'Card1', '-t', '改过']);
  assert.equal(edited.exitCode, 0, edited.err);

  const after = runCli(() => session, ['show', 'Card1']).out;
  const changedLine = after.split('\n').find((line) => line.includes('创建/更新')) ?? '';
  const [c2, u2] = changedLine.replace('创建/更新', '').trim().split(' / ');
  assert.equal(c2, createdShown, '创建时间不许变');
  assert.notEqual(u2, c2, `改过之后更新时间必须不一样：${changedLine}`);
});
