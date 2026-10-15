import {uiText} from '../../i18n/text.ts';
/**
 * 让工作区的 `.gitignore` 忽略 `.kkb/` —— ARCHITECTURE.md §6.1 与 §8。
 *
 * §6.1 把理由写得很清楚：`events.jsonl` 是 append-only、`tree.json` 是整文件 JSON，
 * 两人各改一处**必然冲突**，而 §4.2 的"后写覆盖"冲突模型**对 git merge 完全不适用**。
 * 所以 `.kkb` 整体默认且推荐不进 git，协作走"导出 Markdown 文件夹"。
 *
 * 【为什么用带标记的块而不是随手加一行】下次再跑要能认出"这行是我们加的"，
 * 从而做到**幂等**且不重复追加。用户自己的规则一行都不动。
 */

import { joinPath } from '../paths.ts';
import { defaultFsOps, type FsOps } from './fs-ops.ts';

/** 我们写入的块的开头，用来识别"已经加过了"。 */
export const GITIGNORE_MARKER = uiText("core/storage/gitignore.text001");

const NEEDLE = '.kkb/';

/** 这一行是否已经忽略了 `.kkb`（容忍用户自己写成 `.kkb` 或 `/.kkb`）。 */
function alreadyIgnored(text: string): boolean {
  let ignored=false;
  for(const line of text.split('\n')){
    const trimmed = line.trim().replace(/^\//, '');
    if(trimmed === '.kkb' || trimmed === NEEDLE)ignored=true;
    if(trimmed === '!.kkb' || trimmed === '!/.kkb' || trimmed === '!.kkb/' || trimmed === '!/.kkb/')ignored=false;
  }
  return ignored;
}

/**
 * 确保 `<root>/.gitignore` 里忽略了 `.kkb/`。返回**是否改动了文件**。
 *
 * 【前提】`root` 这个目录**已经存在** —— 本函数只负责往 `.gitignore` 里加一行，
 * 不负责建工作区（那是 `openSession` 的事）。目录不在会直接抛 `ENOENT`，
 * 比悄悄建出一堆目录好。
 *
 * 没有 `.gitignore` 就建一个 —— §8 说的就是"默认进"，而不是"如果已经有 gitignore 才进"。
 */
export function ensureGitignoreEntry(root: string, ops: FsOps = defaultFsOps()): boolean {
  const path = joinPath(root, '.gitignore');

  if (!ops.exists(path)) {
    ops.writeFile(path, `${GITIGNORE_MARKER}\n${NEEDLE}\n`);
    return true;
  }

  const text = ops.readFile(path);
  if (alreadyIgnored(text)) return false;

  // 保留用户原有内容，只在末尾追加。原有文件不以换行结尾时先补一个，
  // 免得把我们的块粘到用户最后一行上去。
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  ops.writeFile(path, `${text}${separator}\n${GITIGNORE_MARKER}\n${NEEDLE}\n`);
  return true;
}
