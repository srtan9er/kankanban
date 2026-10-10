import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import '../src/node/bootstrap.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { openSession, readCard } from '../src/core/workspace.ts';
import { createServer } from '../src/mcp/server.ts';
import { toolListPayload } from '../src/mcp/tools.ts';

/** 起一对内存传输，把服务端与客户端接起来 —— 走的是真协议，不是直接调函数。 */
async function connect(root: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const session = openSession(root, { builtins: false, clientId: 'ai' });
  const server = createServer(session);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  assert.ok(Array.isArray(content) && content.length > 0, `结果里没有 content：${JSON.stringify(result)}`);
  const block = content[0];
  assert.equal(block?.type, 'text');
  return block?.text ?? '';
}

function jsonOf<T>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

async function withClient(body: (client: Client, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'kkb-rpc-'));
  const { client, close } = await connect(root);
  try {
    await body(client, root);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
}

// ── §4.3 断言五：能通过 MCP 工具建卡、移卡、改字段、读树 ──────────────────────

test('tools/list 返回的全部工具与本地目录逐字一致', async () => {
  await withClient(async (client) => {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();

    assert.deepEqual(
      names,
      toolListPayload()
        .map((t) => t.name)
        .sort(),
    );

    const create = listed.tools.find((t) => t.name === 'create_card');
    assert.ok(create !== undefined);
    assert.equal(create.description, toolListPayload().find((t) => t.name === 'create_card')?.description);
    // JSON Schema 必须原样透传，不能被转换成别的东西
    assert.equal((create.inputSchema as { type?: string }).type, 'object');
    assert.ok((create.inputSchema as { properties?: object }).properties !== undefined);
  });
});

test('通过协议建卡 → 改字段 → 读卡', async () => {
  await withClient(async (client, root) => {
    const created = jsonOf<{ id: string }>(
      await client.callTool({ name: 'create_card', arguments: { title: '甲', content: '# 一' } }),
    );
    assert.equal(typeof created.id, 'string');

    await client.callTool({
      name: 'set_field',
      arguments: { cardId: created.id, path: '/title', value: '乙' },
    });

    const card = jsonOf<{ title: string; content: string }>(
      await client.callTool({ name: 'read_card', arguments: { cardId: created.id } }),
    );
    assert.equal(card.title, '乙');
    assert.equal(card.content, '# 一');

    // 协议之外也要真的落盘：用 core 直接读同一个工作区
    const { state } = (await import('../src/core/storage/workspace-io.ts')).openWorkspace(root);
    assert.equal(state.cards.get(created.id)?.title, '乙');
  });
});

test('通过协议移卡 → 读树', async () => {
  await withClient(async (client) => {
    const parent = jsonOf<{ id: string }>(
      await client.callTool({ name: 'create_card', arguments: { title: 'P', layout: 'ordered' } }),
    );
    const child = jsonOf<{ id: string }>(
      await client.callTool({ name: 'create_card', arguments: { title: 'C' } }),
    );

    await client.callTool({
      name: 'move_card',
      arguments: { cardId: child.id, toParentId: parent.id, index: 0 },
    });

    const children = jsonOf<{ entries: Array<{ id: string }> }>(
      await client.callTool({ name: 'list_children', arguments: { parentId: parent.id } }),
    );
    assert.deepEqual(children.entries.map((e) => e.id), [child.id]);

    const tree = jsonOf<{ nodes: Array<{ id: string; children: Array<{ id: string }> }> }>(
      await client.callTool({ name: 'read_tree', arguments: { maxDepth: 2 } }),
    );
    assert.deepEqual(tree.nodes.map((n) => n.id), [parent.id]);
    assert.deepEqual(tree.nodes[0]?.children.map((n) => n.id), [child.id]);
  });
});

test('通过协议删卡后再读树就看不到它了', async () => {
  await withClient(async (client) => {
    const gone = jsonOf<{ id: string }>(
      await client.callTool({ name: 'create_card', arguments: { title: 'G' } }),
    );

    const deleted = jsonOf<{ deletedCount: number }>(
      await client.callTool({ name: 'delete_card', arguments: { cardId: gone.id } }),
    );
    assert.equal(deleted.deletedCount, 1);

    const tree = jsonOf<{ nodes: Array<{ id: string }> }>(
      await client.callTool({ name: 'read_tree', arguments: {} }),
    );
    assert.deepEqual(tree.nodes, []);
  });
});

test('通过协议撤销可以回退上一次改动', async () => {
  await withClient(async (client) => {
    const card = jsonOf<{ id: string }>(
      await client.callTool({ name: 'create_card', arguments: { title: '旧' } }),
    );
    await client.callTool({ name: 'set_field', arguments: { cardId: card.id, path: '/title', value: '新' } });

    const undone = jsonOf<{ undone: boolean }>(await client.callTool({ name: 'undo', arguments: {} }));

    assert.equal(undone.undone, true);
    const back = jsonOf<{ title: string }>(
      await client.callTool({ name: 'read_card', arguments: { cardId: card.id } }),
    );
    assert.equal(back.title, '旧');
  });
});

// ── 错误路径：工具失败要作为 isError 回到调用方，而不是把会话弄崩 ──────────────

test('调用不存在的工具时返回 isError，且消息里说明原因', async () => {
  await withClient(async (client) => {
    const result = (await client.callTool({ name: 'nope', arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };

    assert.equal(result.isError, true);
    assert.match(textOf(result), /未知工具|nope/);
  });
});

test('业务错误（卡不存在）也回到 isError，并且不影响后续调用', async () => {
  await withClient(async (client) => {
    const bad = (await client.callTool({ name: 'read_card', arguments: { cardId: 'ghost' } })) as {
      isError?: boolean;
    };
    assert.equal(bad.isError, true);

    const ok = jsonOf<{ id: string }>(await client.callTool({ name: 'create_card', arguments: { title: '之后' } }));
    assert.equal(typeof ok.id, 'string');
  });
});

test('服务端与客户端看到的是同一个工作区（同一次会话共享 core 状态）', async () => {
  await withClient(async (client, root) => {
    const card = jsonOf<{ id: string }>(
      await client.callTool({ name: 'create_card', arguments: { title: '共享' } }),
    );

    const session2 = openSession(root, { builtins: false, clientId: 'other' });
    assert.equal(readCard(session2, card.id).title, '共享');
  });
});
