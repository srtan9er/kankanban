/**
 * §8 / §6.1：`.kkb` 默认进 `.gitignore`。
 *
 * §6.1 把理由写死了：`events.jsonl` append-only、`tree.json` 整文件 JSON，
 * 两人各改一处**必然冲突**，而 §4.2 的"后写覆盖"模型**对 git merge 不适用**。
 * 所以这件事不是"顺手加一行"，而是**数据模型选了这套存储之后必须做的配套**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { ensureGitignoreEntry, GITIGNORE_MARKER } from '../src/core/storage/gitignore.ts';
import { KKB_DIR } from '../src/core/storage/workspace-io.ts';
import { openSession } from '../src/core/workspace.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

const ROOT = '/ws';
const GITIGNORE = `${ROOT}/.gitignore`;

function fresh() {
  const memory = createMemoryFs();
  // 工作区根目录本来就在 —— `ensureGitignoreEntry` 的前提是"这个目录存在"，
  // 它只负责往 .gitignore 里加一行，不负责建工作区。
  memory.ops.mkdirp(ROOT);
  return { memory, ops: memory.ops };
}

// ── 直接调用的行为 ─────────────────────────────────────────────────────────────

test('没有 .gitignore 就建一个，里面忽略 .kkb/', () => {
  const { ops } = fresh();

  assert.equal(ensureGitignoreEntry(ROOT, ops), true);
  assert.equal(ops.readFile(GITIGNORE), `${GITIGNORE_MARKER}\n.kkb/\n`);
});

test('已经忽略 .kkb/ 时不动它，返回 false', () => {
  const { memory, ops } = fresh();
  memory.poke(GITIGNORE, `.kkb/\n`);
  const before = ops.readFile(GITIGNORE);

  assert.equal(ensureGitignoreEntry(ROOT, ops), false);
  assert.equal(ops.readFile(GITIGNORE), before, '一个字都不该改');
});

test('用户自己写成 .kkb 或 /.kkb 也算数（不重复追加）', () => {
  for (const line of ['.kkb', '/.kkb', '  .kkb/  ']) {
    const { memory, ops } = fresh();
    memory.poke(GITIGNORE, `${line}\n`);

    assert.equal(ensureGitignoreEntry(ROOT, ops), false, `${JSON.stringify(line)} 应当被认出来`);
  }
});

test('已有其它规则时保留原内容，只追加', () => {
  const { memory, ops } = fresh();
  memory.poke(GITIGNORE, 'node_modules/\n*.log\n');

  assert.equal(ensureGitignoreEntry(ROOT, ops), true);
  const text = ops.readFile(GITIGNORE);
  assert.ok(text.startsWith('node_modules/\n*.log\n'), '用户原有内容必须在前面');
  assert.ok(text.includes('.kkb/'));
});

test('原有文件不以换行结尾时不会把新块粘到上一行', () => {
  const { memory, ops } = fresh();
  memory.poke(GITIGNORE, 'node_modules/');

  ensureGitignoreEntry(ROOT, ops);

  const lines = ops.readFile(GITIGNORE).split('\n');
  assert.equal(lines[0], 'node_modules/', '原最后一行不能被污染');
  assert.ok(lines.includes('.kkb/'));
});

test('空 .gitignore 也能正确处理', () => {
  const { memory, ops } = fresh();
  memory.poke(GITIGNORE, '');

  assert.equal(ensureGitignoreEntry(ROOT, ops), true);
  assert.ok(ops.readFile(GITIGNORE).includes('.kkb/'));
});

test('连做两次是幂等的', () => {
  const { ops } = fresh();

  assert.equal(ensureGitignoreEntry(ROOT, ops), true);
  const once = ops.readFile(GITIGNORE);
  assert.equal(ensureGitignoreEntry(ROOT, ops), false);
  assert.equal(ops.readFile(GITIGNORE), once);
});

// ── 接进 openSession ───────────────────────────────────────────────────────────

test('打开全新工作区会写 .gitignore', () => {
  const { memory, ops } = fresh();
  let counter = 0;

  openSession(ROOT, { clientId: 't', ops, clock: () => 0, newId: () => `c${(counter += 1)}` });

  assert.equal(ops.exists(GITIGNORE), true);
  assert.match(ops.readFile(GITIGNORE), /^\.kkb\/$/m);
  assert.equal(ops.exists(`${ROOT}/${KKB_DIR}`), true, '工作区目录照常建');
  void memory;
});

test('重开已有工作区不再碰 .gitignore（用户后来改了也不覆盖）', () => {
  const { memory, ops } = fresh();
  let counter = 0;
  const opts = { clientId: 't', ops, clock: () => 0, newId: () => `c${(counter += 1)}` };

  openSession(ROOT, opts);
  // 用户手动把标记行删掉、只留自己的规则
  memory.poke(GITIGNORE, 'my-own-rule/\n');

  openSession(ROOT, opts);

  assert.equal(ops.readFile(GITIGNORE), 'my-own-rule/\n', '重开不该又追加一次');
});

test('§6.1 的另一半：.kkb 本身不会被写进工作区的可见文件里（它就在 .kkb 下）', () => {
  const { ops } = fresh();
  let counter = 0;
  openSession(ROOT, { clientId: 't', ops, clock: () => 0, newId: () => `c${(counter += 1)}` });

  // 工作区根目录下除了 .kkb/ 与 .gitignore，不该有别的状态文件
  const rootEntries = ops.readDir(ROOT).sort();
  assert.deepEqual(rootEntries, ['.gitignore', '.kkb']);
  void KKB_DIR;
});
