import {uiText} from '../i18n/text.ts';
/**
 * 命令行参数解析 —— **纯函数**，不碰文件、不碰会话，所以它自己能被无头测。
 *
 * 【为什么值得单独一层】参数解析是最容易"看起来对、实际吞掉用户输入"的地方：
 * `-t` 后面忘了值、值以 `-` 开头、`--set` 给了两次……这些都是静默出错的重灾区。
 * 抽出来之后每一条都有断言钉着（`test/cli.test.ts`）。
 *
 * 【归一化】短选项一律归到长名（`-p` → `parent`），于是命令实现里只认一套名字。
 */

import type { Layout } from '../core/types.ts';

/** 选项取值：带值的选项给字符串，布尔选项给 `true`。 */
export type FlagValue = string | true;

export type Parsed = {
  /** 已识别大小写的命令名；空串表示调用方没给命令 */
  command: string;
  /** 非选项参数，按出现顺序 */
  positionals: string[];
  /** 选项 → 值（同一个选项给多次时是**最后一个**；全部出现见 `valueLists`） */
  flags: Map<string, FlagValue>;
  /** 选项 → 全部值（只有带值选项会出现） */
  valueLists: Map<string, string[]>;
  /** `--workspace` 指定的工作区目录；没给就是 null（由入口决定默认值） */
  workspace: string | null;
  json: boolean;
  help: boolean;
};

type FlagSpec = {
  /** 长名，也是 `flags` 里的键 */
  long: string;
  short?: string;
  /** 是否需要一个值 */
  value: boolean;
  help: string;
};

type CommandSpec = {
  name: string;
  summary: string;
  usage: string;
  flags: readonly FlagSpec[];
};

/** 全局选项：任何命令都认。 */
const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { long: 'workspace', value: true, help: uiText("cli/args.text001") },
  { long: 'json', value: false, help: uiText("cli/args.text002") },
  { long: 'help', value: false, help: uiText("cli/args.text003") },
];

/** CLI 认得的呈现方式。与 `Layout` 对齐（`satisfies` 保证写错名字会编译不过）。 */
export const LAYOUTS = ['tabs', 'columns', 'ordered', 'grid', 'library', 'plane', 'plain'] as const satisfies readonly Layout[];

export function isLayout(value: string): value is Layout {
  return (LAYOUTS as readonly string[]).includes(value);
}

const COMMON_READ = [{ long: 'json', value: false, help: uiText("cli/args.text004") }] as const;

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'create',
    summary: uiText("cli/args.text005"),
    usage: uiText("cli/args.text006"),
    flags: [
      { long: 'parent', short: 'p', value: true, help: uiText("cli/args.text007") },
      { long: 'title', short: 't', value: true, help: uiText("cli/args.text008") },
      { long: 'content', short: 'c', value: true, help: uiText("cli/args.text009") },
      { long: 'layout', value: true, help: uiText("cli/args.text010", {arg0: (LAYOUTS.join(' / '))}) },
      { long: 'type', value: true, help: uiText("cli/args.text011") },
    ],
  },
  {
    name: 'edit',
    summary: uiText("cli/args.text012"),
    usage: uiText("cli/args.text013"),
    flags: [
      { long: 'title', short: 't', value: true, help: uiText("cli/args.text014") },
      { long: 'content', short: 'c', value: true, help: uiText("cli/args.text015") },
      { long: 'layout', value: true, help: uiText("cli/args.text016", {arg0: (LAYOUTS.join(' / '))}) },
      { long: 'set', value: true, help: uiText("cli/args.text017") },
    ],
  },
  {
    name: 'move',
    summary: uiText("cli/args.text018"),
    usage: uiText("cli/args.text019"),
    flags: [
      { long: 'parent', short: 'p', value: true, help: uiText("cli/args.text020") },
      { long: 'index', short: 'i', value: true, help: uiText("cli/args.text021") },
    ],
  },
  {
    name: 'delete',
    summary: uiText("cli/args.text022"),
    usage: uiText("cli/args.text023"),
    flags: [],
  },
  { name: 'undo', summary: uiText("cli/args.text024"), usage: uiText("cli/args.text025"), flags: [] },
  {
    name: 'tree',
    summary: uiText("cli/args.text026"),
    usage: uiText("cli/args.text027"),
    flags: [{ long: 'depth', value: true, help: uiText("cli/args.text028") }],
  },
  { name: 'show', summary: uiText("cli/args.text029"), usage: uiText("cli/args.text030"), flags: [] },
  { name: 'ls', summary: uiText("cli/args.text031"), usage: uiText("cli/args.text032"), flags: [{ long: 'limit', value: true, help: uiText("cli/args.text033") }] },
  { name: 'find', summary: uiText("cli/args.text034"), usage: uiText("cli/args.text035"), flags: [{ long: 'limit', value: true, help: uiText("cli/args.text033") }] },
  { name: 'path', summary: uiText("cli/args.text036"), usage: uiText("cli/args.text037"), flags: [] },
  { name: 'windows', summary: uiText("cli/args.text038"), usage: uiText("cli/args.text039"), flags: [] },
  { name: 'log', summary: uiText("cli/args.text040"), usage: uiText("cli/args.text041"), flags: [{ long: 'limit', value: true, help: uiText("cli/args.text042") }] },
  { name: 'check', summary: uiText("cli/args.text043"), usage: uiText("cli/args.text044"), flags: [] },
];

export function commandSpec(name: string): CommandSpec | undefined {
  return COMMANDS.find((spec) => spec.name === name);
}

export function usageText(): string {
  const lines = [
    uiText("cli/args.text045"),
    '',
    uiText("cli/args.text046"),
    ...COMMANDS.map((spec) => `  ${spec.usage}\n      ${spec.summary}`),
    '',
    uiText("cli/args.text047"),
    ...GLOBAL_FLAGS.map((flag) => `  --${flag.long}${flag.value ? uiText("cli/args.text048") : ''}\n      ${flag.help}`),
    '',
    uiText("cli/args.text049"),
    uiText("cli/args.text050"),
  ];
  return lines.join('\n');
}

function specFor(specs: readonly FlagSpec[], token: string, where: string): FlagSpec {
  const found = specs.find((spec) => spec.long === token || spec.short === token);
  if (found === undefined) {
    throw new Error(uiText("cli/args.text051", {arg0: (where)}));
  }
  return found;
}

/**
 * 找出命令名：**第一个"既不是选项、也不是选项的值"的 token**。
 *
 * `kkb --workspace X tree` 与 `kkb tree --workspace X` 必须等价 ——
 * 把全局选项写在命令前面是很常见的写法，只认 `argv[0]` 会让人踩空
 * （实测：那样写会让后面所有 `-p` / `-t` 都变成"未知选项"）。
 *
 * 命令之前出现非全局选项时返回空串 —— 交给下面逐 token 的解析去报"未知选项"。
 */
function findCommand(argv: readonly string[]): string {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? '';
    if (!token.startsWith('-')) return token;

    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).replace(/^--?/, '');
    const spec = GLOBAL_FLAGS.find((flag) => flag.long === name || flag.short === name);
    if (spec === undefined) return '';

    index += eq === -1 && spec.value ? 2 : 1;
  }
  return '';
}

/**
 * 解析 argv（不含 `node` 与脚本路径）。
 *
 * 【值以 `-` 开头怎么办】`-t -x` 会被判成"缺值"并报错 —— 与其猜，不如让用户写
 * `--title=-x`。静默把 `-x` 当成标题是那种"跑通了但存进去的是别的东西"的错。
 */
export function parseArgv(argv: readonly string[]): Parsed {
  const flags = new Map<string, FlagValue>();
  const valueLists = new Map<string, string[]>();
  const positionals: string[] = [];

  const command = findCommand(argv);
  const specs = [...(commandSpec(command)?.flags ?? []), ...GLOBAL_FLAGS];

  let index = 0;
  /** 命令那一个 token 要**跳过**，不能当成位置参数 —— 第一版就把它塞进去了。 */
  let skippedCommand = false;

  while (index < argv.length) {
    const token = argv[index] ?? '';
    index += 1;

    if (!token.startsWith('-')) {
      if (!skippedCommand && command !== '') {
        skippedCommand = true;
        continue;
      }
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).replace(/^--?/, '');
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const spec = specFor(specs, name, token);

    if (!spec.value) {
      if (inline !== undefined) throw new Error(uiText("cli/args.text052", {arg0: (spec.long)}));
      flags.set(spec.long, true);
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[index];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(uiText("cli/args.text054", {arg0: (spec.long), arg1: (next === undefined ? '' : uiText("cli/args.text053", {arg0: (spec.long), arg1: (next)}))}));
      }
      value = next;
      index += 1;
    }

    flags.set(spec.long, value);
    valueLists.set(spec.long, [...(valueLists.get(spec.long) ?? []), value]);
  }

  return {
    command,
    positionals,
    flags,
    valueLists,
    workspace: text(flags.get('workspace')),
    json: flags.get('json') === true,
    help: flags.get('help') === true,
  };
}

function text(value: FlagValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** 取某个选项的值（最后一次）。 */
export function flagText(parsed: Parsed, name: string): string | undefined {
  return text(parsed.flags.get(name)) ?? undefined;
}

/** 取某个选项的全部值（`--set` 会给多次）。 */
export function flagTexts(parsed: Parsed, name: string): string[] {
  return parsed.valueLists.get(name) ?? [];
}

/** 取一个**必需**的位置参数。 */
export function positional(parsed: Parsed, index: number, usage: string, what: string): string {
  const value = parsed.positionals[index];
  if (value === undefined) throw new Error(uiText("cli/args.text055", {arg0: (what), arg1: (usage)}));
  return value;
}

/** 取一个可选的位置参数；多余的位置参数一律报错，免得用户以为它生效了。 */
export function positionalAtMostOne(parsed: Parsed, usage: string): string | undefined {
  if (parsed.positionals.length > 1) {
    throw new Error(uiText("cli/args.text056", {arg0: (parsed.positionals.length - 1), arg1: (usage)}));
  }
  return parsed.positionals[0];
}

/** 取一个整数选项。 */
export function flagNumber(parsed: Parsed, name: string, fallback: number): number {
  const raw = flagText(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) throw new Error(uiText("cli/args.text057", {arg0: (name), arg1: (raw)}));
  return value;
}
