# 外部主题

在设置的「主题与正文排版」中打开主题文件夹。用外部编辑器修改 CSS，再点击「重新加载」。应用不包含主题编辑器。

文件位于应用数据目录的 `themes/`，供本机各工作区复用；所选主题 ID 保存于工作区 `.kkb/view-state.json`，不修改正文、不进入协作记录、不随分享包携带。没有选定主题时使用完整的内置日夜样式，也会加载 `base.user.css`。

## 文件格式

最简单的主题就是 `my-theme.css`。也支持目录：

```text
themes/
  base.user.css           # 可选，作用于所有主题
  my-theme.css
  my-theme.user.css       # 可选，仅覆盖 my-theme
  forest/
    theme.css
    theme.json            # 可选：{"name":"山林","mode":"dark"}
    theme.user.css
    fonts/body.woff2
```

单文件主题的可选描述文件为 `my-theme.json`。`mode` 可为 `light` 或 `dark`；省略则跟随应用日夜模式。无描述文件时名称取文件名。内置示例「纸间」和「纸间 · 夜色」首次使用时复制到主题目录，之后不覆盖用户修改。

加载顺序：内置完整样式 → 所选主题 → `base.user.css` → 当前主题的 `.user.css`。CSS 原有的选择器优先级和 `!important` 规则仍生效，后加载并不强制战胜更具体的选择器。建议用 CSS 变量作为主要入口，避免不必要的高优先级。

支持普通选择器、伪元素、媒体查询、`@font-face`、CSS 变量及本地 `@import`；导入保留媒体条件、layer 和 supports 条件。字体和图片相对路径以引用它们的 CSS 文件为基准。支持 woff/woff2/ttf/otf 和 png/jpg/gif/webp。资源打包后不会暴露文件系统任意读取入口；导入和资源必须位于主题根目录内，不加载远程 URL。CSS 文件最多 1 MiB、单资源最多 8 MiB，总加载预算 32 MiB，循环导入会报错并保留原主题。

## 从少量修改开始

```css
:root {
  --palette-card: #fff4b8;
  --md-font-size: 16px;
  --md-line-height: 1.8;
  --md-h1-color: var(--palette-accent);
}
.kkb-markdown blockquote { border-left-style: double; }
```

八个基础色仍为 `--palette-card/prefab/instance/background/text/accent/danger/handle`。边框、悬浮和选中状态自动派生；主题可以覆盖任意派生变量，也可以添加自己的颜色。八色是默认来源，不是颜色数量限制。暗色模式在 `data-theme="dark"` 下切换混合方向，主题可另外覆盖。

排版变量和合理缺省值见 `defaults.css`。包括正文与代码字体、字号、行高、段落距离、各级标题、引用、链接、表格等。颜色默认从调色盘继承，局部覆盖不要求重写整套主题。

文字上下留白默认同用 `--md-inset-y`，也可分别设置 `--md-inset-top` 与 `--md-inset-bottom`；图片、表格和涂鸦仍保留自身坐标。未单独设置的方向继续回退到 `--md-inset-y`。

## 预览与应用

「预览」临时替换当前窗口的实际样式，并提供正文样张；「结束预览」或离开设置恢复已保存的主题。「应用主题」保存选择并同步同一工作区的所有窗口。「重新加载」重读外部文件，应用状态下同步其他窗口；预览状态下仅刷新当前预览。CSS 解析或资源加载失败时保留之前的样式。

主题作用于整个 Webview，可用 `.manager-shell`、`.proto-note`、`.task-card`、`.kkb-markdown`、`.markdown-editor` 和 `.git-panel` 等组件选择器。正文块额外带 `data-md-kind`，便于同时覆盖含图片时的段落。窗口拖动、树关系、对象保存坐标及原生窗口约束不属于主题配置。

## 排版测量

`metrics.ts` 用隐藏的真实元素读取字体、字号、字重、行高、字距和段落间距。主题或字体加载完成时发出 `kkb:theme-change`，正文更新 Pretext 测量与缓存键。正常流由浏览器排版，自由图片绕排仍由 Pretext 管理行位置；不要对绕排行应用改变坐标系的 transform 或手工 absolute 定位。图片、表格和涂鸦的保存坐标不会因换主题而改写。

Typora 的 CSS 可作为移植参考，但 `#write`、CodeMirror 和菜单 DOM 不同，需要适配选择器；不是原样兼容加载。

## LightMind

`lightmind.css` 是本机 Typora LightMind 亮色主题的 KankanBan 移植版：保留原有暖纸色、森林绿、霞鹜文楷字体栈、18px 正文和深海军蓝代码块，并适配卡片、正文、表格与编辑区。主题固定使用亮色派生规则；与其他内置示例一样，首次安装后不覆盖个人修改。

字体沿用原主题的本地回退链，不联网下载。要与 Typora 使用同一字体，请在同一系统中安装原主题使用的 LXGW WenKai（霞鹜文楷）和 JetBrains Mono；缺失时两者会按各自回退链显示。当前没有对应渲染器的 Typora 元素（如 Mermaid、MathJax、CodeMirror 语法高亮）不由 CSS 添加功能。
