import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  cardDetail,
  boardOverview,
  listCards,
  searchCards,
  toCardView,
  toKkbError,
  trashedCards,
  treeView,
  workspaceInfo,
  Workspace,
} from '@kankanban/core'
import type { Card, Command, KkbEvent, Layout, ViewMode } from '@kankanban/core'

/**
 * 阶段一的 MCP 工具。
 *
 * 工具粒度就是「人类操作」的粒度：拖拽在 MCP 里没法表达，
 * 所以暴露的是意图（移动到某父卡的第 N 位），而不是鼠标事件。
 *
 * 写入类工具都会回一句「刚才发生了什么」——事件摘要 + 提醒 + 受影响卡片的当前状态。
 * AI 因此不需要为每次写入再补一次读取。
 */

export const SERVER_NAME = 'kankanban'
export const SERVER_VERSION = '0.1.0'

/**
 * 服务端说明。这段文字会直接进 AI 的上下文，
 * 所以它承担了「先讲清楚这个工具的世界观」的职责——比任何单个工具描述都重要。
 */
export const SERVER_INSTRUCTIONS = `KankanBan 是一块以「卡片」为唯一原语的项目管理看板。

世界观（先读这段，能省掉很多试错）：
- 卡片是唯一的原语。看板不是一种功能，而是卡片在容器里自然长出来的形态。
- **没有 status 字段。** 一张卡在哪一列，由它的 parent 决定。
  「Done 就是一列」——把卡移到「完成」列，就等于把它标记成完成。
- children 是数组，**数组下标就是顺序**。调顺序用 children_reorder，或 card_move 的 index。
- 四张保留根卡片，不能删、不能移：000 main（应用外壳）、001 board（看板）、
  002 inspiration（灵感台，二维无限平面）、003 prefabs（预制体根）。
- parent 为 null 且不是保留根的卡片，是浮在桌面上的独立窗口。
- scope 是**派生**的：挂在保留根底下就是 public，挂在浮卡底下就是 private。
  不要手改它，移动卡片时会自动跟着变。
- 删除是**软删除**（trashed 标记）。删掉的卡可以恢复；它的子树会一起从视图里消失，
  但文件都还在。想从回收站的父卡底下把卡捞出来，直接 card_move 到别处就行。

工作方式建议：
- 动手之前先看：board_overview 看板面，card_get 看详情，search_cards 找卡。
- 想知道「刚刚发生了什么」，用 events_since。
- 每次写入的返回里都带了 warnings，读一下——它经常在提醒你「这张卡下面还有 5 张子卡」这种事。`

const layoutSchema = z.object({
  x: z.number().describe('相对父卡左上角的横坐标'),
  y: z.number().describe('相对父卡左上角的纵坐标'),
  w: z.number().describe('宽'),
  h: z.number().describe('高'),
  z: z.number().describe('层级，越大越靠上'),
})

const viewSchema = z
  .enum(['main', 'kanban', 'row', 'column', 'grid', 'plane'])
  .describe(
    '这张卡自己怎么摆放它的子卡：kanban=横排的列，row=底部横排，column=右侧竖排，' +
      'grid=格子背包，plane=二维无限平面，main=应用外壳。决定的是「我的孩子怎么排」，不是「我长什么样」。',
  )

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function text(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/** 失败也返回结构化数据：错误码能让 AI 自己判断该换个参数还是换个思路。 */
function failure(error: unknown): ToolResult {
  const kkb = toKkbError(error)
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(kkb.toJSON(), null, 2) }] }
}

async function guard(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn()
  } catch (error) {
    return failure(error)
  }
}

/** 事件摘要：给 AI 看「发生了什么」，不把整张卡塞进去占上下文。 */
function summarizeEvent(event: KkbEvent): Record<string, unknown> {
  return { seq: event.seq, type: event.type, cardId: event.cardId, path: event.path }
}

function cardPatchFromArgs(args: {
  title?: string
  content?: string
  view?: ViewMode | null
  color?: string | null
  due?: string | null
  tags?: string[] | null
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (args.title !== undefined) patch['title'] = args.title
  if (args.content !== undefined) patch['content'] = args.content
  if (args.view !== undefined) patch['view'] = args.view
  if (args.color !== undefined) patch['color'] = args.color
  if (args.due !== undefined) patch['due'] = args.due
  if (args.tags !== undefined) patch['tags'] = args.tags
  return patch
}

export function registerTools(server: McpServer, workspace: Workspace): void {
  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  server.registerTool(
    'workspace_info',
    {
      title: '工作区概览',
      description:
        '这个工作区在哪、有多少张卡、四张保留根卡片分别是什么、桌面上浮着哪些卡。' +
        '不知道从哪下手时先调这个。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guard(() => text(workspaceInfo(workspace))),
  )

  server.registerTool(
    'board_overview',
    {
      title: '看板全貌',
      description:
        '某块板的列，以及每列里的卡（紧凑形态，不含正文）。' +
        '缺省看 001 主看板。这是了解「现在在做什么」最快的方式。',
      inputSchema: {
        boardId: z.string().optional().describe('板卡片的 id，缺省 001'),
        limitPerColumn: z.number().int().positive().max(500).optional().describe('每列最多返回多少张卡，缺省 50'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ boardId, limitPerColumn }) =>
      guard(() =>
        text(
          boardOverview(workspace, boardId ?? '001', {
            ...(limitPerColumn !== undefined ? { limitPerColumn } : {}),
          }),
        ),
      ),
  )

  server.registerTool(
    'card_get',
    {
      title: '读一张卡',
      description:
        '一张卡的详情。缺省带正文和它所在的路径（从根一路下来），可以按需带上直接子卡。',
      inputSchema: {
        id: z.string().describe('卡片 id'),
        includeContent: z.boolean().optional().describe('是否带 Markdown 正文，缺省 true'),
        includeChildren: z.boolean().optional().describe('是否带直接子卡，缺省 false'),
        includeTrashed: z.boolean().optional().describe('是否允许读取回收站里的卡，缺省 false'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, includeContent, includeChildren, includeTrashed }) =>
      guard(() =>
        text(
          cardDetail(workspace, id, {
            includeContent: includeContent !== false,
            includeChildren: includeChildren === true,
            allowTrashed: includeTrashed === true,
          }),
        ),
      ),
  )

  server.registerTool(
    'tree_get',
    {
      title: '读一棵子树',
      description:
        '从某张卡往下展开成树。depth 是往下几层，缺省 2。到达上限的节点会标 cut: true。',
      inputSchema: {
        rootId: z.string().describe('从哪张卡开始'),
        depth: z.number().int().min(0).max(10).optional().describe('往下展开几层，缺省 2'),
        includeTrashed: z.boolean().optional().describe('是否包含回收站里的卡，缺省 false'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ rootId, depth, includeTrashed }) =>
      guard(() =>
        text(
          treeView(workspace, rootId, {
            ...(depth !== undefined ? { depth } : {}),
            includeTrashed: includeTrashed === true,
          }),
        ),
      ),
  )

  server.registerTool(
    'search_cards',
    {
      title: '搜索卡片',
      description: '按标题、正文、标签搜卡。标题命中排在前面。回收站里的卡搜不到。',
      inputSchema: {
        query: z.string().describe('搜索词，大小写不敏感'),
        limit: z.number().int().positive().max(200).optional().describe('最多几条，缺省 30'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) =>
      guard(() => text({ query, hits: searchCards(workspace, query, { ...(limit !== undefined ? { limit } : {}) }) })),
  )

  server.registerTool(
    'list_cards',
    {
      title: '列卡片',
      description:
        '按父卡列出直接子卡。parent 传 null 会列出所有根卡片（含浮卡）。' +
        '不带 parent 时会列出整个工作区的可见卡片。',
      inputSchema: {
        parent: z.string().nullable().optional().describe('父卡 id；传 null 列出所有根卡片'),
        includeTrashed: z.boolean().optional().describe('是否包含回收站里的卡，缺省 false'),
        limit: z.number().int().positive().max(1000).optional().describe('最多几条，缺省 200'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ parent, includeTrashed, limit }) =>
      guard(() =>
        text({
          cards: listCards(workspace, {
            ...(parent !== undefined ? { parent } : {}),
            includeTrashed: includeTrashed === true,
            ...(limit !== undefined ? { limit } : {}),
          }),
        }),
      ),
  )

  server.registerTool(
    'trash_list',
    {
      title: '看回收站',
      description: '列出回收站里的卡片，最近改动的在前。',
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe('最多几条，缺省 50'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ limit }) => guard(() => text({ cards: trashedCards(workspace, limit ?? 50) })),
  )

  server.registerTool(
    'events_since',
    {
      title: '最近发生了什么',
      description:
        '读事件日志里 seq 大于给定值的事件。用来回答「刚刚改了什么」' +
        '（先调 workspace_info 拿 lastSeq，或者用上一次返回里的最大 seq）。',
      inputSchema: {
        since: z.number().int().min(0).optional().describe('只要 seq 大于这个值的事件，缺省 0'),
        limit: z.number().int().positive().max(2000).optional().describe('最多几条，缺省 100'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ since, limit }) =>
      guard(async () => {
        const events = await workspace.readEvents({
          since: since ?? 0,
          ...(limit !== undefined ? { limit } : {}),
        })
        return text({
          events,
          lastSeq: workspace.lastSeq(),
        })
      }),
  )

  // -------------------------------------------------------------------------
  // 写入
  // -------------------------------------------------------------------------

  server.registerTool(
    'card_create',
    {
      title: '建卡',
      description:
        '在某个父卡下面建一张卡。parent 传 null 表示建在桌面上（一张浮卡，单独一个窗口）。\n' +
        '缺省视图：建在看板（kanban）下面就是「一列」，建在别处是「一行」。\n' +
        '建在看板下面时，返回的 id 就是新列的 id，可以直接往里放卡。',
      inputSchema: {
        parent: z.string().nullable().describe('父卡 id；传 null 建一张浮卡'),
        title: z.string().optional().describe('标题，缺省「新卡片」'),
        content: z.string().optional().describe('Markdown 正文'),
        view: viewSchema.optional(),
        color: z.string().optional().describe('色标，#RRGGBB'),
        due: z.string().optional().describe('截止日期，YYYY-MM-DD'),
        tags: z.array(z.string()).optional().describe('标签'),
        index: z.number().int().min(0).optional().describe('插在父卡的第几位，缺省追加到最后'),
      },
    },
    (args) =>
      guard(async () => {
        const command: Command = {
          type: 'card_create',
          parent: args.parent,
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.view !== undefined ? { view: args.view } : {}),
          ...(args.color !== undefined ? { color: args.color } : {}),
          ...(args.due !== undefined ? { due: args.due } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.index !== undefined ? { index: args.index } : {}),
        }
        const outcome = await workspace.execute(command)
        const created = outcome.created as string
        return text({
          ok: true,
          created,
          card: toCardView(workspace.requireCard(created)),
          ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
          ...(outcome.windowOps.length > 0 ? { windowOps: outcome.windowOps } : {}),
          events: outcome.events.map(summarizeEvent),
        })
      }),
  )

  server.registerTool(
    'card_update',
    {
      title: '改卡',
      description:
        '改一张卡的字段。只传要改的；不传的字段不动，传 null 表示清除该字段。\n' +
        '注意：结构类的改动不能走这里——移动用 card_move，调顺序用 children_reorder，' +
        '删卡用 card_trash。',
      inputSchema: {
        id: z.string().describe('卡片 id'),
        title: z.string().optional(),
        content: z.string().optional().describe('Markdown 正文'),
        view: viewSchema.nullable().optional(),
        color: z.string().nullable().optional().describe('色标 #RRGGBB；null 清除'),
        due: z.string().nullable().optional().describe('截止日期 YYYY-MM-DD；null 清除'),
        tags: z.array(z.string()).nullable().optional().describe('标签；null 清除'),
      },
    },
    (args) =>
      guard(async () => {
        const patch = cardPatchFromArgs(args)
        if (Object.keys(patch).length === 0) {
          return text({ ok: true, changed: [], note: '没有传任何要改的字段，什么都没做。' })
        }
        const outcome = await workspace.execute({
          type: 'card_update',
          id: args.id,
          patch: patch as never,
        })
        return text({
          ok: true,
          changed: Object.keys(patch),
          card: toCardView(workspace.requireCard(args.id)),
          ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
          events: outcome.events.map(summarizeEvent),
        })
      }),
  )

  server.registerTool(
    'card_move',
    {
      title: '移卡',
      description:
        '把一张卡移到另一个父卡下面。这同时就是「改状态」——因为一张卡在哪一列由 parent 决定。\n' +
        'parent 传 null 表示拖到桌面上，它会变成一张浮卡（独立窗口，作用域变私有）。\n' +
        '同父移动时 index 是取出之后的坐标系；原地不动是空操作。',
      inputSchema: {
        id: z.string().describe('要移动的卡片 id'),
        parent: z.string().nullable().describe('新的父卡 id；传 null 变成浮卡'),
        index: z.number().int().min(0).optional().describe('插到第几位，缺省追加到最后'),
        layout: layoutSchema.optional().describe('二维平面上的坐标，只有目标是 plane 视图时才有意义'),
      },
    },
    (args) =>
      guard(async () => {
        const command: Command = {
          type: 'card_move',
          id: args.id,
          parent: args.parent,
          ...(args.index !== undefined ? { index: args.index } : {}),
          ...(args.layout !== undefined ? { layout: args.layout as Layout } : {}),
        }
        const outcome = await workspace.execute(command)
        return text({
          ok: true,
          card: toCardView(workspace.requireCard(args.id)),
          ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
          ...(outcome.windowOps.length > 0 ? { windowOps: outcome.windowOps } : {}),
          events: outcome.events.map(summarizeEvent),
        })
      }),
  )

  server.registerTool(
    'children_reorder',
    {
      title: '调整子卡顺序',
      description:
        '一次性给出某个父卡下所有子卡的新顺序。order 必须和当前子卡集合完全一致（数量、成员都相同），' +
        '否则会报错。只想挪一张卡的话，用 card_move 的 index 更省事。',
      inputSchema: {
        parent: z.string().describe('父卡 id'),
        order: z.array(z.string()).describe('全部子卡 id 的新顺序，一个都不能少'),
      },
    },
    (args) =>
      guard(async () => {
        const outcome = await workspace.execute({
          type: 'children_reorder',
          parent: args.parent,
          order: args.order,
        })
        return text({
          ok: true,
          order: args.order,
          events: outcome.events.map(summarizeEvent),
        })
      }),
  )

  server.registerTool(
    'children_layout',
    {
      title: '调整子卡坐标',
      description:
        '改某张子卡在父卡里的坐标（只有 plane 二维平面之类的容器才有意义）。不传 layout 表示清掉坐标。',
      inputSchema: {
        parent: z.string().describe('父卡 id'),
        id: z.string().describe('子卡 id'),
        layout: layoutSchema.optional().describe('新坐标；不传表示清除'),
      },
    },
    (args) =>
      guard(async () => {
        const outcome = await workspace.execute({
          type: 'children_layout',
          parent: args.parent,
          id: args.id,
          ...(args.layout !== undefined ? { layout: args.layout as Layout } : {}),
        })
        return text({ ok: true, events: outcome.events.map(summarizeEvent) })
      }),
  )

  server.registerTool(
    'card_trash',
    {
      title: '删除卡片（软删除）',
      description:
        '把卡片放进回收站。文件都还在，可以 card_restore 恢复。\n' +
        '它的整棵子树会一起从视图里消失，所以删之前先看一眼 card_get 的 childCount。',
      inputSchema: {
        id: z.string().describe('卡片 id'),
      },
    },
    (args) =>
      guard(async () => {
        const outcome = await workspace.execute({ type: 'card_trash', id: args.id })
        return text({
          ok: true,
          ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
          ...(outcome.windowOps.length > 0 ? { windowOps: outcome.windowOps } : {}),
          events: outcome.events.map(summarizeEvent),
        })
      }),
  )

  server.registerTool(
    'card_restore',
    {
      title: '恢复卡片',
      description:
        '把卡片从回收站里拿出来。如果它的某个父卡还在回收站里，' +
        '它恢复后依然看不见——返回的 warnings 会说清楚。',
      inputSchema: {
        id: z.string().describe('卡片 id'),
      },
    },
    (args) =>
      guard(async () => {
        const outcome = await workspace.execute({ type: 'card_restore', id: args.id })
        return text({
          ok: true,
          card: toCardView(workspace.requireCard(args.id, { allowTrashed: true })),
          ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
          events: outcome.events.map(summarizeEvent),
        })
      }),
  )

  server.registerTool(
    'undo',
    {
      title: '撤销',
      description:
        '撤销上一步操作。人和 AI 共用同一个撤销栈，所以它撤掉的可能是你刚才那一步，' +
        '也可能是人手动做的一步。先看 workspace_info 或返回里的 label 确认。',
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const label = workspace.undoLabel()
        if (label === null) return text({ ok: false, note: '撤销栈是空的，没有可撤销的操作。' })
        const outcome = await workspace.undo()
        return text({
          ok: true,
          undid: label,
          ...(outcome?.warnings.length ? { warnings: outcome.warnings } : {}),
          events: (outcome?.events ?? []).map(summarizeEvent),
        })
      }),
  )

  server.registerTool(
    'redo',
    {
      title: '重做',
      description: '重做上一步被撤销的操作。',
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const label = workspace.redoLabel()
        if (label === null) return text({ ok: false, note: '没有可重做的操作。' })
        const outcome = await workspace.redo()
        return text({
          ok: true,
          redid: label,
          ...(outcome?.warnings.length ? { warnings: outcome.warnings } : {}),
          events: (outcome?.events ?? []).map(summarizeEvent),
        })
      }),
  )
}

/** 工具名清单，测试和文档都用它，避免手写列表跟实现漂移。 */
export const TOOL_NAMES = [
  'workspace_info',
  'board_overview',
  'card_get',
  'tree_get',
  'search_cards',
  'list_cards',
  'trash_list',
  'events_since',
  'card_create',
  'card_update',
  'card_move',
  'children_reorder',
  'children_layout',
  'card_trash',
  'card_restore',
  'undo',
  'redo',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export type { Card }
