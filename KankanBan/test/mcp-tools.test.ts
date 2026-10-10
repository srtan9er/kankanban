import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import '../src/node/bootstrap.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSession } from '../src/core/workspace.ts';
import type { Session } from '../src/core/workspace.ts';
import { TOOLS, callTool, findTool, toolListPayload } from '../src/mcp/tools.ts';

function withSession(body: (session: Session) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'kkb-mcp-'));
  try {
    body(openSession(root, { builtins: false, clientId: 'ai' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function idOf(result: unknown): string {
  const id = (result as { id?: unknown }).id;
  assert.equal(typeof id, 'string', `期望返回带 id 的对象，实际是 ${JSON.stringify(result)}`);
  return id as string;
}

// ── 目录本身的形状 ─────────────────────────────────────────────────────────────

test('工具名单覆盖 §4.3 断言五点名的四件事', () => {
  const names = TOOLS.map((t) => t.name);

  for (const required of ['create_card', 'move_card', 'set_field', 'read_tree']) {
    assert.ok(names.includes(required), `缺少工具 ${required}`);
  }
});

test('每个工具都有可读的说明与合法的 inputSchema', () => {
  for (const tool of TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `工具名 ${tool.name} 不是 snake_case`);
    assert.ok(tool.title.length > 0, `${tool.name} 缺 title`);
    assert.ok(tool.description.length >= 8, `${tool.name} 的 description 太短，AI 读不懂`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} 的 inputSchema 必须是 object`);

    for (const key of tool.inputSchema.required ?? []) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, key),
        `${tool.name}: 必填项 ${key} 没有出现在 properties 里`,
      );
    }
  }
});

test('工具名不重复', () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test('toolListPayload 不含处理函数（要能直接序列化给 tools/list）', () => {
  const payload = toolListPayload();

  assert.equal(payload.length, TOOLS.length);
  for (const item of payload) {
    assert.equal(typeof item.name, 'string');
    assert.equal(JSON.stringify(item).includes('handler'), false);
  }
});

test('findTool 找得到、找不到返回 undefined', () => {
  assert.equal(findTool('create_card')?.name, 'create_card');
  assert.equal(findTool('nope'), undefined);
});

// ── 调用行为 ───────────────────────────────────────────────────────────────────

test('create_card 建卡并返回 id；可以挂到父卡下', () => {
  withSession((s) => {
    const parent = idOf(callTool(s, 'create_card', { title: 'P', layout: 'ordered' }));
    const child = idOf(callTool(s, 'create_card', { title: 'C', parentId: parent }));

    const children = callTool(s, 'list_children', { parentId: parent }) as { entries: Array<{ id: string }> };
    assert.deepEqual(children.entries.map((e) => e.id), [child]);
  });
});

test('set_field 改标题后 read_card 能读到', () => {
  withSession((s) => {
    const id = idOf(callTool(s, 'create_card', { title: '旧' }));

    callTool(s, 'set_field', { cardId: id, path: '/title', value: '新' });

    const card = callTool(s, 'read_card', { cardId: id }) as { title: string };
    assert.equal(card.title, '新');
  });
});

test('move_card 跨父移动后两边的子卡列表都对了', () => {
  withSession((s) => {
    const from = idOf(callTool(s, 'create_card', { title: 'from' }));
    const to = idOf(callTool(s, 'create_card', { title: 'to', layout: 'ordered' }));
    const card = idOf(callTool(s, 'create_card', { title: 'card', parentId: from }));

    callTool(s, 'move_card', { cardId: card, toParentId: to, index: 0 });

    const fromChildren = callTool(s, 'list_children', { parentId: from }) as { entries: unknown[] };
    const toChildren = callTool(s, 'list_children', { parentId: to }) as { entries: Array<{ id: string }> };
    assert.deepEqual(fromChildren.entries, []);
    assert.deepEqual(toChildren.entries.map((e) => e.id), [card]);
  });
});

test('read_tree 返回未删除的根卡', () => {
  withSession((s) => {
    const keep = idOf(callTool(s, 'create_card', { title: 'K' }));
    const gone = idOf(callTool(s, 'create_card', { title: 'G' }));
    callTool(s, 'delete_card', { cardId: gone });

    const tree = callTool(s, 'read_tree', {}) as { nodes: Array<{ id: string }> };
    assert.deepEqual(tree.nodes.map((n) => n.id), [keep]);
  });
});

test('search 命中标题与正文', () => {
  withSession((s) => {
    const a = idOf(callTool(s, 'create_card', { title: '买牛奶' }));
    const b = idOf(callTool(s, 'create_card', { title: '别的事', content: '顺便买牛奶' }));

    const hits = callTool(s, 'search', { query: '买牛奶' }) as { items: Array<{ id: string }> };
    assert.deepEqual(hits.items.map((h) => h.id).sort(), [a, b].sort());
  });
});

// ── §9.2 的读模型参数：scope / includeChildren / 分页 ────────────────────────

test('read_tree 支持 scope 过滤（§9.2 的 read_tree(scope?)）', () => {
  withSession((s) => {
    // 注意：MCP 的 create_card **不暴露 id**（§9.3：粒度是"人类操作"，没人手打卡片 id），
    // 所以这里造不出内置的 001/002。公有区域的**内容**由 core 层的
    // `test/read-model.test.ts` 覆盖，这里只验参数确实接通了。
    const a = idOf(callTool(s, 'create_card', { title: '私有一' }));
    const b = idOf(callTool(s, 'create_card', { title: '私有二' }));

    const priv = callTool(s, 'read_tree', { scope: 'private' }) as { nodes: Array<{ id: string }> };
    const pub = callTool(s, 'read_tree', { scope: 'public' }) as { nodes: Array<{ id: string }> };

    assert.deepEqual(priv.nodes.map((n) => n.id).sort(), [a, b].sort());
    assert.deepEqual(pub.nodes, [], '没有公有根卡时应当返回空，而不是忽略 scope');
  });
});

test('read_tree 的 scope 取值非法时抛错（而不是静默不过滤）', () => {
  withSession((s) => {
    assert.throws(() => callTool(s, 'read_tree', { scope: 'everywhere' }), /public|private/);
  });
});

test('read_card 的 includeChildren 为真时带子卡条目', () => {
  withSession((s) => {
    const parent = idOf(callTool(s, 'create_card', { title: 'P', layout: 'ordered' }));
    const child = idOf(callTool(s, 'create_card', { title: 'C', parentId: parent }));

    const plain = callTool(s, 'read_card', { cardId: parent }) as { children?: unknown };
    assert.equal(plain.children, undefined);

    const withKids = callTool(s, 'read_card', { cardId: parent, includeChildren: true }) as {
      children: Array<{ id: string }>;
    };
    assert.deepEqual(withKids.children.map((e) => e.id), [child]);
  });
});

test('search 分页：结果分页返回，游标非法时抛错', () => {
  withSession((s) => {
    for (const title of ['牛奶一', '牛奶二', '牛奶三']) callTool(s, 'create_card', { title });

    const first = callTool(s, 'search', { query: '牛奶', limit: 2 }) as {
      items: Array<{ id: string }>;
      nextCursor?: string;
    };
    assert.equal(first.items.length, 2);
    assert.equal(typeof first.nextCursor, 'string');

    const second = callTool(s, 'search', { query: '牛奶', limit: 2, cursor: first.nextCursor }) as {
      items: Array<{ id: string }>;
    };
    assert.equal(second.items.length, 1);

    assert.throws(() => callTool(s, 'search', { query: '牛奶', cursor: 'nope' }), /cursor 非法/);
  });
});

test('undo 撤销最后一次工具调用造成的改动', () => {
  withSession((s) => {
    const id = idOf(callTool(s, 'create_card', { title: '旧' }));
    callTool(s, 'set_field', { cardId: id, path: '/title', value: '新' });

    const result = callTool(s, 'undo', {}) as { undone: boolean };
    assert.equal(result.undone, true);
    assert.equal((callTool(s, 'read_card', { cardId: id }) as { title: string }).title, '旧');
  });
});

test('delete_card 会报出将删除多少张卡（级联要人先知道）', () => {
  withSession((s) => {
    const root = idOf(callTool(s, 'create_card', { title: 'R' }));
    idOf(callTool(s, 'create_card', { title: 'C1', parentId: root }));
    idOf(callTool(s, 'create_card', { title: 'C2', parentId: root }));

    const result = callTool(s, 'delete_card', { cardId: root }) as { deletedCount: number };
    assert.equal(result.deletedCount, 3);
  });
});

// ── 错误路径：工具层的错误要说人话，AI 才知道下一步怎么改 ────────────────────

test('调用不存在的工具时抛错并列出可用工具', () => {
  withSession((s) => {
    assert.throws(() => callTool(s, 'nope', {}), /未知工具|nope/);
  });
});

test('缺少必填参数时抛错并点名是哪个', () => {
  withSession((s) => {
    assert.throws(() => callTool(s, 'create_card', {}), /title/);
    assert.throws(() => callTool(s, 'move_card', { cardId: 'x' }), /toParentId|index/);
  });
});

test('参数类型不对时抛错，而不是把 undefined 写进卡里', () => {
  withSession((s) => {
    assert.throws(() => callTool(s, 'set_field', { cardId: 'x', path: '/title', value: undefined }), /value/);
  });
});

test('业务错误（卡不存在）原样抛出，不吞成空结果', () => {
  withSession((s) => {
    assert.throws(() => callTool(s, 'read_card', { cardId: 'ghost' }), /不存在|ghost/);
  });
});
