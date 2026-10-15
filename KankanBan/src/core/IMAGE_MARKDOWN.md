# 图片正文语法

图片的显示位置以卡片正文为准，`images` 只保存资产标识、文件名和原始尺寸。

粘贴和拖入图片时直接生成受控标签，正文编辑器将它显示为 `<image_0>` 等原子字段。`name` 是每张卡片内唯一的稳定名称，写入正文标签，重排或删除其它图片后不变。手写的普通 Markdown 引用 `![说明](../assets/images/<SHA256>.<扩展名>)` 仍可读取，实际保存正文时补齐名称。受控标签格式：

```xml
<image src="../assets/images/<SHA256>.png" layout="inline" name="image_0" width="240" height="160" layer="0">说明</image>
```

图片布局只有四种：`inline`（文中）、`float`（自由环绕）、`overlay`（文字上）、`underlay`（文字下）。普通 Markdown 和省略 `layout` 的标签都按 `inline` 解释，正文中的换行和空行负责表达段落。

旧标签的 `layout="block"` 仅在读取时解释为 `inline`。解析不会重写正文、磁盘或历史记录；通过 `serializeImage` 重新编辑该图片时，输出规范的 `inline`。分享包保留原正文，导入后使用相同的读取规则。

`src` 仅允许工作区资产的严格散列路径；允许的其他属性为 `layout/width/height/x/y/alt/name/layer`。`name` 为 `image_` 加安全整数，`layer` 为绝对值不超过 1000000 的整数。尺寸为 8–16384，坐标绝对值不超过 10000000。非法属性、非法几何值或任意嵌套 HTML 原样当作文字，不执行。代码区中的示例也保持文字。

图层只调整图片相互的叠放顺序；文字下方与上方分别排序，选择不会抬高位图。GUI 拖动、缩放可向右、向下扩展正文区域，释放仅收回额外空白并保留对象新位置与尺寸，名称与图层随普通正文编辑事务保存、撤销、同步和分享。

这套图片布局与卡片自身的 `plain/ordered/columns/grid/library/plane` 布局独立。
