/**
 * CLI 的断言 —— 这一层的存在理由是"**能抛开 UI 直接测后端**"，
 * 所以它自己必须能被无头测：全部打在 `MemoryFs` 上，一个真进程都不起。
 *
 * 覆盖三块：
 *   1. `parseArgv` —— 参数解析（含错误输入）
 *   2. `resolveCard` —— 卡片引用怎么解析（id 优先，其次唯一标题）
 *   3. `runCli` —— 每个命令的**行为**，以及退出码
 *
 * 真进程那一层（读真实工作区目录、stdout）由 `main.ts` 承担，
 * 属于"命令行能做的验证"，交付时另行实跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/node/bootstrap.ts';
import { parseArgv } from '../src/cli/args.ts';
import { runCli } from '../src/cli/commands.ts';
import { openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { desktopCards } from '../src/core/windows.ts';
import { createMemoryFs } from '../src/platform/memory-fs-ops.ts';

function makeSession(): Session {
  let counter = 0;
  return openSession('/cli', {
    builtins: false,
    clientId: 'cli',
    ops: createMemoryFs().ops,
    clock: () => 0,
    newId: () => `auto${(counter += 1)}`,
  });
}

/** 跑一条命令，返回结果；`out` 已经把换行拼好了。 */
function cli(session: Session, ...argv: string[]): { code: number; out: string; err: string } {
  const result = runCli(() => session, argv);
  return { code: result.exitCode, out: result.out, err: result.err };
}

/** 跑一条命令并要求成功。 */
function ok(session: Session, ...argv: string[]): string {
  const result = cli(session, ...argv);
  assert.equal(result.code, 0, `命令 ${argv.join(' ')} 应当成功，实际：${result.err || result.out}`);
  return result.out;
}

/** 跑一条命令并要求失败，返回错误文本。 */
function bad(session: Session, ...argv: string[]): string {
  const result = cli(session, ...argv);
  assert.equal(result.code, 1, `命令 ${argv.join(' ')} 应当失败，实际输出：${result.out}`);
  return result.err;
}

// ── 参数解析 ─────────────────────────────────────────────────────────────────

test('parseArgv：位置参数 + 短选项', () => {
  const parsed = parseArgv(['create', 'Card2', '-p', 'Card1']);

  assert.equal(parsed.command, 'create');
  assert.deepEqual(parsed.positionals, ['Card2']);
  assert.equal(parsed.flags.get('parent'), 'Card1');
});

test('parseArgv：短选项的别名归一到长名', () => {
  const parsed = parseArgv(['edit', 'Card1', '-t', 'xxx', '-c', '正文']);

  assert.equal(parsed.flags.get('title'), 'xxx');
  assert.equal(parsed.flags.get('content'), '正文');
});

test('parseArgv：--long=value 与 --long value 两种写法等价', () => {
  const a = parseArgv(['create', 'X', '--parent', 'P']);
  const b = parseArgv(['create', 'X', '--parent=P']);

  assert.equal(a.flags.get('parent'), 'P');
  assert.equal(b.flags.get('parent'), 'P');
});

test('parseArgv：布尔选项没有值', () => {
  const parsed = parseArgv(['tree', '--json']);

  assert.equal(parsed.flags.get('json'), true);
  assert.equal(parsed.json, true);
});

test('parseArgv：--workspace 是全局选项，任何命令都认', () => {
  const parsed = parseArgv(['tree', '--workspace', 'D:/w']);

  assert.equal(parsed.workspace, 'D:/w');
});

test('parseArgv：全局选项写在**命令前面**也认得出命令（实测踩过）', () => {
  const parsed = parseArgv(['--workspace', 'D:/w', 'create', 'Card1', '-p', 'X']);

  assert.equal(parsed.command, 'create', '只认 argv[0] 的话这里会变成"没有命令"');
  assert.deepEqual(parsed.positionals, ['Card1']);
  assert.equal(parsed.flags.get('parent'), 'X');
  assert.equal(parsed.workspace, 'D:/w');
});

test('未知命令 / 看用法 / 参数不合法，都**不会打开工作区** —— 打错一个字不该动磁盘', () => {
  let opened = 0;
  const open = (): Session => {
    opened += 1;
    return makeSession();
  };

  assert.equal(runCli(open, ['frobnicate']).exitCode, 1);
  assert.equal(runCli(open, ['help']).exitCode, 0);
  assert.equal(runCli(open, ['--json']).exitCode, 0);
  assert.equal(runCli(open, ['tree', '--nope']).exitCode, 1);

  assert.equal(opened, 0, '这几条路径都不该开会话（开会话 = ensureBuiltins 会写盘）');
});

test('parseArgv：未知命令**不在这里报错** —— 交给 runCli 出"未知命令 + 用法"', () => {
  const parsed = parseArgv(['frobnicate', 'x']);

  assert.equal(parsed.command, 'frobnicate');
});

test('parseArgv：未知选项报错，并指出是哪一条', () => {
  assert.throws(() => parseArgv(['tree', '--nope']), /--nope/);
});

test('parseArgv：该带值的选项后面没值时报错，而不是把它当成布尔', () => {
  assert.throws(() => parseArgv(['edit', 'Card1', '-t']), /-t|--title/);
});

test('parseArgv：但后面真的是本命令的选项时，仍然报"缺少值"', () => {
  assert.throws(() => parseArgv(['edit', 'Card1', '-c', '-t', '标题']), /--content 缺少值/);
  assert.throws(() => parseArgv(['edit', 'Card1', '-c', '--json']), /--content 缺少值/);
});

// ── 卡片引用解析 ─────────────────────────────────────────────────────────────

test('create：位置参数就是**卡片 id**，标题默认与 id 相同', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');

  assert.deepEqual(desktopCards(session.state), ['Card1']);
  assert.equal(session.state.cards.get('Card1')?.title, 'Card1');
});

test('create -p：挂到父卡下；不写 -p 就是根卡（你给的那两条例子）', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'create', 'Card2', '-p', 'Card1');

  assert.deepEqual(desktopCards(session.state), ['Card1'], 'Card2 不是根卡');
  assert.deepEqual(
    (session.state.children.get('Card1') ?? []).map((entry) => entry.id),
    ['Card2'],
  );
});

test('create：id 重复直接失败，不覆盖已有的卡', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1', '-t', '原名');

  const message = bad(session, 'create', 'Card1');

  assert.match(message, /已存在|Card1/);
  assert.equal(session.state.cards.get('Card1')?.title, '原名', '不许被动过');
});

test('create -p：父卡不存在时报错', () => {
  const session = makeSession();

  assert.match(bad(session, 'create', 'Card2', '-p', '没有这张'), /没有这张/);
});

test('引用优先按 **id** 解析；id 不中时按**唯一标题**解析', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1', '-t', '去买菜');

  // 用 id
  assert.equal(ok(session, 'show', 'Card1').includes('Card1'), true);
  // 用标题
  assert.equal(ok(session, 'show', '去买菜').includes('Card1'), true);
});

test('标题不唯一时拒绝猜，并把候选列出来', () => {
  const session = makeSession();
  ok(session, 'create', 'A', '-t', '重名');
  ok(session, 'create', 'B', '-t', '重名');

  const message = bad(session, 'show', '重名');

  assert.match(message, /重名/);
  assert.match(message, /A/);
  assert.match(message, /B/);
});

test('不存在、或已删除的卡：报"找不到"，不当成空结果', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'delete', 'Card1');

  assert.match(bad(session, 'show', 'Card1'), /找不到|不存在|已删除/);
});

// ── edit ─────────────────────────────────────────────────────────────────────

test('edit -t 改标题', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'edit', 'Card1', '-t', 'xxx');

  assert.equal(session.state.cards.get('Card1')?.title, 'xxx');
});

test('edit -c 改正文', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'edit', 'Card1', '-c', '第一行\n第二行');

  assert.equal(session.state.cards.get('Card1')?.content, '第一行\n第二行');
});

test('edit 一个字段都不给时报错，而不是默默成功', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');

  assert.match(bad(session, 'edit', 'Card1'), /没有|给一个|-t/);
});

test('edit --layout 走 setLayout：条目形状跟着重写，重开工作区不报损坏', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'create', 'Card2', '-p', 'Card1');
  ok(session, 'edit', 'Card1', '--layout', 'columns');

  assert.equal(session.state.cards.get('Card1')?.layout, 'columns');
  assert.deepEqual(
    Object.keys(session.state.children.get('Card1')?.[0] ?? {}).sort(),
    ['id', 'order'],
    'columns 是顺序型，条目必须是 {id, order}',
  );
});

test('edit --set 能改任意字段（测数据层用的逃生口），值是 JSON', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'edit', 'Card1', '--set', '/isPrefab=true');

  assert.equal(session.state.cards.get('Card1')?.isPrefab, true);
});

test('edit 不许改 /id 与 /deleted（和 MCP 一样挡在外面）', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');

  assert.match(bad(session, 'edit', 'Card1', '--set', '/deleted=true'), /deleted|不允许|禁止/);
  assert.match(bad(session, 'edit', 'Card1', '--set', '/id=Other'), /id|不允许|禁止/);
});

test('edit --set 的值是严格 JSON：字符串要写成 JSON 字符串（shell 里难传，所以 -t/-c 才是正路）', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');

  ok(session, 'edit', 'Card1', '--set', '/title="用 --set 写的字符串"');
  assert.equal(session.state.cards.get('Card1')?.title, '用 --set 写的字符串');

  ok(session, 'edit', 'Card1', '--set', '/overrides=["a","b"]');
  assert.deepEqual(session.state.cards.get('Card1')?.overrides, ['a', 'b']);
});

test('edit --set 值不是合法 JSON 时，错误里说明"字符串请用 -t / -c"', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');

  const message = bad(session, 'edit', 'Card1', '--set', '/title=文字');

  assert.match(message, /-t \/ -c/);
  assert.equal(session.state.cards.get('Card1')?.title, 'Card1');
});

test('edit --set 类型不对：报错里带上用户写的那一条，且卡片没被改坏', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');

  // 这条命令曾经**成功地**把 number 写进 title，然后整个工作区再也打不开
  const message = bad(session, 'edit', 'Card1', '--set', '/title=123');

  assert.match(message, /--set \/title=123/);
  assert.match(message, /字符串/);
  assert.equal(session.state.cards.get('Card1')?.title, 'Card1', '标题不该被动过');
});

test('工作区读不出来时给一句人话（含"undo 也用不了"），而不是甩栈', () => {
  const result = runCli(() => {
    throw new Error('parseCard: 字段 title 应为字符串，实际是 number');
  }, ['tree']);

  assert.equal(result.exitCode, 1);
  assert.match(result.err, /读不出来/);
  assert.match(result.err, /title 应为字符串/);
  assert.match(result.err, /undo/);
});

// ── move / delete / undo ─────────────────────────────────────────────────────

test('move 不带 -p → 浮动到根（就是"提出到桌面"）', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'create', 'Card2', '-p', 'Card1');
  ok(session, 'move', 'Card2');

  assert.deepEqual(desktopCards(session.state), ['Card1', 'Card2']);
});

test('move -p 换父卡；移进自己的子树要失败（不许成环）', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'create', 'Card2', '-p', 'Card1');

  assert.match(bad(session, 'move', 'Card1', '-p', 'Card2'), /自己|环|子树/);
  ok(session, 'move', 'Card2', '-p', 'Card1');
});

test('delete 报出删了几张（级联），undo 能整棵恢复', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'create', 'Card2', '-p', 'Card1');
  ok(session, 'create', 'Card3', '-p', 'Card1');

  assert.match(ok(session, 'delete', 'Card1'), /3/);
  assert.deepEqual(desktopCards(session.state), []);

  ok(session, 'undo');
  assert.deepEqual(desktopCards(session.state), ['Card1']);
  assert.deepEqual(
    (session.state.children.get('Card1') ?? []).map((entry) => entry.id),
    ['Card2', 'Card3'],
  );
});

test('undo 在没得撤时也返回成功（只是什么都没撤），不当成错误', () => {
  const session = makeSession();

  const result = cli(session, 'undo');

  assert.equal(result.code, 0);
  assert.match(result.out, /没有|空/);
});

// ── 读命令 ───────────────────────────────────────────────────────────────────

test('ls：默认列根卡；给了卡片就列它的直接子卡', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'create', 'Card2', '-p', 'Card1');

  const roots = ok(session, 'ls');
  assert.match(roots, /Card1/);
  assert.ok(!roots.includes('Card2'), '根卡列表里不该出现子卡');

  assert.match(ok(session, 'ls', 'Card1'), /Card2/);
});

test('tree：缩进体现层级，子卡缩进比父卡深', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'create', 'Card2', '-p', 'Card1');

  const out = ok(session, 'tree');
  const parentLine = out.split('\n').find((line) => line.includes('Card1')) ?? '';
  const childLine = out.split('\n').find((line) => line.includes('Card2')) ?? '';

  assert.ok(parentLine.length > 0 && childLine.length > 0);
  assert.ok(
    childLine.search(/\S/) > parentLine.search(/\S/),
    `子卡应当缩进更深：\n${out}`,
  );
});

test('show：给出字段与直接子卡；不存在的卡失败', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1', '-t', '标题', '-c', '正文');
  ok(session, 'create', 'Card2', '-p', 'Card1');

  const out = ok(session, 'show', 'Card1');
  assert.match(out, /标题/);
  assert.match(out, /正文/);
  assert.match(out, /Card2/);
});

test('find：标题与正文都能命中', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1', '-t', '去买菜');
  ok(session, 'create', 'Card2', '-c', '顺便买牛奶');

  assert.match(ok(session, 'find', '买菜'), /Card1/);
  assert.match(ok(session, 'find', '牛奶'), /Card2/);
  assert.match(ok(session, 'find', '不存在的词'), /没有|0|空/);
});

test('path：给出从根到它的路径，卡片名与 id 都在', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1', '-t', '根');
  ok(session, 'create', 'Card2', '-p', 'Card1', '-t', '中');
  ok(session, 'create', 'Card3', '-p', 'Card2', '-t', '叶');

  const out = ok(session, 'path', 'Card3');

  assert.match(out, /Card1/);
  assert.match(out, /Card2/);
  assert.match(out, /Card3/);
});

test('windows：列出桌面卡片，并标出哪些开着窗口', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'create', 'Card2');

  const out = ok(session, 'windows');

  assert.match(out, /Card1/);
  assert.match(out, /Card2/);
  assert.match(out, /桌面卡片/);
});

test('log：按 seq 倒着给最近几条', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'edit', 'Card1', '-t', '改过');

  const out = ok(session, 'log', '--limit', '1');

  assert.match(out, /field_set/);
  assert.ok(!out.includes('card_create'), '只该给最近 1 条');
});

// ── check：这一整套存在的意义就是让后端"自证没跑偏" ────────────────────────

test('check：干净的工作区全部通过', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'create', 'Card2', '-p', 'Card1');

  const out = ok(session, 'check');

  assert.match(out, /不变量 U/);
  assert.match(out, /不变量 W/);
  assert.match(out, /通过|OK|✓/);
});

test('check：**撤销之后仍然通过** —— 日志被截断了，重放一致性不能被它误判', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');
  ok(session, 'create', 'Card2', '-p', 'Card1');
  ok(session, 'delete', 'Card2');
  ok(session, 'undo');

  const result = cli(session, 'check');

  assert.equal(result.code, 0, `撤销之后 check 应当仍然通过：${result.out}${result.err}`);
});

test('check：树被写坏时报出来并返回失败（护栏得有牙）', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');

  // 人为写坏：children 指向一张不存在的卡
  session.state = { ...session.state, children: new Map([['Card1', [{ id: 'ghost' }]]]) };

  const result = cli(session, 'check');

  assert.equal(result.code, 1);
  assert.match(`${result.out}${result.err}`, /ghost|不变量 W/);
});

// ── 输出与退出码 ─────────────────────────────────────────────────────────────

test('--json：输出是能被 JSON.parse 的单个对象，且带 ok 字段', () => {
  const session = makeSession();
  ok(session, 'create', 'Card1');

  const parsed = JSON.parse(ok(session, 'show', 'Card1', '--json')) as { ok: boolean; id: string };

  assert.equal(parsed.ok, true);
  assert.equal(parsed.id, 'Card1');
});

test('--json 下失败也走 stdout，让脚本能解析，同时退出码为 1', () => {
  const session = makeSession();
  const result = cli(session, 'show', '没有这张', '--json');

  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.out) as { ok: boolean; error: string };
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /没有这张/);
});

test('未知命令：退出码 1，并把可用命令列出来', () => {
  const session = makeSession();
  const result = cli(session, 'frobnicate');

  assert.equal(result.code, 1);
  assert.match(result.err, /frobnicate/);
  assert.match(result.err, /create/);
});

test('help：列出所有命令，退出码 0', () => {
  const session = makeSession();
  const result = cli(session, 'help');

  assert.equal(result.code, 0);
  for (const name of ['create', 'edit', 'move', 'delete', 'undo', 'tree', 'show', 'ls', 'find', 'path', 'windows', 'log', 'check']) {
    assert.match(result.out, new RegExp(name), `用法里应当有 ${name}`);
  }
});
