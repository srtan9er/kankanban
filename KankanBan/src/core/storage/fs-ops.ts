import {uiText} from '../../i18n/text.ts';
/**
 * 文件系统原语的**接口**（ARCHITECTURE.md §4.2 的 WAL 写入顺序）。
 *
 * 【本文件必须保持平台无关】不 import `node:fs`、不碰 DOM。
 * 理由：core 要同时跑在 Node（MCP 服务器）与 Tauri 的 webview（React UI）里，
 * 而 webview 没有 Node。具体实现由平台入口**注入**：
 *
 *   - Node       → `src/node/node-fs-ops.ts` 的 `nodeFsOps`
 *   - webview    → 走 Tauri IPC 的实现（阶段二接）
 *   - 崩溃测试   → `crashingOps(nodeFsOps, k)`
 *
 * 【为什么拆成原语而不是直接给一个 `writeFileAtomic`】崩溃可能发生在
 * "临时文件已写、还没 rename"之间，测试要能把崩溃点插在那里。
 * `writeAtomic` 因此由上层用 `writeFile` + `fsync` + `rename` 拼出来，
 * 而不是藏在某个平台实现里当黑盒。
 */

export type FsOps = {
  exists(path: string): boolean;
  readFile(path: string): string;
  readDir(path: string): string[];
  mkdirp(path: string): void;
  /** 直接写（临时文件用），不保证原子 */
  writeFile(path: string, data: string): void;
  rename(from: string, to: string): void;
  appendFile(path: string, data: string): void;
  /** 把文件内容刷到存储介质 */
  fsync(path: string): void;
  remove(path: string): void;
};

/** 会改变磁盘状态的操作 —— 崩溃模拟只在这些点上插入。 */
export type FsOpName = 'mkdirp' | 'writeFile' | 'rename' | 'appendFile' | 'fsync' | 'remove';

export type FsHook = (op: FsOpName, path: string, index: number) => void;

// ── 平台注入点 ─────────────────────────────────────────────────────────────────

let injected: FsOps | undefined;

/**
 * 由**平台入口**注入一次（Node 入口、webview 入口各一次）。
 *
 * core 里那些 `ops: FsOps = defaultFsOps()` 的默认参数就是靠它工作的 ——
 * 这样调用方不必把 `ops` 一路透传，而 core 自己又不需要知道任何平台 API。
 */
export function injectFsOps(ops: FsOps): void {
  injected = ops;
}

/** 取平台注入的实现；没注入就抛错（而不是静默用一个可能不对的实现）。 */
export function defaultFsOps(): FsOps {
  if (injected === undefined) {
    throw new Error(
      uiText("core/storage/fs-ops.text001"),
    );
  }
  return injected;
}

/** 仅供测试：清掉注入，验证"没注入时会抛错"。 */
export function clearInjectedFsOps(): void {
  injected = undefined;
}

// ── 通用工具（平台无关） ───────────────────────────────────────────────────────

/** 原子替换：写临时文件 → fsync → rename。同一目录内的 `rename` 是原子的。 */
export function writeAtomic(ops: FsOps, path: string, data: string): void {
  const tmp = `${path}.tmp`;
  ops.writeFile(tmp, data);
  ops.fsync(tmp);
  ops.rename(tmp, path);
}

/** 在每次**写操作**前调用 `hook`，`index` 从 0 递增。读操作不计入。 */
export function instrumentOps(inner: FsOps, hook: FsHook): FsOps {
  let index = 0;
  const mutating =
    <A extends unknown[]>(op: FsOpName, path: string, fn: (...args: A) => void) =>
    (...args: A): void => {
      hook(op, path, index);
      index += 1;
      fn(...args);
    };

  return {
    ...inner,
    mkdirp: mutating('mkdirp', '', (path: string) => inner.mkdirp(path)),
    writeFile: mutating('writeFile', '', (path: string, data: string) => inner.writeFile(path, data)),
    rename: mutating('rename', '', (from: string, to: string) => inner.rename(from, to)),
    appendFile: mutating('appendFile', '', (path: string, data: string) => inner.appendFile(path, data)),
    fsync: mutating('fsync', '', (path: string) => inner.fsync(path)),
    remove: mutating('remove', '', (path: string) => inner.remove(path)),
  };
}

export class SimulatedCrash extends Error {
  readonly afterOps: number;

  // 不用参数属性：`erasableSyntaxOnly` 下它是被禁的语法（Node 剥不掉）。
  constructor(afterOps: number) {
    super(uiText("core/storage/fs-ops.text002", {arg0: (afterOps)}));
    this.name = 'SimulatedCrash';
    this.afterOps = afterOps;
  }
}

/** 在第 `crashAfter` 次写操作**之前**抛错，模拟"进程在任意写入点被杀"。 */
export function crashingOps(inner: FsOps, crashAfter: number): FsOps {
  return instrumentOps(inner, (_op, _path, index) => {
    if (index >= crashAfter) throw new SimulatedCrash(crashAfter);
  });
}

/** 数一次操作序列里有多少个写点 —— 崩溃测试用它遍历全部崩溃位置。 */
export function countWriteOps(inner: FsOps, run: (ops: FsOps) => void): number {
  let count = 0;
  const counting = instrumentOps(inner, () => {
    count += 1;
  });
  run(counting);
  return count;
}
