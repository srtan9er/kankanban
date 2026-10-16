import {validInk} from '../drawing.ts';
import {readCardImages,copyCardImages} from '../card-images.ts';
import {uiText} from '../../i18n/text.ts';
import {validLayoutSizes,copyLayoutSizes} from '../layout-sizes.ts';
/**
 * `cards/<id>.md` 的 frontmatter 编解码（ARCHITECTURE.md §8 的文件布局、§2.3 的字段表）。
 *
 * 【语法】文档只规定"frontmatter 存字段、正文存 content"，没规定语法。本实现定死为：
 *
 *     ---
 *     id: "c1"
 *     title: "买牛奶"
 *     layout: "plain"
 *     ...
 *     ---
 *     正文 Markdown
 *
 * **每行 `键: <JSON 值>`，值一律用 JSON 表达。** 理由：解析就退化成 `JSON.parse`，
 * 而手写 YAML 子集必然要处理"引号里的冒号""多行字符串""转义反斜杠"这些坑，
 * 每一个都是静默损坏的来源。这里的取舍是**正确性优先于好看**。
 *
 * **`content` 只走正文，不进 frontmatter**（§2.3 的"落盘"列写的就是"正文"）。
 *
 * 【严格性】字段必须齐全、类型必须正确、不允许未知键。"少一个字段"在这里被当作
 * **数据损坏**处理而不是"用默认值补上"——补默认值会让损坏静默传播，
 * 而 §4.3 的三条断言全都建立在"文件忠实反映状态"之上。
 */

import type { CardFields, Layout } from '../types.ts';

const FENCE = '---';

const LAYOUTS: ReadonlySet<string> = new Set<Layout>(['tabs', 'columns', 'ordered', 'grid', 'library', 'plane', 'plain']);

/** frontmatter 里出现的字段，顺序即写出顺序（`content` 不在其中，它走正文）。 */
export const FRONTMATTER_FIELDS = [
  'id',
  'title',
  'type',
  'layout',
  'layoutSizes',
  'isPrefab',
  'prefabRef',
  'overrides',
  'prefabBase',
  'doodle',
  'images',
  'createdAt',
  'updatedAt',
  'createdBy',
  'editingBy',
  'deleted',
] as const satisfies readonly (keyof CardFields)[];

type FrontmatterField = (typeof FRONTMATTER_FIELDS)[number];

const KNOWN = new Set<string>(FRONTMATTER_FIELDS);

/** 把卡片字段序列化成完整 `.md` 文本。 */
export function serializeCard(fields: CardFields): string {
  const head = FRONTMATTER_FIELDS.filter(key=>(key!=='images'||fields.images!==undefined)&&(key!=='layoutSizes'||fields.layoutSizes!==undefined)).map((key) => `${key}: ${JSON.stringify(key==='images'?copyCardImages(fields.images!):(key === 'prefabBase' || key === 'doodle') ? fields[key] ?? null : fields[key])}`);
  // 收尾的换行是刻意的：正文永远紧跟在结束分隔符的换行之后，解析时正好切掉那一个换行。
  return [FENCE, ...head, FENCE, fields.content].join('\n');
}

/** 把 `.md` 文本解析回卡片字段。 */
export function parseCard(text: string): CardFields {
  const lines = text.split('\n');

  if (lines[0] !== FENCE) {
    throw new Error(uiText("core/storage/frontmatter.text001", {arg0: (FENCE)}));
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FENCE) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    throw new Error(uiText("core/storage/frontmatter.text002", {arg0: (FENCE)}));
  }

  // 取**第一个**结束分隔符，所以正文里的 --- 是安全的。
  const body = lines.slice(end + 1).join('\n');

  const raw = new Map<string, unknown>();
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;

    const colon = line.indexOf(':');
    if (colon < 0) {
      throw new Error(uiText("core/storage/frontmatter.text003", {arg0: (JSON.stringify(line))}));
    }
    const key = line.slice(0, colon).trim();
    const valueText = line.slice(colon + 1).trim();

    if (key === 'content') {
      throw new Error(uiText("core/storage/frontmatter.text004"));
    }
    if (!KNOWN.has(key)) {
      throw new Error(uiText("core/storage/frontmatter.text005", {arg0: (key)}));
    }

    try {
      raw.set(key, JSON.parse(valueText));
    } catch {
      throw new Error(uiText("core/storage/frontmatter.text006", {arg0: (key), arg1: (valueText)}));
    }
  }

  if(!raw.has('doodle'))raw.set('doodle',null);
  if(raw.has('layoutSizes')&&!validLayoutSizes(raw.get('layoutSizes')))throw new Error(uiText('layoutSizing.invalid'));
  if(raw.has('images'))raw.set('images',readCardImages(raw.get('images')));
  if(raw.get('doodle')!==null && !validInk(raw.get('doodle')))throw new Error(uiText('drawing.invalid'));
  if (!raw.has('prefabBase')) raw.set('prefabBase', null);
  for (const key of FRONTMATTER_FIELDS) {
    if(key==='images'||key==='layoutSizes')continue;
    if (!raw.has(key)) {
      throw new Error(uiText("core/storage/frontmatter.text007", {arg0: (key)}));
    }
  }

  const fields: CardFields = {
    id: expectString(raw, 'id'),
    title: expectString(raw, 'title'),
    content: body,
    ...(raw.has('images')?{images:copyCardImages(raw.get('images') as NonNullable<CardFields['images']>)}:{}),
    doodle:raw.get('doodle') as CardFields['doodle'] ?? null,
    type: expectStringOrNull(raw, 'type'),
    layout: expectLayout(raw),
    ...(raw.has('layoutSizes')?{layoutSizes:copyLayoutSizes(raw.get('layoutSizes') as NonNullable<CardFields['layoutSizes']>)}:{}),
    isPrefab: expectBoolean(raw, 'isPrefab'),
    prefabRef: expectStringOrNull(raw, 'prefabRef'),
    overrides: expectStringArray(raw, 'overrides'),
    prefabBase: expectStringOrNull(raw, 'prefabBase'),
    createdAt: expectNumber(raw, 'createdAt'),
    updatedAt: expectNumber(raw, 'updatedAt'),
    createdBy: expectString(raw, 'createdBy'),
    editingBy: expectStringOrNull(raw, 'editingBy'),
    deleted: expectBoolean(raw, 'deleted'),
  };

  return fields;
}

// ── 取值与类型校验 ─────────────────────────────────────────────────────────────

function need(raw: Map<string, unknown>, key: FrontmatterField): unknown {
  const value = raw.get(key);
  if (value === undefined) throw new Error(uiText("core/storage/frontmatter.text007", {arg0: (key)}));
  return value;
}

function expectString(raw: Map<string, unknown>, key: FrontmatterField): string {
  const value = need(raw, key);
  if (typeof value !== 'string') throw new Error(uiText("core/storage/frontmatter.text008", {arg0: (key), arg1: (typeof value)}));
  return value;
}

function expectStringOrNull(raw: Map<string, unknown>, key: FrontmatterField): string | null {
  const value = need(raw, key);
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(uiText("core/storage/frontmatter.text009", {arg0: (key), arg1: (typeof value)}));
  return value;
}

function expectNumber(raw: Map<string, unknown>, key: FrontmatterField): number {
  const value = need(raw, key);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(uiText("core/storage/frontmatter.text010", {arg0: (key)}));
  }
  return value;
}

function expectBoolean(raw: Map<string, unknown>, key: FrontmatterField): boolean {
  const value = need(raw, key);
  if (typeof value !== 'boolean') throw new Error(uiText("core/storage/frontmatter.text011", {arg0: (key), arg1: (typeof value)}));
  return value;
}

function expectStringArray(raw: Map<string, unknown>, key: FrontmatterField): string[] {
  const value = need(raw, key);
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(uiText("core/storage/frontmatter.text012", {arg0: (key)}));
  }
  return value as string[];
}

function expectLayout(raw: Map<string, unknown>): Layout {
  const value = need(raw, 'layout');
  if (typeof value !== 'string' || !LAYOUTS.has(value)) {
    throw new Error(uiText("core/storage/frontmatter.text013", {arg0: (JSON.stringify(value))}));
  }
  return value as Layout;
}
