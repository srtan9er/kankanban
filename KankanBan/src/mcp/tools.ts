import {EXTENDED_TOOLS} from './extended-tools.ts';
import {collectSubtree} from '../core/subtree.ts';
import {uiText} from '../i18n/text.ts';
import { executeAction } from '../core/actions.ts';
﻿/**
 * MCP 工具目录 —— ARCHITECTURE.md §9.2（读模型）、§9.3（粒度原则）。
 *
 * 【为什么这一层不 import MCP SDK】
 * §9.3 的粒度原则说"工具粒度 = 人类操作的粒度，暴露的是**意图**，不是鼠标按下/移动/松开"。
 * 那是纯业务约定，与用哪个 SDK 无关。把它与协议实现分开，才能在没有 GUI、没有 stdio 的环境里
 * 把"建卡 / 移卡 / 改字段 / 读树"跑通并留证（§4.3 断言五）。
 *
 * 【工具粒度就是人类操作的粒度】写工具故意不拆细：
 * 没有 `set_title` / `set_content`，只有 `set_field`；没有"拖动开始/拖动中/拖动结束"，
 * 只有 `move_card`。AI 表达的是意图，不是手势。
 */

import {
  listChildren,
  readCard,
  readTree,
  search,
  setField,
  undoLast,
} from '../core/workspace.ts';
import type { Session } from '../core/workspace.ts';
import type { Layout } from '../core/types.ts';

export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDef = {
  name: string;
  execution?:'desktop';
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** `args` 已由 `callTool` 校验过必填项 */
  handler: (session: Session, args: Record<string, unknown>) => unknown;
};

const LAYOUTS: Layout[] = ['columns', 'ordered', 'grid', 'library', 'plane', 'plain'];

const CARD_ID = { type: 'string', description: uiText("mcp/tools.text001") } as const;

export const TOOLS: readonly ToolDef[] = [
 ...EXTENDED_TOOLS,
  {
    name: 'create_card',
    title: uiText("mcp/tools.text002"),
    description:
      uiText("mcp/tools.text003") +
      uiText("mcp/tools.text004"),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: uiText("mcp/tools.text005") },
        content: { type: 'string', description: uiText("mcp/tools.text006") },
        parentId: { type: ['string', 'null'], description: uiText("mcp/tools.text007") },
        layout: { type: 'string', enum: LAYOUTS, description: uiText("mcp/tools.text008") },
        type: { type: ['string', 'null'], description: uiText("mcp/tools.text009") },
        isPrefab: { type: 'boolean', description: uiText("mcp/tools.text010") },
        plane: {
          type: 'object',
          description: uiText("mcp/tools.text011"),
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, z: { type: 'number' } },
          required: ['x', 'y', 'w', 'h', 'z'],
        },
      },
      required: ['title'],
    },
    handler: (session, args) => {
      const parentId = optionalNullableString(args, 'parentId');
      const result=executeAction(session,{kind:'create',parent:parentId ?? null,title:requireString(args,'title'),content:optionalString(args,'content'),layout:optionalLayout(args,'layout') ?? 'plain',type:optionalNullableString(args,'type'),prefab:optionalBoolean(args,'isPrefab') ?? false,plane:optionalPlane(args,'plane')});
      const id=result.createdId!;
      return readCard(session, id);
    },
  },

  {
    name: 'instantiate_prefab', title: uiText("mcp/tools.text012"), description: uiText("mcp/tools.text013"),
    inputSchema: { type: 'object', properties: { cardId: CARD_ID, parentId: { type: ['string', 'null'] } }, required: ['cardId'] },
    handler: (session, args) => executeAction(session, { kind: 'instantiate', id: requireString(args, 'cardId'), parent: optionalNullableString(args, 'parentId') ?? null }),
  },
  {
    name: 'detach_prefab', title: uiText("mcp/tools.text014"), description: uiText("mcp/tools.text015"),
    inputSchema: { type: 'object', properties: { cardId: CARD_ID }, required: ['cardId'] },
    handler: (session, args) => executeAction(session, { kind: 'detach', id: requireString(args, 'cardId') }),
  },
  {
    name: 'use_presentation', title: uiText("mcp/tools.text016"), description: uiText("mcp/tools.text017"),
    inputSchema: { type: 'object', properties: { cardId: CARD_ID, sourceId: { type: ['string', 'null'] } }, required: ['cardId', 'sourceId'] },
    handler: (session, args) => executeAction(session, { kind: 'presentation', id: requireString(args, 'cardId'), source: optionalNullableString(args, 'sourceId') ?? null }),
  },

  {
    name: 'set_field',
    title: uiText("mcp/tools.text018"),
    description:
      uiText("mcp/tools.text019") +
      uiText("mcp/tools.text020") +
      uiText("mcp/tools.text021"),
    inputSchema: {
      type: 'object',
      properties: {
        cardId: CARD_ID,
        path: { type: 'string', description: uiText("mcp/tools.text022") },
        value: { description: uiText("mcp/tools.text023") },
      },
      required: ['cardId', 'path', 'value'],
    },
    handler: (session, args) => {
      const cardId = requireString(args, 'cardId');
      const path = requireString(args, 'path');
      if (!path.startsWith('/')) throw new Error(uiText("mcp/tools.text024", {arg0: (path)}));
      if (path === '/doodle' || path.startsWith('/doodle/')) throw new Error(uiText('mcp/extended.doodleField'));
      const value = requirePresent(args, 'value');
      if ((path === '/title' || path === '/content') && typeof value === 'string') executeAction(session, { kind: 'edit', id: cardId, field: path === '/title' ? 'title' : 'content', value });
      else setField(session, cardId, path as `/${string}`, value);
      return readCard(session, cardId);
    },
  },

  {
    name: 'set_layout',
    title: uiText("mcp/tools.text025"),
    description:
      uiText("mcp/tools.text026") +
      uiText("mcp/tools.text027") +
      uiText("mcp/tools.text028") +
      uiText("mcp/tools.text029"),
    inputSchema: {
      type: 'object',
      properties: {
        cardId: CARD_ID,
        layout: { type: 'string', enum: LAYOUTS, description: uiText("mcp/tools.text030") },
        placements: {
          type: 'array',
          description: uiText("mcp/tools.text031"),
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'w', 'h', 'z'],
          },
        },
      },
      required: ['cardId', 'layout'],
    },
    handler: (session, args) => {
      const cardId = requireString(args, 'cardId');
      const layout = requireLayout(args, 'layout');
      const placements = optionalPlacements(args, 'placements');
      executeAction(session,{kind:'layout',id:cardId,layout,placements});
      return readCard(session, cardId);
    },
  },

  {
    name: 'move_card',
    title: uiText("mcp/tools.text032"),
    description:
      uiText("mcp/tools.text033") +
      uiText("mcp/tools.text034"),
    inputSchema: {
      type: 'object',
      properties: {
        cardId: CARD_ID,
        toParentId: { type: ['string', 'null'], description: uiText("mcp/tools.text035") },
        index: { type: 'number', description: uiText("mcp/tools.text036") },
        plane: {
          type: 'object',
          description: uiText("mcp/tools.text037"),
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, z: { type: 'number' } },
          required: ['x', 'y', 'w', 'h', 'z'],
        },
      },
      required: ['cardId', 'toParentId'],
    },
    handler: (session, args) => {
      const cardId = requireString(args, 'cardId');
      const toParentId = optionalNullableString(args, 'toParentId') ?? null;
      // 省略 index 时放到末尾。不能直接用一个大数：reducer 会对越界下标抛错。
      const index = optionalNumber(args, 'index') ?? (toParentId === null ? 0 : listChildren(session, toParentId).entries.length);
      const result=executeAction(session,{kind:'move',id:cardId,parent:toParentId,index,plane:optionalPlane(args,'plane')});
      return { moved: true,...result };
    },
  },

  {
    name: 'delete_card',
    title: uiText("mcp/tools.text038"),
    description:
      uiText("mcp/tools.text039") +
      uiText("mcp/tools.text040"),
    inputSchema: {
      type: 'object',
      properties: { cardId: CARD_ID },
      required: ['cardId'],
    },
    handler:(session,args)=>{const id=requireString(args,'cardId');const deletedCount=collectSubtree(session.state,id).ids.length;executeAction(session,{kind:'delete',id});return {deletedCount};},
  },

  {
    name: 'undo',
    title: uiText("mcp/tools.text041"),
    description: uiText("mcp/tools.text042"),
    inputSchema: { type: 'object', properties: {} },
    handler: (session) => ({ undone: undoLast(session) }),
  },

  {
    name: 'read_tree',
    title: uiText("mcp/tools.text043"),
    description:
      uiText("mcp/tools.text044") +
      uiText("mcp/tools.text045") +
      uiText("mcp/tools.text046"),
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['public', 'private'], description: uiText("mcp/tools.text047") },
        maxDepth: { type: 'number', description: uiText("mcp/tools.text048") },
        cursor: { type: 'string', description: uiText("mcp/tools.text049") },
        limit: { type: 'number', description: uiText("mcp/tools.text050") },
      },
    },
    handler: (session, args) =>
      readTree(session, {
        scope: optionalScope(args, 'scope'),
        maxDepth: optionalNumber(args, 'maxDepth'),
        cursor: optionalString(args, 'cursor'),
        limit: optionalNumber(args, 'limit'),
      }),
  },

  {
    name: 'read_card',
    title: uiText("mcp/tools.text051"),
    description: uiText("mcp/tools.text052"),
    inputSchema: {
      type: 'object',
      properties: {
        cardId: CARD_ID,
        includeChildren: { type: 'boolean', description: uiText("mcp/tools.text053") },
      },
      required: ['cardId'],
    },
    handler: (session, args) =>
      readCard(session, requireString(args, 'cardId'), {
        includeChildren: optionalBoolean(args, 'includeChildren'),
      }),
  },

  {
    name: 'list_children',
    title: uiText("mcp/tools.text054"),
    description:
      uiText("mcp/tools.text055"),
    inputSchema: {
      type: 'object',
      properties: {
        parentId: CARD_ID,
        cursor: { type: 'string', description: uiText("mcp/tools.text049") },
        limit: { type: 'number', description: uiText("mcp/tools.text056") },
      },
      required: ['parentId'],
    },
    handler: (session, args) =>
      listChildren(session, requireString(args, 'parentId'), {
        cursor: optionalString(args, 'cursor'),
        limit: optionalNumber(args, 'limit'),
      }),
  },

  {
    name: 'search',
    title: uiText("mcp/tools.text057"),
    description: uiText("mcp/tools.text058"),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: uiText("mcp/tools.text059") },
        cursor: { type: 'string', description: uiText("mcp/tools.text049") },
        limit: { type: 'number', description: uiText("mcp/tools.text060") },
      },
      required: ['query'],
    },
    handler: (session, args) =>
      search(session, requireString(args, 'query'), {
        limit: optionalNumber(args, 'limit'),
        cursor: optionalString(args, 'cursor'),
      }),
  },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/**
 * 调用一个工具。
 *
 * 必填项与类型在**这里**校验，业务错误（卡不存在、会成环）从 core 原样抛出 ——
 * 不要在这里 catch 成空结果：AI 需要看到"为什么不行"才能改。§9.3 的"人机同一套操作层"
 * 也要求工具层不要给 AI 一套更弱的语义。
 */
/** Validate at the desktop boundary as well as the stdio boundary. */
export function validateToolCall(name:string,args:Record<string,unknown>):ToolDef {
 const tool=findTool(name);
 if(!tool)throw new Error(uiText("mcp/tools.text061",{arg0:name,arg1:TOOLS.map(t=>t.name).join(', ')}));
 const validate=(value:unknown,schema:Record<string,unknown>,path:string):void=>{
  const types=Array.isArray(schema.type)?schema.type:typeof schema.type==='string'?[schema.type]:[];
  if(types.length && !types.some(type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='object'?value!==null && typeof value==='object' && !Array.isArray(value):type==='number'?typeof value==='number' && Number.isFinite(value):type==='integer'?typeof value==='number' && Number.isSafeInteger(value):typeof value===type))throw new Error(uiText('mcp/tools.invalidArguments',{arg0:path}));
  if(typeof value==='number' && (typeof schema.minimum==='number' && value<schema.minimum || typeof schema.maximum==='number' && value>schema.maximum))throw new Error(uiText('mcp/tools.invalidArguments',{arg0:path}));
  if(Array.isArray(schema.enum) && !schema.enum.includes(value))throw new Error(uiText('mcp/tools.invalidEnum',{arg0:path,arg1:schema.enum.map(String).join(' / ')}));
  if(value!==null && typeof value==='object' && !Array.isArray(value)){
   const record=value as Record<string,unknown>;
   for(const key of (schema.required as string[]|undefined) ?? [])if(!Object.hasOwn(record,key) || record[key]===undefined)throw new Error(uiText('mcp/tools.invalidArguments',{arg0:`${path}.${key}`}));
   const properties=(schema.properties ?? {}) as Record<string,Record<string,unknown>>;
   for(const [key,item] of Object.entries(record)){
    if(schema.additionalProperties===false && !Object.hasOwn(properties,key))throw new Error(uiText('mcp/tools.invalidArguments',{arg0:`${path}.${key}`}));
    if(Object.hasOwn(properties,key) && item!==undefined)validate(item,properties[key]!,`${path}.${key}`);
   }
  }
  if(Array.isArray(value) && schema.items)for(const [index,item] of value.entries())validate(item,schema.items as Record<string,unknown>,`${path}[${index}]`);
 };
 validate(args,tool.inputSchema as unknown as Record<string,unknown>,name);
 return tool;
}
export function callTool(session: Session,name:string,args:Record<string,unknown>={}):unknown {
 return validateToolCall(name,args).handler(session,args);
}

/** 给 `tools/list` 用的纯数据表示（去掉处理函数）。 */
export function toolListPayload(): Array<{ name: string; title: string; description: string; inputSchema: JsonSchema }> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

// ── 参数读取与校验 ─────────────────────────────────────────────────────────────

function requirePresent(args: Record<string, unknown>, key: string): unknown {
  const value = args[key];
  // `null` 是合法值（例如 /type 置空），但 `undefined` 说明调用方漏了参数。
  if (value === undefined) throw new Error(uiText("mcp/tools.text063", {arg0: (key)}));
  return value;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = requirePresent(args, key);
  if (typeof value !== 'string' || value === '') throw new Error(uiText("mcp/tools.text064", {arg0: (key)}));
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(uiText("mcp/tools.text065", {arg0: (key)}));
  return value;
}

function optionalNullableString(args: Record<string, unknown>, key: string): string | null | undefined {
  const value = args[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new Error(uiText("mcp/tools.text066", {arg0: (key)}));
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(uiText("mcp/tools.text067", {arg0: (key)}));
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(uiText("mcp/tools.text068", {arg0: (key)}));
  return value;
}

function optionalLayout(args: Record<string, unknown>, key: string): Layout | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(LAYOUTS as string[]).includes(value)) {
    throw new Error(uiText("mcp/tools.text069", {arg0: (key), arg1: (LAYOUTS.join(' / '))}));
  }
  return value as Layout;
}

/** §9.2 的 `read_tree(scope?)`：只看公有或私有区域。 */
function optionalScope(args: Record<string, unknown>, key: string): 'public' | 'private' | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value !== 'public' && value !== 'private') {
    throw new Error(uiText("mcp/tools.text070", {arg0: (key), arg1: (String(value))}));
  }
  return value;
}

function requireLayout(args: Record<string, unknown>, key: string): Layout {
  const layout = optionalLayout(args, key);
  if (layout === undefined) throw new Error(uiText("mcp/tools.text071", {arg0: (key)}));
  return layout;
}

/** 一组平面坐标。元素形状在这里逐个校验，免得把半个坏对象传进 core。 */
function optionalPlacements(
  args: Record<string, unknown>,
  key: string,
): Array<{ x: number; y: number; w: number; h: number; z: number }> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(uiText("mcp/tools.text072", {arg0: (key)}));

  return value.map((item, index) => {
    const one = optionalPlane({ [key]: item }, key);
    if (one === undefined) throw new Error(uiText("mcp/tools.text073", {arg0: (key), arg1: (index)}));
    return one;
  });
}

function optionalPlane(
  args: Record<string, unknown>,
  key: string,
): { x: number; y: number; w: number; h: number; z: number } | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new Error(uiText("mcp/tools.text074", {arg0: (key)}));

  const raw = value as Record<string, unknown>;
  for (const axis of ['x', 'y', 'w', 'h', 'z']) {
    if (typeof raw[axis] !== 'number' || !Number.isFinite(raw[axis])) {
      throw new Error(uiText("mcp/tools.text075", {arg0: (key), arg1: (axis)}));
    }
  }
  return { x: raw['x'] as number, y: raw['y'] as number, w: raw['w'] as number, h: raw['h'] as number, z: raw['z'] as number };
}
