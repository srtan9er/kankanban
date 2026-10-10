import {uiText} from '../../i18n/text.ts';
/**
 * 工作区读写（ARCHITECTURE.md §8 的文件布局、§4.2 的 WAL 协议）。
 *
 * 目录布局：
 *
 *     .kkb/
 *       tree.json              # 结构：children + lastAppliedSeq
 *       events.jsonl           # WAL + 操作历史，每行一个事件
 *       cards/<card-id>.md     # 卡片字段（frontmatter）+ 正文（content）
 *
 * 【写入次序是这份实现的要害，不能重排】
 *
 *   1. 事件 append 到 events.jsonl 并 fsync      ← WAL 先行
 *   2. 全部 cards/<id>.md 原子替换
 *   3. tree.json 原子替换（它携带 lastAppliedSeq）
 *
 * 为什么 cards 必须在 tree.json **之前**：`lastAppliedSeq` 是"这些事件已经折进文件了"的
 * 承诺。若先写 tree.json，崩溃在中间就会留下一份"水位线说已应用、卡片文件却还是旧值"的状态，
 * 而这些事件再也不会被重放 —— 悄无声息地丢数据。反过来（cards 先写、tree.json 落后）
 * 只会导致重放，而重放是幂等的。
 */

import { joinPath } from '../paths.ts';
import { applyEvent, emptyState, materializeUpdatedAt, type CoreState } from '../state.ts';
import type { CardEvent, CardFields, CardId, ChildEntry, Layout } from '../types.ts';
import { defaultFsOps, writeAtomic as writeAtomicFile, type FsOps } from './fs-ops.ts';
import { parseCard, serializeCard } from './frontmatter.ts';

export const KKB_DIR = '.kkb';

const TREE_FILE = 'tree.json';
const EVENTS_FILE = 'events.jsonl';
const CARDS_DIR = 'cards';
const TREE_VERSION = 1;

export type OpenResult = {
  state: CoreState;
  events: CardEvent[];
  /** 日志尾部被丢弃的截断行数 */
  droppedTailLines: number;
};

type TreeFile = {
  version: number;
  lastAppliedSeq: number;
  children: Record<CardId, ChildEntry[]>;
  /**
   * **活着的卡片 id 集合** —— 存在性的权威。
   *
   * 【为什么需要它】`cards/` 里的文件**不能**当作"哪些卡存在"的依据：
   * 撤销一次建卡会把卡从状态里去掉，而"删文件"这件事没法与 `tree.json` 原子完成
   * （崩在中间会留下"文件已删、结构还说它在"，工作区直接打不开）。
   * 反过来，留着孤儿文件又会让**被撤掉的卡在重开时复活** —— 这是实测出来的 bug。
   *
   * 于是分工明确：**存在性归 `tree.json`（结构），字段归 `cards/*.md`（内容）**。
   * 孤儿文件被直接忽略，删不删都不影响正确性（`writeState` 会顺手清理）。
   *
   * 旧格式（没有这个字段）按"文件即权威"处理，向后兼容。
   */
  cards?: CardId[];
};

const kkbDir = (root: string): string => joinPath(root, KKB_DIR);
const treePath = (root: string): string => joinPath(kkbDir(root), TREE_FILE);
const eventsPath = (root: string): string => joinPath(kkbDir(root), EVENTS_FILE);
const cardsDir = (root: string): string => joinPath(kkbDir(root), CARDS_DIR);
const cardPath = (root: string, id: CardId): string => joinPath(cardsDir(root), `${id}.md`);

// ── 读 ─────────────────────────────────────────────────────────────────────────

/** 读日志。**只有最后一行的解析失败**被当作"写到一半被杀"而丢弃。 */
export function readEvents(root: string, ops: FsOps = defaultFsOps()): { events: CardEvent[]; droppedTailLines: number } {
  const path = eventsPath(root);
  if (!ops.exists(path)) return { events: [], droppedTailLines: 0 };

  const text = ops.readFile(path);
  if (text === '') return { events: [], droppedTailLines: 0 };

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  const events: CardEvent[] = [];
  let droppedTailLines = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line === '') continue;

    try {
      events.push(JSON.parse(line) as CardEvent);
    } catch {
      if (i === lines.length - 1) { droppedTailLines = 1; break; }
      // 中间行的损坏不是"写了一半"，是数据真的坏了 —— 静默跳过会永久丢事件。
      throw new Error(uiText("core/storage/workspace-io.text001", {arg0: (EVENTS_FILE), arg1: (i + 1)}));
    }
  }

  for (let index = 0; index < events.length;) {
    const event = events[index]!;
    if (event.transactionId === undefined) { index++; continue; }
    const size = event.transactionSize;
    if (!Number.isSafeInteger(size) || size! < 1) throw new Error(uiText("core/storage/workspace-io.text002"));
    const group = events.slice(index, index + size!);
    if (group.some(item => item.transactionId !== event.transactionId || item.transactionSize !== size)) throw new Error(uiText("core/storage/workspace-io.text003"));
    if (group.length < size!) {
      droppedTailLines += group.length;
      events.splice(index);
      break;
    }
    index += size!;
  }
  return { events, droppedTailLines };
}

/** 打开工作区：读磁盘状态，重放日志尾部，再校验。 */
export function openWorkspace(root: string, ops: FsOps = defaultFsOps()): OpenResult {
  const tree = readTree(root, ops);
  // 存在性以 tree.json 为准；没有这个字段（旧格式）才退回"文件即权威"。
  const cards = readCards(root, ops, tree.cards ?? null);

  const children = new Map<CardId, ChildEntry[]>();
  for (const [parentId, list] of Object.entries(tree.children)) {
    // 规范形态：不留空数组（不变量 C）。
    if (list.length > 0) children.set(parentId, [...list]);
  }

  const base: CoreState = { cards, children, lastAppliedSeq: tree.lastAppliedSeq };

  const { events, droppedTailLines } = readEvents(root, ops);
  const replayed = events.filter((event) => event.seq > tree.lastAppliedSeq).reduce(applyEvent, base);

  // `updatedAt` 是派生量（= 指向这张卡的最后一条事件的时间），所以**打开时按整条日志物化一次**：
  // 旧日志（没有 `prevUpdatedAt`）与旧卡片文件里它是老语义的值（永远等于 createdAt），
  // 不重算的话 `check` 会对一堆其实没坏的卡报"重放不一致"。派生字段的权威本来就是日志。
  const state = materializeUpdatedAt(replayed, events);

  validateState(state);

  return { state, events, droppedTailLines };
}

function readTree(root: string, ops: FsOps): TreeFile {
  const path = treePath(root);

  if (!ops.exists(path)) {
    if (!ops.exists(kkbDir(root))) {
      return { version: TREE_VERSION, lastAppliedSeq: 0, children: {} };
    }

    // `.kkb` 在、tree.json 不在。这有两种可能，必须分开处理：
    //   (a) 首次创建时写到一半被杀 —— `writeState` 先 mkdirp、最后才写 tree.json，
    //       所以此刻目录为空，当成空工作区即可，**不该报错**（这正是崩溃恢复的常态）
    //   (b) 已经有卡片或事件，却没有结构文件 —— 那是真的丢东西了，必须吵
    const eventsText = ops.exists(eventsPath(root)) ? ops.readFile(eventsPath(root)).trim() : '';
    const cardFiles = ops.exists(cardsDir(root))
      ? ops.readDir(cardsDir(root)).filter((name) => name.endsWith('.md'))
      : [];

    if (eventsText === '' && cardFiles.length === 0) {
      return { version: TREE_VERSION, lastAppliedSeq: 0, children: {} };
    }
    throw new Error(
      uiText("core/storage/workspace-io.text004", {arg0: (KKB_DIR), arg1: (TREE_FILE)}),
    );
  }

  const parsed = JSON.parse(ops.readFile(path)) as Partial<TreeFile>;
  if (parsed.version !== TREE_VERSION) {
    throw new Error(uiText("core/storage/workspace-io.text005", {arg0: (TREE_FILE), arg1: (String(parsed.version))}));
  }
  if (typeof parsed.lastAppliedSeq !== 'number') {
    throw new Error(uiText("core/storage/workspace-io.text006", {arg0: (TREE_FILE)}));
  }
  if (parsed.children === undefined || parsed.children === null) {
    throw new Error(uiText("core/storage/workspace-io.text007", {arg0: (TREE_FILE)}));
  }
  return {
    version: TREE_VERSION,
    lastAppliedSeq: parsed.lastAppliedSeq,
    children: parsed.children,
    ...(Array.isArray(parsed.cards) ? { cards: parsed.cards } : {}),
  };
}

/**
 * 读卡片文件。
 *
 * `liveIds` 非空时以它为权威：只保留它列出的卡，**磁盘上多出来的文件直接忽略**
 * （撤销留下的孤儿；删不删都不影响正确性）。缺失则抛错 —— 那是真的丢内容了。
 * `liveIds` 为 `null` 表示旧格式，退回"文件即权威"。
 */
function readCards(root: string, ops: FsOps, liveIds: CardId[] | null): Map<CardId, CardFields> {
  const dir = cardsDir(root);
  const onDisk = new Map<CardId, CardFields>();

  if (!ops.exists(dir)) {
    if (liveIds !== null && liveIds.length > 0) {
      throw new Error(uiText("core/storage/workspace-io.text008", {arg0: (TREE_FILE), arg1: (liveIds.length), arg2: (CARDS_DIR)}));
    }
    return onDisk;
  }

  for (const name of ops.readDir(dir)) {
    if (!name.endsWith('.md')) continue; // 跳过写入过程中的 .tmp 残留

    const fields = parseCard(ops.readFile(joinPath(dir, name)));
    const expected = `${fields.id}.md`;
    if (name !== expected) {
      throw new Error(uiText("core/storage/workspace-io.text009", {arg0: (name), arg1: (expected)}));
    }
    onDisk.set(fields.id, fields);
  }

  if (liveIds === null) return onDisk;

  const cards = new Map<CardId, CardFields>();
  for (const id of liveIds) {
    const fields = onDisk.get(id);
    if (fields === undefined) {
      throw new Error(uiText("core/storage/workspace-io.text010", {arg0: (TREE_FILE), arg1: (id), arg2: (CARDS_DIR), arg3: (id)}));
    }
    cards.set(id, fields);
  }
  return cards;
}

// ── 写 ─────────────────────────────────────────────────────────────────────────

/** 写状态文件（**不是**写日志）。`pending` 是本次新产生、尚未落盘的事件。 */
export function commit(
  root: string,
  pending: readonly CardEvent[],
  state: CoreState,
  ops: FsOps = defaultFsOps(),
): void {
  appendEvents(root, pending, ops);
  writeState(root, state, ops);
}

/** 把事件追加到日志并 fsync。 */
export function appendEvents(root: string, events: readonly CardEvent[], ops: FsOps = defaultFsOps()): void {
  if (events.length === 0) return;
  ops.mkdirp(cardsDir(root));
  ops.appendFile(eventsPath(root), events.map((event) => `${JSON.stringify(event)}\n`).join(''));
  ops.fsync(eventsPath(root));
}

/** 原子重写整个日志（用于撤销：把最后一条事件从日志里去掉）。 */
export function rewriteLog(root: string, events: readonly CardEvent[], ops: FsOps = defaultFsOps()): void {
  ops.mkdirp(cardsDir(root));
  writeAtomic(ops, eventsPath(root), events.map((event) => `${JSON.stringify(event)}\n`).join(''));
}

/** 只写状态文件（日志由调用方负责）。 */
export function writeState(root: string, state: CoreState, ops: FsOps = defaultFsOps(), changedCards?:ReadonlySet<string>): void {
  ops.mkdirp(cardsDir(root));

  // 卡片文件必须在 tree.json 之前，理由见文件头。
  for (const [id, fields] of state.cards) {
    if(changedCards && !changedCards.has(id))continue;
    writeAtomic(ops, cardPath(root, id), serializeCard(fields));
  }

  writeAtomic(ops, treePath(root), `${JSON.stringify(treeFileOf(state), null, 2)}\n`);

  // 清理孤儿卡片文件（撤销建卡留下的）。**必须放在 tree.json 之后**：
  // 万一崩在中间，结构文件已经不再声明那张卡，孤儿文件会被 `readCards` 忽略 ——
  // 两个方向都自洽。反过来（先删文件再写 tree.json）则会留下
  // "结构说卡在、文件却没了"，那是打不开工作区的硬故障。
  //
  // 这纯粹是清理，删不掉也不影响正确性，所以失败**不致命**。
  collectOrphans(root, state, ops);
}

function collectOrphans(root: string, state: CoreState, ops: FsOps): void {
  const dir = cardsDir(root);
  if (!ops.exists(dir)) return;

  for (const name of ops.readDir(dir)) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -'.md'.length);
    if (state.cards.has(id)) continue;
    try {
      ops.remove(joinPath(dir, name));
    } catch {
      // 清理失败留给下一次；正确性由 tree.json 的 cards 列表保证。
    }
  }
}

function writeAtomic(ops: FsOps, path: string, data: string): void {
  writeAtomicFile(ops, path, data);
}

function treeFileOf(state: CoreState): TreeFile {
  const children: Record<CardId, ChildEntry[]> = {};
  for (const parentId of [...state.children.keys()].sort()) {
    const list = state.children.get(parentId);
    if (list !== undefined && list.length > 0) children[parentId] = list;
  }
  return {
    version: TREE_VERSION,
    lastAppliedSeq: state.lastAppliedSeq,
    children,
    // 存在性的权威。软删的卡仍在这里（它只是被标记，没被移除）。
    cards: [...state.cards.keys()].sort(),
  };
}

// ── 加载期校验 ─────────────────────────────────────────────────────────────────

/**
 * 校验一份状态是不是合法的森林。
 *
 * 宁可在这里吵，也不要把坏数据带进后续操作 —— §4.3 的三条断言全都建立在
 * "文件忠实反映状态"之上，而这份校验就是那句话的执行者。
 */
export function validateState(state: CoreState): void {
  const parentOf = new Map<CardId, CardId>();

  for (const [parentId, list] of state.children) {
    if (list.length === 0) {
      throw new Error(uiText("core/storage/workspace-io.text011", {arg0: (parentId)}));
    }

    const parent = state.cards.get(parentId);
    if (parent === undefined) {
      throw new Error(uiText("core/storage/workspace-io.text012", {arg0: (parentId)}));
    }
    if (parent.deleted) {
      throw new Error(uiText("core/storage/workspace-io.text013", {arg0: (parentId)}));
    }

    for (const entry of list) {
      const child = state.cards.get(entry.id);
      if (child === undefined) {
        throw new Error(uiText("core/storage/workspace-io.text014", {arg0: (entry.id), arg1: (parentId)}));
      }
      if (child.deleted) {
        throw new Error(uiText("core/storage/workspace-io.text015", {arg0: (entry.id), arg1: (parentId)}));
      }

      const other = parentOf.get(entry.id);
      if (other !== undefined) {
        throw new Error(uiText("core/storage/workspace-io.text016", {arg0: (entry.id), arg1: (other), arg2: (parentId)}));
      }
      parentOf.set(entry.id, parentId);

      assertEntryShape(parent.layout, entry, parentId);
    }
  }

  // 环检测：顺着父链往上必须能走到深度 0。
  for (const id of state.cards.keys()) {
    const trail = new Set<CardId>();
    let cursor: CardId | undefined = id;
    while (cursor !== undefined) {
      if (trail.has(cursor)) throw new Error(uiText("core/storage/workspace-io.text017", {arg0: (cursor)}));
      trail.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }
}

/** 条目形状由**父卡的 `layout`** 决定（§2.4）。不匹配即数据损坏。 */
function assertEntryShape(layout: Layout, entry: ChildEntry, parentId: CardId): void {
  const keys = Object.keys(entry).sort();
  const want = (kind: string): never => {
    throw new Error(
      uiText("core/storage/workspace-io.text018", {arg0: (parentId), arg1: (layout), arg2: (kind), arg3: (keys.join(','))}),
    );
  };

  switch (layout) {
    case 'plain': {
      if (keys.length !== 1 || keys[0] !== 'id') want('{ id }');
      return;
    }
    case 'plane': {
      const expected = ['h', 'id', 'w', 'x', 'y', 'z'];
      if (keys.join(',') !== expected.join(',')) want('{ id, x, y, w, h, z }');
      return;
    }
    default: {
      // tabs / columns / ordered / grid —— 全部是顺序型
      if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'order') want('{ id, order }');
      return;
    }
  }
}
