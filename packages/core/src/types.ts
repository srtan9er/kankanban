/**
 * KankanBan 核心数据模型。
 *
 * 立场：卡片是唯一的原语。看板不是一种功能，而是卡片在容器里自然长出来的形态。
 * 详细设计见 docs/开发文档.md §2。
 */

/** 渲染方式。由父卡的 view 决定给子卡传什么渲染参数；视图不是卡片类型。 */
export type ViewMode = 'main' | 'kanban' | 'row' | 'column' | 'grid' | 'plane'

/** 二维平面视图下的位置与层级。只有父卡是 plane 视图时才使用。 */
export interface Layout {
  x: number
  y: number
  w: number
  h: number
  z: number
}

/**
 * 子卡条目。数组下标即顺序，所以没有 order 字段。
 * layout 是可选的：同一张卡从灵感台拖到看板，layout 消失，变成列内下标。
 */
export interface ChildEntry {
  id: string
  layout?: Layout
}

/** 浮卡的窗口状态。只有 parent === null 且 id 不在保留集中的卡片才有。 */
export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  alwaysOnTop: boolean
  minimized: boolean
}

export type Scope = 'private' | 'public'

export interface Card {
  // ---- 骨架 ----
  id: string
  parent: string | null
  /** 有序，数组下标即顺序 */
  children: ChildEntry[]
  /** 纯文本：窗口标题、看板卡正面、搜索 */
  title: string
  /** Markdown 源码，卡片主体 */
  content: string
  /** 缺省 'row'。保留根卡片固定为 main / kanban / plane / grid */
  view?: ViewMode
  /**
   * 语义上是派生的：看这棵树挂在哪个根下就知道。
   * 但字段照写，因为后续同步要靠它做可见性过滤，写下来才能被查询和索引。
   */
  scope: Scope

  // ---- 软删除 ----
  /** 置 true 即被删除，所有查询过滤掉它。恢复就是清标记。 */
  trashed?: boolean

  // ---- 展示辅助 ----
  /** 色标，如 '#4A90D9' */
  color?: string
  /** ISO 日期字符串，如 '2025-06-01' */
  due?: string | null
  tags?: string[]

  // ---- 预制体（阶段三） ----
  isPrefab?: boolean
  /** 实例指向的预制体 id */
  prefabRef?: string | null
  /** 路径 → 覆盖值，如 { 'title': '...', 'children/2/title': '...' } */
  overrides?: Record<string, unknown>

  // ---- 仅浮卡（parent === null 且非保留 id） ----
  window?: WindowState

  // ---- 元数据 ----
  createdAt: number
  updatedAt: number
  createdBy: string
}

// ---------------------------------------------------------------------------
// 保留根卡片
// ---------------------------------------------------------------------------

/** main 板。应用外壳，三栏：卡片管理器 / git / 设置。 */
export const MAIN_ID = '000'
/** 看板，公有区域。 */
export const BOARD_ID = '001'
/** 灵感台，公有区域。二维无限平面。 */
export const INSPIRATION_ID = '002'
/** 预制体根，公有区域。 */
export const PREFABS_ID = '003'

export const RESERVED_IDS = [MAIN_ID, BOARD_ID, INSPIRATION_ID, PREFABS_ID] as const
export type ReservedId = (typeof RESERVED_IDS)[number]

/** 公有区域：拖进这些根的子树就变公有。000 是外壳，不参与。 */
export const PUBLIC_ROOT_IDS = [BOARD_ID, INSPIRATION_ID, PREFABS_ID] as const

const RESERVED_ID_SET: ReadonlySet<string> = new Set<string>(RESERVED_IDS)
const PUBLIC_ROOT_ID_SET: ReadonlySet<string> = new Set<string>(PUBLIC_ROOT_IDS)

export function isReservedId(id: string): boolean {
  return RESERVED_ID_SET.has(id)
}

export function isPublicRootId(id: string): boolean {
  return PUBLIC_ROOT_ID_SET.has(id)
}

/** 保留根的视图由 id 决定，不可改。 */
export const RESERVED_VIEW: Readonly<Record<string, ViewMode>> = {
  [MAIN_ID]: 'main',
  [BOARD_ID]: 'kanban',
  [INSPIRATION_ID]: 'plane',
  [PREFABS_ID]: 'grid',
}

export const RESERVED_TITLE: Readonly<Record<string, string>> = {
  [MAIN_ID]: 'main',
  [BOARD_ID]: 'board',
  [INSPIRATION_ID]: 'inspiration',
  [PREFABS_ID]: 'prefabs',
}

/** 保留根上不可改的字段。标题、颜色、正文、子卡都是可以改的。 */
export const RESERVED_IMMUTABLE_FIELDS = ['id', 'parent', 'view', 'scope'] as const

/** 普通卡缺省视图。 */
export const DEFAULT_VIEW: ViewMode = 'row'

/** 出错时提示用的合法视图列表。 */
export const VIEW_MODES: readonly ViewMode[] = ['main', 'kanban', 'row', 'column', 'grid', 'plane']

/** 首次建立工作区时给 board 预置的三列。 */
export const DEFAULT_BOARD_COLUMNS = ['待办', '进行中', '完成'] as const

// ---------------------------------------------------------------------------
// 事件日志
// ---------------------------------------------------------------------------

export type EventType =
  | 'field_set'
  | 'child_add'
  | 'child_remove'
  | 'children_order'
  | 'card_trash'
  | 'card_restore'

/**
 * 字段级事件。文件是真相，事件日志是派生的流水。
 * before / after 都要写：只有 after 的话撤销做不出来。
 */
export interface KkbEvent {
  /** 客户端内单调递增。光靠 timestamp 排序在同步时不可靠。 */
  seq: number
  id: string
  clientId: string
  timestamp: number
  cardId: string
  type: EventType
  /** JSON Pointer 风格：/title、/children/2/title */
  path: string
  before?: unknown
  after?: unknown
}

// ---------------------------------------------------------------------------
// 工作区元数据
// ---------------------------------------------------------------------------

export const WORKSPACE_FORMAT_VERSION = 1

export interface WorkspaceMeta {
  version: number
  id: string
  name: string
  /** 本安装的客户端标识，用于事件日志和后续同步 */
  clientId: string
  createdAt: number
}
