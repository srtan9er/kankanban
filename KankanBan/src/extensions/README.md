# 扩展接入（接口 v2）

扩展入口位于卡片管理器的「扩展」标签。双击入口每次创建新窗口；入口不是树上的卡片节点，不参与预制体或树关系移动。所有窗口共享当前工作区的服务配置、任务和执行结果，各自保留窗口位置、大小及浏览位置。关闭窗口不停止服务，也不等于卸载。

当前实现随应用编译的内置扩展。尚未提供第三方代码动态加载、扩展市场或隔离沙箱；新增服务必须经过核心接口登记，不能让下载的脚本直接访问存档或原生命令。

## 文件分工

| 文件 | 职责 |
| --- | --- |
| `registry.ts` | 清单、接口版本、统一生命周期、状态与事件订阅 |
| `git/tutorial.ts` | Git 自带的教学卡片结构；正文仍从多语言表读取 |
| `desktop-service.ts` | 所有桌面服务共用的请求与任务适配器 |
| `../webview/ExtensionManager.tsx` | 安装状态、启停、配置、卸载入口 |
| `../webview/ExtensionWindow.tsx` | 复用普通卡片的无边框窗口外壳 |
| `../webview/extension-views.tsx` | ID 到功能界面的登记表 |
| `../../src-tauri/src/extension_service.rs` | 主窗口权限检查、服务实例、后台任务与通知 |
| `../../src-tauri/src/git_ops.rs` | Git 专用校验和执行；不读取或写入看板内容 |

## 新增内置扩展

1. 在 `../i18n/zh-CN.json` 添加名称、介绍、按钮、错误等文本。所有程序文案遵守该目录的 README。
2. 用 `ExtensionManifest` 声明稳定 ID、实现版本、`apiVersion: EXTENSION_API_VERSION`、名称键、介绍键、能力标识及必需的 `tutorial`，并加入 `AVAILABLE_EXTENSIONS`。
3. 服务实现 `ExtensionService` 的全部方法。应用通过 `ExtensionHost` 调用，不在管理器里为服务新增专用启停流程。原生服务复用 `DesktopExtensionService`；在 Rust `provider` 登记执行器和配置校验，不把业务判断写进通用任务调度。
4. 实现接受 `ExtensionViewProps` 的 React 组件，在 `extension-views.tsx` 登记。组件通过 `send` 请求主窗口执行，不能绕过唯一写入者修改卡片存档。
5. 添加另一服务的生命周期测试，以及功能的失败路径、配置持久化和多窗口测试。`test/extensions.test.ts` 中的 `sample` 服务是最小可运行接口示例。

## 扩展自带教学

接口 v2 要求每个扩展提供 `tutorial: {root, cards}`。`root` 指向教学入口，入口必须为 `role:'level'`、`parent:null`；其余节点使用本包内的父键，角色为 `step` 或 `practice`。注册会拒绝缺失的教学、重复键、循环、孤立节点及缺失的文本键。

```ts
import type {ExtensionTutorial} from '../core/tutorial-schema.ts';
const tutorial:ExtensionTutorial={root:'start',cards:[
 {key:'start',parent:null,role:'level',title:'tutorial.gitTitle',content:'tutorial.gitBody'},
 {key:'first',parent:'start',role:'step',title:'tutorial.git_01Title',content:'tutorial.git_01Body'}
]};
```

示例借用现有文本键以便核对结构；实际扩展应在文本表中维护自己的内容。教学按完整使用任务组织，相关操作可合在一页；并列内容用目录，只有真实的先后依赖才使用“下一步”链。练习尽量在说明所在卡片完成，需要外部对象时直接提供就近入口。不要把每个小操作拆成独立页面，也不要把同一模块的基础与进阶拆到不同面。

总教程把每份教学的入口挂到 D 面，并为所有键加上 `extension:<扩展ID>:` 命名空间。扩展无须访问教程存档或自己建立管理入口。当前教学随应用编译；已有学习副本是用户数据，不会因为停用或卸载服务而被删除。参考 `git/tutorial.ts`。

最小服务实现示意（机器标识与用户文案分开）：

```ts
import type {ExtensionService} from './registry.ts';

export function sampleService(): ExtensionService {
  let config: Record<string, unknown> = {};
  let enabled = false;
  return {
    async initialize(next) { config = next; },
    async configure(next) { config = next; },
    async enable() { enabled = true; },
    async disable() { enabled = false; },
    async dispose() { enabled = false; config = {}; },
    status() { return {enabled}; },
    async invoke(method, args) { return {method, args, config}; },
  };
}
```

此示例仅演示接口；生产实现仍需校验配置、请求方法和参数，并对耗时工作使用后台任务。

## 生命周期与请求协议

- `register` 检查唯一 ID 和接口版本。`initialize` 加载工作区内的配置，之后才能 `enable`。
- `configure` 校验成功后才保存偏好；运行任务期间拒绝改配置、停用或卸载。
- `invoke` 仅允许已启用服务。桌面执行器返回 `{jobId}`，实际工作在 Rust 后台线程运行，不占用卡片保存队列。同一服务的请求按接收顺序排队（最多 32 项），避免多个窗口的自动查询互相拒绝；运行计时不包含排队时间。
- `extension-job` 查询 `{state: 'queued' | 'running' | 'done' | 'failed', result?, error?}`，不触发保存、协作记录或完整卡片快照。
- `kkb:extension-result` 只广播工作区、任务 ID、服务 ID、方法和完成状态。大块差异、图片等结果留在有界任务缓存中，按任务 ID 获取。缓存最多保留约 64 个任务／32 MiB，完成任务可被淘汰。
- 对外路径统一使用 `desktop::display_path`，移除 Windows 的 `\\?\` 前缀并正确转换 UNC 路径；原生文件访问和安全校验仍使用规范化的 `PathBuf`。完成通知必须与 `workspace_root` 使用同一种路径格式，否则界面会误丢弃通知。
- 关闭主窗口或切换工作区前按需查询已登记任务，恢复遗漏的完成通知；完成和失败均清理运行标记并只记录一次结果。仍在执行或无法确认状态时保留保护，不增加空闲轮询。
- `subscribe` 接收状态与结果事件。需要长期保存的交付结果应使用明确的核心保存接口，不能依赖临时任务缓存。
- `disable` 关闭该扩展的窗口并保留配置；`uninstall` 释放服务和入口，保留用户项目及卡片数据。内置扩展可重新安装。
- 主窗口退出或切换工作区时，尚有任务则暂时拒绝，避免丢失正在执行的操作归属与结果。

偏好保存在工作区的视图配置 `extensions[id]` 中：`{installed, enabled, config}`。不把凭据、完整差异或图片写进配置。Git 配置当前只接受可访问的 `root` 文件夹，可用 `{}` 恢复当前工作区路径。

## Git 的额外边界

使用 `npm run app` 开发运行时，不能通过 Git 扩展切换、合并、拉取或丢弃包含当前应用源码的仓库，否则 Vite／Tauri 会同时热更新或重新编译应用，旧代码还可能无法读取当前工作区。原生执行层会在改写工作文件前阻止此操作，界面也会显示原因；暂存、取消暂存、提交及其他仓库不受影响。安装后的发行版不使用这项开发目录限制。开发者要切换 KankanBan 自身版本，应先关闭开发进程，再用外部 Git 工具切换。

文件动作完成后会重新核对选中文件的暂存状态并加载对应差异；文件不再有改动时清除旧按钮。重命名取消暂存同时处理旧、新路径。请求携带当前窗口看到的仓库根目录，另一个窗口切换仓库后，旧窗口的请求会被拒绝，必须先手动刷新，防止误操作同名文件。

Git 忽略规则的既有字节会被保留，非 UTF-8 注释不会让 Git 动作失败；仅追加所需的 ASCII 忽略规则，不重编码用户文件。

仓库状态在打开窗口、连接仓库及当前窗口完成操作后更新；其余时间由用户点击「刷新」。没有定时刷新或跨窗口完成事件触发的自动查询，外部工具改动后也需手动刷新。执行中的任务仍查询完成状态，不会在空闲时持续探测仓库。

Git 调用系统已有的 `git`，通过参数数组执行，不经过 shell。凭据沿用外部 Git 凭据管理器；不接受含明文密码的 URL。前台不等待子进程完成；单次任务有输出大小与执行时间限制。

`.kkb/` 完全独立于项目版本。连接仓库会保留原有 `.gitignore` 并补齐有效忽略规则；暂存、提交、丢弃、分支切换和合并仍有显式保护。已跟踪数据只能在确认后停止跟踪并保留本地文件。推送前刷新远程信息，再检查待上传历史中的看板数据；停止跟踪不会抹除历史，发现旧数据会阻止上传，由用户在外部工具处理，不自动重写历史。

仓库状态、图、差异等浏览查询不生成协作变更。写操作完成后记录发起者、时间、仓库、必要参数与结果状态；敏感 URL、完整命令输出不进入协作摘要。所有扩展都应区分浏览状态、执行结果和卡片数据保存。

## Git 界面结构

界面参考 [GitHub Desktop 的仓库栏、Changes／History 和差异视图](https://docs.github.com/en/desktop/overview/creating-your-first-repository-using-github-desktop)，保留本项目以提交关系图为主体的需求。

- 顶部仅保留当前仓库、当前分支、按 ahead／behind 显示的同步主操作，以及手动刷新。点击对应区域打开仓库、分支、远程面板。
- 左侧「历史」显示分支与引用；中央展示全部分支的提交关系图。选中提交才显示下方文件清单与差异检查区，可关闭详情恢复图的空间。
- 左侧「改动」显示暂存与未暂存文件、勾选框，以及底部的提交摘要、说明和提交按钮。右侧查看选中文件的差异；丢弃、打开和暂存操作跟随当前文件出现。
- 分支比较位于左侧入口的独立面板；合并冲突与 .kkb 警告只在相关状态出现。
- 关闭面板支持 Esc／点击外部；使用共用配色、圆角和窗口交互。保留手动刷新，无后台定时刷新。

## 人工验收

由用户启动桌面应用，在临时仓库验证：

1. 「扩展」中双击 Git 两次，出现两个独立窗口；关闭其中一个后另一个仍可使用。
2. 连接临时仓库、暂存、提交；查看提交图、文件差异与图片差异，切换仓库后旧详情消失。
3. 新建分支、切换、比较、合并；制造冲突后打开文件、保留一方、标记解决、完成或取消合并。
4. 用测试远程验证 fetch／push／pull；分叉时 pull 拒绝自动重写历史。
5. `.kkb` 不进入改动列表或提交；已跟踪状态有提示，停止跟踪后本地数据仍存在。
6. 长任务期间仍可编辑卡片；两个 Git 窗口能刷新共同仓库的结果；失败有可读提示。

命令行回归入口：

```powershell
npm run typecheck
node --import ./test/tsx-hooks.mjs --test test/extensions.test.ts test/extension-ui.test.ts test/extension-windows.test.ts test/git-panel.test.ts test/gitignore-protection.test.ts test/window-services.test.ts
cargo test --offline --manifest-path src-tauri/Cargo.toml git_ops::tests
npm run build:web
```

这些测试不证明原生窗口显示、拖动手感或真实账号认证已通过；这部分需要上述桌面验收。
