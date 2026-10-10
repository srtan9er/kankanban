# KankanBan

第一轮迭代已接入原型式便签和卡片树。请先阅读 [迭代说明与实机验收](../ITERATION_1.md)。

- 桌面开发：`npm run app`
- 浏览器预览：`npm run dev`（独立预览数据，不替代桌面测试）
- 类型与测试：`npm run check`
- 生成 Windows 程序：`npm run app:build -- --no-bundle`
- 当前界面入口：`src/webview/main.tsx` → `WorkspaceApp.tsx`

`sticky-tauri/` 原型在工程的同级目录保留；设计评估见 [DESIGN_AND_ASSESSMENT.md](../DESIGN_AND_ASSESSMENT.md)。
