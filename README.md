# KankanBan

以**卡片为唯一原语**的项目管理工具，适用于团队项目和个人项目。对美术策划同学友好，集成 git 图形化操作，AI 通过 MCP 深度参与。

核心设计立场：**卡片是唯一的原语，看板不是一种功能，而是卡片在容器里自然长出来的形态。**

完整设计见 [`docs/开发文档.md`](docs/开发文档.md)。

## 现在有什么

**阶段一（核心库 + MCP）和阶段二（Electron 最小 UI）已完成。**

- `@kankanban/core` —— 卡片模型、`.kkb` 文件存储、树操作、事件日志、撤销重做。不依赖 Electron。
- `@kankanban/mcp` —— 把 core 的命令层包成 17 个 MCP 工具，独立 stdio 入口。
- `@kankanban/app` —— Electron 桌面端。每张浮卡是一个透明无边框窗口，main 板是应用外壳。

182 个测试全绿。

## 快速开始

```bash
pnpm install

# 跑测试和类型检查
pnpm test
pnpm typecheck
```

### 起桌面端

```bash
cd packages/app
pnpm start -- --workspace <工作区目录>
```

工作区目录里会生成 `.kkb/`。不传就取 `KKB_WORKSPACE`，再缺省取当前目录。

**工作区锁是排他的**：同一时刻只能有一个客户端（app 或 MCP server）写同一个工作区。

开发期有两个自查开关：

| 环境变量 | 作用 |
|---|---|
| `KKB_VERIFY=1` | 把阶段二的验收标准逐条跑一遍并打印结果 |
| `KKB_CAPTURE_AFTER=<毫秒>` | 把窗口内容降采样成**字符画**打到 stdout，同时存 PNG |

字符画是给读不了图片的 AI 看的：布局在纯文本里也是可见的。

### 让 AI 接进来

**推荐：开着 app，让 AI 连进来。** app 会在 `127.0.0.1:17381/mcp` 上跑一个 Streamable HTTP 的 MCP 端点
（端口被占用会往后让，实际地址显示在 main 板的设置栏）。

MCP 客户端这样配：

```yaml
serverName: kankanban
transport: streamable-http
url: http://127.0.0.1:17381/mcp
failOnStartupError: false    # app 没开时退避重试，等你开起来
```

这样 **app 是唯一的写者**：AI 的写入和你自己拖卡走的是同一条路——落盘、广播、窗口立刻更新。
人和 AI 看的是同一份数据，也不存在工作区锁冲突。

**也可以只让 AI 用（不开 UI）**，走独立 stdio 进程：

```bash
pnpm mcp /path/to/workspace
```

注意这种模式下它和 app 是互斥的：同一个工作区同一时刻只能有一个写者。

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
