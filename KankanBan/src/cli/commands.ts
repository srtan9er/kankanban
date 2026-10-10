import {uiText} from '../i18n/text.ts';
/**
 * CLI 命令实现 —— 全部打在这一层已有的操作 / 读模型上（`workspace.ts`），
 * **不新造语义**：`create` 就是 `createCard`，`edit --layout` 就是 `setLayout`，
 * `check` 就是 `replay` + `assertInvariantW`。
 *
 * 【为什么值得有这一层】UI 是验证后端时最不该挡路的一层 —— 窗口、渲染、IPC
 * 任何一个环节出问题，都会让你分不清"后端错了"还是"界面错了"。CLI 把这条链路砍到
 * "一条命令 → 一次 core 调用 → 磁盘上一次 WAL 写入"，于是后端对不对一眼可见。
 *
 * 【它不做的事】不写自己的数据模型、不做缓存、不绕过 `emit`。
 * 每个写命令都立刻落盘（`emit` 里就是 `appendEvents` + `writeState`，§4.2），
 * 所以跑完命令直接开应用看到的就是同一个状态。
 */

import { BUILTIN_CARDS } from '../core/builtins.ts';
import { parentIndexOf } from '../core/indexes.ts';
import { replay } from '../core/replay.ts';
import { stateFingerprint } from '../core/subtree.ts';
import type { CardId, Layout } from '../core/types.ts';
import { readViewState } from '../core/view-state.ts';
import { assertInvariantW, desktopCards, openWindowSet } from '../core/windows.ts';
import {
  createCard,
  deleteCard,
  listChildren,
  moveCard,
  readCard,
  readTree,
  search,
  setField,
  setLayout,
  subtreeSize,
  undoLast,
  type CardSummary,
  type PlanePlacement,
  type TreeNode,
} from '../core/workspace.ts';
import type { Session } from '../core/workspace.ts';
import {
  flagNumber,
  flagText,
  flagTexts,
  isLayout,
  LAYOUTS,
  parseArgv,
  positional,
  positionalAtMostOne,
  usageText,
  commandSpec,
  type Parsed,
} from './args.ts';

export type CliResult = { exitCode: number; out: string; err: string };

/** 命令的产物：`text` 给人看，`data` 给 `--json` 用。 */
type Outcome = {
  text: string[];
  data: Record<string, unknown>;
  /** 只在"命令跑完了但结果是失败"时给（目前只有 `check`） */
  exitCode?: number;
};

type Handler = (session: Session, parsed: Parsed) => Outcome;

const DEFAULT_LOG_LIMIT = 10;

// ── 卡片引用 ─────────────────────────────────────────────────────────────────

/**
 * 把用户写的一串字符解析成卡片 id。
 *
 * 顺序是**先 id、后唯一标题**：id 是我们自己给的（`create` 的位置参数就是 id），
 * 标题是人写的；两者都能用，但 id 优先 —— 否则一张标题恰好等于另一张 id 的卡
 * 会把指向搞混。
 *
 * 标题命中多张时**拒绝猜**并列出候选：猜错会改到别的卡，而"改错卡"是最难发现的错。
 */
export function resolveCard(state: Session['state'], ref: string): CardId {
  const live = state.cards.get(ref);
  if (live !== undefined && !live.deleted) return ref;

  const hits = [...state.cards.values()]
    .filter((card) => !card.deleted && card.title === ref)
    .map((card) => card.id)
    .sort();

  const first = hits[0];
  if (hits.length === 1 && first !== undefined) return first;

  if (hits.length > 1) {
    const list = hits.map((id) => `  ${id}  ${state.cards.get(id)?.title ?? ''}`).join('\n');
    throw new Error(uiText("cli/commands.text001", {arg0: (ref), arg1: (list)}));
  }

  throw new Error(uiText("cli/commands.text002", {arg0: (ref)}));
}

// ── 输出小工具 ───────────────────────────────────────────────────────────────

const label = (summary: { id: CardId; title: string; layout: Layout }): string => {
  const layout = summary.layout === 'plain' ? '' : `  (${summary.layout})`;
  return `${summary.id}  ${summary.title}${layout}`;
};

/** epoch 毫秒 → `2026-09-24 15:00:00`（本地时区）。裸毫秒人读不了。 */
function stamp(ms: number): string {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return String(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

// ── 写命令 ───────────────────────────────────────────────────────────────────

/** 平面坐标：五个都给才算，只给一部分是错，不给就是不适用。 */
function planeOf(parsed: Parsed): PlanePlacement | undefined {
  const names = ['x', 'y', 'w', 'h', 'z'] as const;
  const given = names.filter((name) => flagText(parsed, name) !== undefined);
  if (given.length === 0) return undefined;
  if (given.length !== names.length) {
    throw new Error(uiText("cli/commands.text003", {arg0: (given.map((n) => `--${n}`).join(' '))}));
  }
  const point = (name: (typeof names)[number]): number => {
    const raw = flagText(parsed, name) ?? '';
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(uiText("cli/commands.text004", {arg0: (name), arg1: (raw)}));
    return value;
  };
  return { x: point('x'), y: point('y'), w: point('w'), h: point('h'), z: point('z') };
}

function layoutFlag(parsed: Parsed): Layout | undefined {
  const raw = flagText(parsed, 'layout');
  if (raw === undefined) return undefined;
  if (!isLayout(raw)) throw new Error(uiText("cli/commands.text005", {arg0: (LAYOUTS.join(' / ')), arg1: (raw)}));
  return raw;
}

const create: Handler = (session, parsed) => {
  const id = positional(parsed, 0, commandSpec('create')?.usage ?? '', uiText("cli/commands.text006"));
  const parentRef = flagText(parsed, 'parent');
  const typeRef = flagText(parsed, 'type');

  const parentId = parentRef === undefined ? null : resolveCard(session.state, parentRef);
  const type = typeRef === undefined ? undefined : resolveCard(session.state, typeRef);
  const title = flagText(parsed, 'title') ?? id;

  createCard(session, {
    id,
    parentId,
    title,
    content: flagText(parsed, 'content'),
    layout: layoutFlag(parsed),
    type,
    plane: planeOf(parsed),
  });

  return {
    text: [uiText("cli/commands.text009", {arg0: (id), arg1: (title), arg2: (parentId === null ? uiText("cli/commands.text007") : uiText("cli/commands.text008", {arg0: (parentId)}))})],
    data: { id, title, parentId },
  };
};

const edit: Handler = (session, parsed) => {
  const id = resolveCard(session.state, positional(parsed, 0, commandSpec('edit')?.usage ?? '', uiText("cli/commands.text010")));
  const title = flagText(parsed, 'title');
  const content = flagText(parsed, 'content');
  const layout = layoutFlag(parsed);
  const sets = flagTexts(parsed, 'set');

  if (title === undefined && content === undefined && layout === undefined && sets.length === 0) {
    throw new Error(uiText("cli/commands.text011"));
  }

  const changed: string[] = [];

  // 先 layout：它会连带重写子卡条目（§2.4.1），放在字段改动前面更靠近"结构先定、内容后填"
  if (layout !== undefined) {
    setLayout(session, id, layout);
    changed.push(`layout=${layout}`);
  }
  if (title !== undefined) {
    setField(session, id, '/title', title);
    changed.push('title');
  }
  if (content !== undefined) {
    setField(session, id, '/content', content);
    changed.push('content');
  }
  for (const raw of sets) {
    const { path, value } = parseSet(raw);
    try {
      setField(session, id, path, value);
    } catch (error) {
      // 把用户写的那一条原样带上：否则"需要字符串，实际是 number"很难对回是哪个 --set
      throw new Error(uiText("cli/commands.text012", {arg0: (raw), arg1: (error instanceof Error ? error.message : String(error))}));
    }
    changed.push(path);
  }

  return {
    text: [uiText("cli/commands.text013", {arg0: (id), arg1: (changed.join('、'))})],
    data: { id, changed, layout: session.state.cards.get(id)?.layout },
  };
};

/**
 * `--set /字段=JSON`。
 *
 * 值是 **JSON**，不是"看起来像就自动转"：`/title=123` 会被拒，
 * 因为静默存进去一个数字比报错难查得多（字符串请写 `/title="123"`）。
 */
function parseSet(raw: string): { path: `/${string}`; value: unknown } {
  const eq = raw.indexOf('=');
  if (eq <= 0) throw new Error(uiText("cli/commands.text014", {arg0: (raw)}));
  const head = raw.slice(0, eq);
  if (!head.startsWith('/')) throw new Error(uiText("cli/commands.text015", {arg0: (head)}));
  // 上面刚证明过它以 / 开头 —— 但 TS 不会把 `startsWith` 收窄成模板字面量类型
  const path = head as `/${string}`;
  const rawValue = raw.slice(eq + 1);
  try {
    return { path, value: JSON.parse(rawValue) as unknown };
  } catch {
    throw new Error(
      uiText("cli/commands.text016", {arg0: (path), arg1: (rawValue)}) +
        uiText("cli/commands.text017"),
    );
  }
}

const move: Handler = (session, parsed) => {
  const id = resolveCard(session.state, positional(parsed, 0, commandSpec('move')?.usage ?? '', uiText("cli/commands.text010")));
  const parentRef = flagText(parsed, 'parent');
  const parentId = parentRef === undefined ? null : resolveCard(session.state, parentRef);

  // 默认追加到末尾：拿目标父卡当前的子卡数当下标，越界由 `moveCard` 夹到最近合法位置
  const fallback = parentId === null ? 0 : (session.state.children.get(parentId) ?? []).length;

  moveCard(session, id, parentId, flagNumber(parsed, 'index', fallback), planeOf(parsed));

  return {
    text: [uiText("cli/commands.text020", {arg0: (id), arg1: (parentId === null ? uiText("cli/commands.text018") : uiText("cli/commands.text019", {arg0: (parentId)}))})],
    data: { id, parentId },
  };
};

const remove: Handler = (session, parsed) => {
  const id = resolveCard(session.state, positional(parsed, 0, commandSpec('delete')?.usage ?? '', uiText("cli/commands.text010")));
  const count = subtreeSize(session, id);

  deleteCard(session, id);

  return {
    text: [uiText("cli/commands.text021", {arg0: (id), arg1: (count)})],
    data: { id, removed: count },
  };
};

const undo: Handler = (session) => {
  const undone = undoLast(session);
  return {
    text: [undone ? uiText("cli/commands.text022", {arg0: (session.events.length)}) : uiText("cli/commands.text023")],
    data: { undone, events: session.events.length },
  };
};

// ── 读命令 ───────────────────────────────────────────────────────────────────

function renderNode(node: TreeNode, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const lines = [`${pad}${label(node)}${node.truncated ? uiText("cli/commands.text024") : ''}`];
  for (const child of node.children) lines.push(...renderNode(child, depth + 1));
  return lines;
}

const tree: Handler = (session, parsed) => {
  const depth = flagNumber(parsed, 'depth', 2);
  const { nodes } = readTree(session, { maxDepth: depth });

  const lines = nodes.length === 0 ? [uiText("cli/commands.text025")] : nodes.flatMap((node) => renderNode(node, 0));
  return { text: lines, data: { depth, nodes } };
};

const show: Handler = (session, parsed) => {
  const id = resolveCard(session.state, positional(parsed, 0, commandSpec('show')?.usage ?? '', uiText("cli/commands.text010")));
  const card = readCard(session, id, { includeChildren: true });
  const children = card.children ?? [];

  const lines = [
    label(card),
    uiText('cli/commands.layoutLine',{arg0:card.layout}),
    uiText('cli/commands.typeLine',{arg0:card.type ?? '—'}),
    uiText('cli/commands.prefabLine',{arg0:uiText(card.isPrefab?'cli/commands.yes':'cli/commands.no'),arg1:card.prefabRef===null?'':`  ← ${card.prefabRef}`}),
    uiText("cli/commands.text026", {arg0: (stamp(card.createdAt)), arg1: (stamp(card.updatedAt))}),
    uiText("cli/commands.text027", {arg0: (card.createdBy)}),
    '',
    uiText("cli/commands.text028"),
    ...(card.content.trim() === '' ? [uiText("cli/commands.text029")] : card.content.split('\n').map((line) => `    ${line}`)),
    '',
    uiText("cli/commands.text030", {arg0: (children.length)}),
  ];

  for (const entry of children) {
    const child = session.state.cards.get(entry.id);
    lines.push(`    ${child === undefined ? entry.id : label(child)}`);
  }
  if (children.length === 0) lines.push(uiText("cli/commands.text031"));

  return { text: lines, data: { ...card } };
};

const ls: Handler = (session, parsed) => {
  const ref = positionalAtMostOne(parsed, commandSpec('ls')?.usage ?? '');
  const limit = flagNumber(parsed, 'limit', 50);

  if (ref === undefined) {
    const roots = desktopCards(session.state);
    return {
      text: roots.length === 0 ? [uiText("cli/commands.text032")] : roots.map((id) => label(mustSummary(session, id))),
      data: { roots },
    };
  }

  const id = resolveCard(session.state, ref);
  const { entries, nextCursor } = listChildren(session, id, { limit });
  const lines = entries.map((entry) => label(mustSummary(session, entry.id)));
  if (lines.length === 0) lines.push(uiText("cli/commands.text033"));
  if (nextCursor !== undefined) lines.push(uiText("cli/commands.text034", {arg0: (nextCursor)}));

  return { text: lines, data: { parentId: id, entries, nextCursor } };
};

function mustSummary(session: Session, id: CardId): CardSummary {
  const card = session.state.cards.get(id);
  if (card === undefined) throw new Error(uiText("cli/commands.text035", {arg0: (id)}));
  return { id: card.id, title: card.title, layout: card.layout, deleted: card.deleted };
}

const find: Handler = (session, parsed) => {
  const query = positional(parsed, 0, commandSpec('find')?.usage ?? '', uiText("cli/commands.text036"));
  const { items } = search(session, query, { limit: flagNumber(parsed, 'limit', 20) });

  return {
    text: items.length === 0 ? [uiText("cli/commands.text037", {arg0: (query)})] : items.map((item) => label(item)),
    data: { query, items },
  };
};

const path: Handler = (session, parsed) => {
  const id = resolveCard(session.state, positional(parsed, 0, commandSpec('path')?.usage ?? '', uiText("cli/commands.text010")));

  const parents = parentIndexOf(session.state);
  const chain: CardId[] = [id];
  let cursor = id;
  for (;;) {
    const parent = parents.get(cursor);
    if (parent === undefined) break;
    chain.unshift(parent);
    cursor = parent;
  }

  return {
    text: [
      chain.map((cardId) => label(mustSummary(session, cardId))).join('\n  / '),
      uiText("cli/commands.text039", {arg0: (chain.length - 1), arg1: (chain.length === 1 ? uiText("cli/commands.text038") : '')}),
    ],
    data: { id, chain },
  };
};

const windows: Handler = (session) => {
  const state = session.state;
  const view = readViewState(session.root, session.ops);
  const open = new Set(openWindowSet(state, view.openWindows));
  const roots = desktopCards(state);

  const lines = [uiText("cli/commands.text040", {arg0: (roots.length)})];
  for (const id of roots) {
    lines.push(`  ${open.has(id) ? '●' : '○'} ${label(mustSummary(session, id))}`);
  }
  lines.push('', uiText("cli/commands.text042", {arg0: ([...open].join(' ') || uiText("cli/commands.text041"))}));
  lines.push(uiText("cli/commands.text044", {arg0: (view.openWindows.join(' ') || uiText("cli/commands.text043"))}));

  return {
    text: lines,
    data: { desktopCards: roots, openWindows: [...open], remembered: view.openWindows },
  };
};

const log: Handler = (session, parsed) => {
  const limit = flagNumber(parsed, 'limit', DEFAULT_LOG_LIMIT);
  const recent = session.events.slice(-limit).reverse();

  const lines =
    recent.length === 0
      ? [uiText("cli/commands.text045")]
      : recent.map((event) => `#${event.seq}  ${event.type}  ${event.cardId}`);

  return { text: lines, data: { limit, total: session.events.length, events: recent } };
};

/**
 * 自检 —— 这一整套工具真正的意义所在：**让后端自证没跑偏**。
 *
 * 比的是两件事：
 *   - **不变量 U**：`replay(空, events)` 与当前状态逐字段等价
 *   - **不变量 W′**：开着的窗口都是桌面卡片，且 main 没丢
 *
 * `lastAppliedSeq` **刻意不参与比较**：撤销是"状态级逆运算 + 截断日志"（§4.4），
 * 回滚后的 seq 会停在被撤销的那条事件上，而日志里已经没有它了 —— 把它一起比，
 * 每一次正常的撤销都会被判成重放不一致（实测踩过）。
 */
const check: Handler = (session) => {
  const state = session.state;
  const lines: string[] = [];
  const data: Record<string, unknown> = {};
  let failed = false;

  const replayed = replay(session.events);
  const same = stateFingerprint(state) === stateFingerprint(replayed);
  lines.push(uiText("cli/commands.text048", {arg0: (same ? '✓' : '✗'), arg1: (session.events.length), arg2: (same ? uiText("cli/commands.text046") : uiText("cli/commands.text047"))}));
  data['replayConsistent'] = same;
  if (!same) failed = true;

  try {
    assertInvariantW(state, uiText("cli/commands.text049"), openWindowSet(state, readViewState(session.root, session.ops).openWindows));
    lines.push(uiText("cli/commands.text050"));
    data['invariantW'] = true;
  } catch (error) {
    lines.push(uiText("cli/commands.text051", {arg0: (error instanceof Error ? error.message : String(error))}));
    data['invariantW'] = false;
    failed = true;
  }

  const missing = BUILTIN_CARDS.filter((card) => !state.cards.has(card.id)).map((card) => card.id);
  lines.push(
    missing.length === 0
      ? uiText("cli/commands.text052", {arg0: (BUILTIN_CARDS.length)})
      : uiText("cli/commands.text053", {arg0: (missing.join(' '))}),
  );
  data['missingBuiltins'] = missing;

  lines.push('', failed ? uiText("cli/commands.text054") : uiText("cli/commands.text055", {arg0: (state.cards.size), arg1: (session.events.length)}));
  data['ok'] = !failed;

  return { text: lines, data, exitCode: failed ? 1 : 0 };
};

// ── 派发 ─────────────────────────────────────────────────────────────────────

const HANDLERS: Record<string, Handler> = {
  create,
  edit,
  move,
  delete: remove,
  undo,
  tree,
  show,
  ls,
  find,
  path,
  windows,
  log,
  check,
};

/**
 * 跑一条命令。
 *
 * 【为什么收的是"开会话的函数"而不是会话本身】开会话会**动磁盘**
 * （`openSession` 里 `ensureBuiltins` 会写内置卡）。而"看用法""打错了命令""参数不合法"
 * 这三种情况都不该碰工作区 —— 传会话就会变成"输错一个字也先动一遍盘"。
 * 传工厂则让"要不要开会话"由**是否真的要执行命令**决定。
 */
export function runCli(open: () => Session, argv: readonly string[]): CliResult {
  let parsed: Parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, out: '', err: uiText("cli/commands.text056", {arg0: (message)}) };
  }

  if (parsed.command === '' || parsed.command === 'help' || parsed.help) {
    return { exitCode: 0, out: usageText(), err: '' };
  }

  const handler = HANDLERS[parsed.command];
  if (handler === undefined) {
    return { exitCode: 1, out: '', err: uiText("cli/commands.text057", {arg0: (parsed.command), arg1: (usageText())}) };
  }

  // 开会话会读盘，所以"读不出来"要在这里变成一句人话 ——
  // 默认的未捕获异常会把内部路径与栈直接甩给用户，而那对定位问题毫无帮助。
  let session: Session;
  try {
    session = open();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) {
      return {
        exitCode: 1,
        out: JSON.stringify({ ok: false, command: parsed.command, error: message }, null, 2),
        err: '',
      };
    }
    return {
      exitCode: 1,
      out: '',
      err: [
        uiText("cli/commands.text058", {arg0: (message)}),
        '',
        uiText("cli/commands.text059"),
        uiText("cli/commands.text060"),
        uiText("cli/commands.text061"),
      ].join('\n'),
    };
  }

  let outcome: Outcome;
  try {
    outcome = handler(session, parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // JSON 模式下错误也走 stdout（退出码表达失败）：脚本解析一个流就够了
    if (parsed.json) {
      return {
        exitCode: 1,
        out: JSON.stringify({ ok: false, command: parsed.command, error: message }, null, 2),
        err: '',
      };
    }
    return { exitCode: 1, out: '', err: uiText("cli/commands.text056", {arg0: (message)}) };
  }

  const code = outcome.exitCode ?? 0;
  if (parsed.json) {
    return {
      exitCode: code,
      out: JSON.stringify({ ok: code === 0, command: parsed.command, ...outcome.data }, null, 2),
      err: '',
    };
  }
  return { exitCode: code, out: outcome.text.join('\n'), err: '' };
}
