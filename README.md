# KankanBan

以**卡片为唯一原语**的项目管理工具，适用于团队项目和个人项目。对美术策划同学友好，集成 git 图形化操作，AI 通过 MCP 深度参与。

核心设计立场：**卡片是唯一的原语，看板不是一种功能，而是卡片在容器里自然长出来的形态。**

完整设计见 [`docs/开发文档.md`](docs/开发文档.md)。

## 现在有什么

**阶段一（核心库 + MCP）已完成**，还没有界面。

- `@kankanban/core` —— 卡片模型、`.kkb` 文件存储、树操作、事件日志、撤销重做。不依赖 Electron。
- `@kankanban/mcp` —— 把 core 的命令层包成 17 个 MCP 工具，独立 stdio 入口。

179 个测试全绿。

## 快速开始

```bash
pnpm install

# 跑测试和类型检查（179 个用例）
pnpm test
pnpm typecheck
```

### 起一个 MCP server

```bash
pnpm mcp /path/to/workspace
# 等价于 node packages/mcp/src/bin.ts /path/to/workspace
```

工作区目录里会生成 `.kkb/`（默认应该进 `.gitignore`）。不带参数时取 `KKB_WORKSPACE` 环境变量，再缺省取当前目录。

参数：

| 参数 | 说明 |
|---|---|
| `<目录>` | 工作区目录 |
| `--dir, -d <目录>` | 同上 |
| `--no-lock` | 不加工作区锁。只有在确定没有别的进程在写同一个工作区时才用 |
| `--help, -h` | 帮助 |

接进 MCP 客户端时，`command` 用 `node`，`args` 指向 `packages/mcp/src/bin.ts`。
需要 Node 22.18+ / 23.6+ / 24（依赖原生 TypeScript 类型剥离，没有构建步骤）。

### 直接用代码

```ts
import { Workspace, boardOverview } from '@kankanban/core'

const ws = await Workspace.open({ dir: './my-project' })

const column = ws.childCards('001')[0]!.id        // 看板的第一列
const { created } = await ws.execute({
  type: 'card_create',
  parent: column,
  title: '主角待机动画',
})

await ws.execute({ type: 'card_move', id: created!, parent: '完成列的 id' })
await ws.undo()                                    // 撤销
await ws.close()
```

**唯一的写入入口是 `Workspace.execute(command)`。** UI 直接调它，MCP server 把它包成工具，人和 AI 因此天然走同一条路。

## 几个不那么显然的设计

**没有 `status` 字段。** 一张卡在哪一列，由它的 `parent` 决定。"Done 就是一列"。

**`children` 是数组，下标即顺序。** 没有 `order` 字段。

**删除是软删除。** 置 `trashed: true`，查询层过滤。子树一起从视图里消失，但文件都还在。

**文件是真相，事件日志是派生的流水。** 启动时从卡片文件读树，不从日志重放。日志的用途是后续同步、审计，以及回答"最近改了什么"。

**撤销走命令栈，不走日志重放。** 撤销是逐字节的——`updatedAt` 也按记录还原。

## 目录

```
docs/开发文档.md      完整设计文档（含修订记录和风险）
packages/core/        核心库，不依赖 Electron
packages/mcp/         MCP 服务端与 stdio 入口
```
