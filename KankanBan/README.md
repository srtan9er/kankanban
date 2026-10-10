# KankanBan 工程

项目介绍、运行方法、操作说明与更新计划见 [仓库 README](../README.md)。本目录是当前桌面应用的完整工程。

## 代码结构

| 目录 | 内容 |
| --- | --- |
| `src/core/` | 卡片树、布局、预制体、涂鸦、事务与持久化 |
| `src/webview/` | React 界面、窗口交互与桌面桥接 |
| `src/platform/` | 文件系统适配与缓冲写入 |
| `src/node/`、`src/cli/`、`src/mcp/` | Node 写者锁、CLI 与 MCP 入口 |
| `src/i18n/` | 程序文案表与接入规范 |
| `src-tauri/` | 原生窗口、吸附、工作区路径和系统对话框 |
| `scripts/` | 开发服务启动与资源生成 |
| `test/` | 现有回归测试 |

界面入口：`src/webview/main.tsx` → `WorkspaceApp.tsx`。独立卡片由 `PrototypeNote.tsx` 呈现。

程序文字使用 `uiText`／Rust `crate::i18n::text`，具体规则见 [多语言规范](src/i18n/README.md)。皮肤颜色由 `platte.css` 的配色表派生。

CLI 与 MCP 和桌面应用共用领域模型及工作区写者锁。浏览器预览使用独立数据，不连接桌面工作区。
