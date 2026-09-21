import YAML from 'yaml'
import { KkbError } from './errors.ts'
import type { Card, ChildEntry, Layout, Scope, ViewMode, WindowState } from './types.ts'
import { VIEW_MODES } from './types.ts'

/**
 * 卡片文件的读写：YAML frontmatter 存字段，正文存 content。
 *
 * 两条硬要求：
 * 1. 输出必须逐字节稳定（golden test 盯着），否则 git diff 会全是噪声。
 * 2. 读入必须严格校验，坏文件要报出「哪个字段、哪个文件、为什么」。
 */

export const CARD_FILE_EXT = '.md'

/** 固定的键顺序。改动这里就等于改动文件格式，golden test 会拦下来。 */
export const FRONTMATTER_KEY_ORDER = [
  'id',
  'parent',
  'children',
  'title',
  'view',
  'scope',
  'trashed',
  'color',
  'due',
  'tags',
  'isPrefab',
  'prefabRef',
  'overrides',
  'window',
  'createdAt',
  'updatedAt',
  'createdBy',
] as const

const YAML_STRINGIFY_OPTIONS = { lineWidth: 0, indent: 2, sortMapEntries: false } as const
const YAML_PARSE_OPTIONS = { version: '1.2' as const }

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

/**
 * 按固定键顺序组装 frontmatter。
 * 值为 undefined / 空的可选字段一律不写——文件里只出现有意义的字段。
 */
export function cardToFrontmatter(card: Card): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  out['id'] = card.id
  out['parent'] = card.parent
  out['children'] = card.children.map((entry) =>
    entry.layout ? { id: entry.id, layout: { ...entry.layout } } : { id: entry.id },
  )
  out['title'] = card.title
  if (card.view !== undefined) out['view'] = card.view
  out['scope'] = card.scope
  if (card.trashed === true) out['trashed'] = true
  if (card.color !== undefined) out['color'] = card.color
  if (card.due !== undefined) out['due'] = card.due
  if (card.tags !== undefined && card.tags.length > 0) out['tags'] = [...card.tags]
  if (card.isPrefab === true) out['isPrefab'] = true
  if (card.prefabRef !== undefined && card.prefabRef !== null) out['prefabRef'] = card.prefabRef
  if (card.overrides !== undefined && Object.keys(card.overrides).length > 0) {
    out['overrides'] = { ...card.overrides }
  }
  if (card.window !== undefined) out['window'] = { ...card.window }
  out['createdAt'] = card.createdAt
  out['updatedAt'] = card.updatedAt
  out['createdBy'] = card.createdBy

  return out
}

/** 序列化成一整个卡片文件的文本。 */
export function serializeCard(card: Card): string {
  const yamlText = YAML.stringify(cardToFrontmatter(card), YAML_STRINGIFY_OPTIONS)
  const frontmatter = `---\n${yamlText}---\n`

  const body = normalizeNewlines(card.content).replace(/^\n+/, '').replace(/\s+$/, '')
  return body === '' ? frontmatter : `${frontmatter}\n${body}\n`
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

function corrupt(source: string, reason: string, details: Record<string, unknown> = {}): KkbError {
  return new KkbError('CORRUPT_CARD_FILE', `${source}：${reason}`, { source, ...details })
}

/** 给错误消息用的值描述。特别照顾「YAML 把日期解析成了 Date」这个经典坑。 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (value instanceof Date) {
    return `Date(${value.toISOString()})——YAML 把看起来像日期的字符串解析成了时间对象，请给这个值加引号`
  }
  if (Array.isArray(value)) return `数组(len=${value.length})`
  if (typeof value === 'string') return `字符串 "${value.length > 40 ? value.slice(0, 40) + '…' : value}"`
  if (typeof value === 'object') return `对象(${Object.keys(value).slice(0, 5).join(', ')})`
  return `${typeof value} ${String(value)}`
}

function asRecord(value: unknown, source: string, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw corrupt(source, `${where} 应该是一个映射（key: value），实际是 ${describe(value)}`)
  }
  return value as Record<string, unknown>
}

function str(value: unknown, source: string, where: string): string {
  if (typeof value !== 'string') {
    throw corrupt(source, `${where} 应该是字符串，实际是 ${describe(value)}`)
  }
  return value
}

function num(value: unknown, source: string, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw corrupt(source, `${where} 应该是有限数字，实际是 ${describe(value)}`)
  }
  return value
}

function bool(value: unknown, source: string, where: string): boolean {
  if (typeof value !== 'boolean') {
    throw corrupt(source, `${where} 应该是 true 或 false，实际是 ${describe(value)}`)
  }
  return value
}

function splitFrontmatter(raw: string, source: string): { yamlText: string; body: string } {
  const text = normalizeNewlines(raw.replace(/^\uFEFF/, ''))
  const lines = text.split('\n')

  if (lines[0] !== '---') {
    throw corrupt(source, '文件没有以 YAML frontmatter 开头（第一行应该是 ---）', {
      firstLine: lines[0] ?? '',
    })
  }

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i
      break
    }
  }
  if (end === -1) {
    throw corrupt(source, 'frontmatter 没有闭合（找不到单独一行的 ---）')
  }

  return {
    yamlText: lines.slice(1, end).join('\n'),
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, ''),
  }
}

function parseChildren(value: unknown, source: string): ChildEntry[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw corrupt(source, `字段 children 应该是列表，实际是 ${describe(value)}`)
  }

  return value.map((raw, index) => {
    const where = `children[${index}]`
    const entry = asRecord(raw, source, where)
    const id = str(entry['id'], source, `${where}.id`)

    if (entry['layout'] === undefined || entry['layout'] === null) return { id }

    const rawLayout = asRecord(entry['layout'], source, `${where}.layout`)
    const layout: Layout = {
      x: num(rawLayout['x'], source, `${where}.layout.x`),
      y: num(rawLayout['y'], source, `${where}.layout.y`),
      w: num(rawLayout['w'], source, `${where}.layout.w`),
      h: num(rawLayout['h'], source, `${where}.layout.h`),
      z: num(rawLayout['z'], source, `${where}.layout.z`),
    }
    return { id, layout }
  })
}

function parseWindow(value: unknown, source: string): WindowState {
  const raw = asRecord(value, source, '字段 window')
  return {
    x: num(raw['x'], source, 'window.x'),
    y: num(raw['y'], source, 'window.y'),
    width: num(raw['width'], source, 'window.width'),
    height: num(raw['height'], source, 'window.height'),
    alwaysOnTop: bool(raw['alwaysOnTop'], source, 'window.alwaysOnTop'),
    minimized: bool(raw['minimized'], source, 'window.minimized'),
  }
}

export interface ParseCardOptions {
  /** 文件名推出的 id。传了就校验，防止文件和内容对不上。 */
  expectedId?: string
  /** 出错消息里显示的路径。 */
  source?: string
}

/** 解析一个卡片文件。任何不合规都会抛 CORRUPT_CARD_FILE。 */
export function parseCard(raw: string, options: ParseCardOptions = {}): Card {
  const source = options.source ?? '<memory>'
  const { yamlText, body } = splitFrontmatter(raw, source)

  let parsed: unknown
  try {
    parsed = YAML.parse(yamlText, YAML_PARSE_OPTIONS)
  } catch (e) {
    throw corrupt(source, `frontmatter 不是合法的 YAML：${e instanceof Error ? e.message : String(e)}`)
  }

  const fm = asRecord(parsed, source, 'frontmatter')

  const id = str(fm['id'], source, '字段 id')
  if (options.expectedId !== undefined && id !== options.expectedId) {
    throw corrupt(source, `字段 id 是 "${id}"，但文件名是 "${options.expectedId}"，两者必须一致`, {
      fileId: options.expectedId,
      contentId: id,
    })
  }

  let parent: string | null
  const rawParent = fm['parent']
  if (rawParent === null || rawParent === undefined) {
    parent = null
  } else {
    parent = str(rawParent, source, '字段 parent')
  }

  const scope = str(fm['scope'], source, '字段 scope')
  if (scope !== 'private' && scope !== 'public') {
    throw corrupt(source, `字段 scope 只能是 "private" 或 "public"，实际是 ${describe(fm['scope'])}`)
  }

  let view: ViewMode | undefined
  if (fm['view'] !== undefined && fm['view'] !== null) {
    const rawView = str(fm['view'], source, '字段 view')
    if (!(VIEW_MODES as readonly string[]).includes(rawView)) {
      throw corrupt(source, `字段 view 只能是 ${VIEW_MODES.join(' / ')}，实际是 "${rawView}"`)
    }
    view = rawView as ViewMode
  }

  let due: string | null | undefined
  if (fm['due'] !== undefined) {
    if (fm['due'] === null) {
      due = null
    } else {
      due = str(fm['due'], source, '字段 due')
    }
  }

  let tags: string[] | undefined
  if (fm['tags'] !== undefined && fm['tags'] !== null) {
    if (!Array.isArray(fm['tags'])) {
      throw corrupt(source, `字段 tags 应该是列表，实际是 ${describe(fm['tags'])}`)
    }
    tags = fm['tags'].map((t, i) => str(t, source, `tags[${i}]`))
  }

  let overrides: Record<string, unknown> | undefined
  if (fm['overrides'] !== undefined && fm['overrides'] !== null) {
    overrides = { ...asRecord(fm['overrides'], source, '字段 overrides') }
  }

  const card: Card = {
    id,
    parent,
    children: parseChildren(fm['children'], source),
    title: str(fm['title'], source, '字段 title'),
    content: body,
    scope: scope as Scope,
    createdAt: num(fm['createdAt'], source, '字段 createdAt'),
    updatedAt: num(fm['updatedAt'], source, '字段 updatedAt'),
    createdBy: str(fm['createdBy'], source, '字段 createdBy'),
  }

  if (view !== undefined) card.view = view
  if (fm['trashed'] !== undefined && fm['trashed'] !== null) {
    card.trashed = bool(fm['trashed'], source, '字段 trashed')
  }
  if (fm['color'] !== undefined && fm['color'] !== null) {
    card.color = str(fm['color'], source, '字段 color')
  }
  if (due !== undefined) card.due = due
  if (tags !== undefined && tags.length > 0) card.tags = tags
  if (fm['isPrefab'] !== undefined && fm['isPrefab'] !== null) {
    card.isPrefab = bool(fm['isPrefab'], source, '字段 isPrefab')
  }
  if (fm['prefabRef'] !== undefined && fm['prefabRef'] !== null) {
    card.prefabRef = str(fm['prefabRef'], source, '字段 prefabRef')
  }
  if (overrides !== undefined) card.overrides = overrides
  if (fm['window'] !== undefined && fm['window'] !== null) {
    card.window = parseWindow(fm['window'], source)
  }

  return card
}
