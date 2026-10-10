//! KankanBan 的 Tauri 后端。
//!
//! 【这一侧为什么这么薄】
//! 全部业务逻辑（卡片模型、事件日志、WAL、撤销、视图模型）都在 **TypeScript 的 core** 里，
//! 而且已经被 159 条无头测试覆盖。Rust 这侧的职责只有一件：
//! **做 webview 做不到的那部分 I/O** —— webview 没有 Node，也没有真正的 fsync。
//!
//! 所以这里只暴露 9 个文件原语 + 一个工作区路径查询，**不含任何业务判断**。
//! 这样"同一套逻辑"只有一份，UI 与 MCP 服务器用的是同一批操作（§9.1）。
//!
//! 【异步命令】全部声明成 `async fn`：Tauri 的同步命令跑在**主线程**上，
//! 在那里做文件 I/O 会卡住 UI。异步命令跑在线程池里。
//! （这条来自 `sticky-tauri` 原型踩过的坑：同步命令里建窗会直接死锁。）

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Manager, Emitter};
mod i18n;
mod desktop;
mod snap;

fn path_of(raw: &str) -> PathBuf {
    PathBuf::from(raw)
}

// ===========================================================================
// 卡片窗口（多窗口）—— 机制完全照 `sticky-tauri` 的便签窗口来
//
// 【标签就是身份】`card-{id}` ↔ 卡片 id，和便签的 `note-{id}` 一个套路。
// 为什么不另发一套窗口 id：§2.8 不变量 W′ 说窗口的身份就是那张根卡的 id。
//
// 【命令必须是 async】Tauri 的同步命令跑在**主线程**上，而 `build()` 需要事件循环
// 才能真正建窗 —— 主线程阻塞着等主线程，直接死锁（`sticky-tauri` 实测：日志停在
// create 那一行，Win32 窗口已建出但 webview 永远加载不完，整个应用卡死）。
// 声明成 async 之后 Tauri 会把它调度开，建窗再回到主线程执行。
//
// 【落点按单调槽位】不能用"当前窗口数量"当偏移：关掉中间几扇再开新的，
// 偏移会退回旧值，新窗口正好压在已有的那扇上面（`sticky-tauri` 踩过）。
// ===========================================================================

const CARD_W: f64 = 360.0;
const CARD_H: f64 = 420.0;
const CARD_START_X: f64 = 140.0;
const CARD_START_Y: f64 = 140.0;
const CARD_STEP_X: f64 = 40.0;
const CARD_STEP_Y: f64 = 40.0;
const CARD_GRID_COLS: u32 = 6;
const CARD_GRID_ROWS: u32 = 4;

/// 卡片窗口的标签前缀。Rust 侧与前端 `window-role.ts` 必须一致。
const CARD_PREFIX: &str = "card-";

/// 主窗口标签，与 `tauri.conf.json` 的 `app.windows[0].label` 一致。
const MAIN_LABEL: &str = "main";

/// 只用来发落点槽位，避免新窗口叠在一起。
#[derive(Default)]
struct WindowState {
    next_slot: Mutex<u32>,
}

fn label_of_card(card_id: &str) -> String {
    format!("{CARD_PREFIX}{card_id}")
}

fn card_of_label(label: &str) -> Option<&str> {
    label.strip_prefix(CARD_PREFIX)
}

/// 当前真实存在的卡片窗口标签，按标签排序保证结果稳定。
fn card_labels_of(app: &tauri::AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with(CARD_PREFIX))
        .cloned()
        .collect();
    labels.sort();
    labels
}

/// 真正建窗。setup 阶段（事件循环还没跑）也可以直接调它。
///
/// `focus`：显式「提出到屏幕窗口」时才把已存在的窗口提到前面；
/// 对账（`sync_card_windows`）时**不能**聚焦 —— 否则写者每算一次目标集合，
/// 就会把用户正在用的卡片窗口抢一次焦点。
fn spawn_card_window(app: &tauri::AppHandle, card_id: &str, focus: bool) -> Result<(), String> {
    let label = label_of_card(card_id);

    // 已经开着就直接返回 —— 重复点「提出到屏幕窗口」不该叠出第二扇。
    if let Some(existing) = app.get_webview_window(&label) {
        if focus {
            let _ = existing.set_focus();
        }
        return Ok(());
    }

    let slot = {
        let state = app.state::<WindowState>();
        let mut next = state
            .next_slot
            .lock()
            .map_err(|error| crate::i18n::text("native/lib.text001", &[("arg0", format!("{}", error))]))?;
        let slot = *next;
        *next += 1;
        slot
    };
    let x = CARD_START_X + (slot % CARD_GRID_COLS) as f64 * CARD_STEP_X;
    let y = CARD_START_Y + ((slot / CARD_GRID_COLS) % CARD_GRID_ROWS) as f64 * CARD_STEP_Y;

    tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title(crate::i18n::text("native/lib.text002", &[]))
        .inner_size(CARD_W, CARD_H)
        .position(x, y)
        // 无边框 + 透明：圆角与投影由卡片自己用 border-radius / box-shadow 画。
        .decorations(false)
        .transparent(true)
        // Windows 上必须显式关掉，否则无装饰窗口会带一圈描边
        // （tao 的 WM_NCCALCSIZE 分支；系统深色模式下那条边是黑的）。
        .shadow(false)
        .focused(focus)
        .always_on_top(true)
        .skip_taskbar(true)
        // 和便签一样固定尺寸：无装饰 + 无阴影时客户区铺满窗口，没有可抓的缩放边框。
        .resizable(false)
        .maximizable(false)
        .min_inner_size(desktop::note_min_width(), 38.0)
        .build()
        .map_err(|error| crate::i18n::text("native/lib.text003", &[("arg0", format!("{}", label)), ("arg1", format!("{}", error))]))?;

    if let Some(window) = app.get_webview_window(&label) { desktop::restore_window(app, &window); }
    Ok(())
}

fn close_card_window_impl(app: &tauri::AppHandle, card_id: &str) -> Result<(), String> {
    let label = label_of_card(card_id);
    match app.get_webview_window(&label) {
        Some(window) => { desktop::save_window(app, &window); window.destroy().map_err(|error| crate::i18n::text("native/lib.text004", &[("arg0", format!("{}", label)), ("arg1", format!("{}", error))])) },
        // 本来就不在 = 目标已达成，不算失败。
        None => Ok(()),
    }
}

#[tauri::command]
async fn fs_exists(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    desktop::check_path(&app, &path)?;
    Ok(path_of(&path).exists())
}

#[tauri::command]
async fn fs_read_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    desktop::check_path(&app, &path)?;
    fs::read_to_string(&path).map_err(|error| crate::i18n::text("native/lib.text005", &[("arg0", format!("{}", path)), ("arg1", format!("{}", error))]))
}

#[tauri::command]
async fn fs_read_dir(app: tauri::AppHandle, path: String) -> Result<Vec<String>, String> {
    desktop::check_path(&app, &path)?;
    let mut names = Vec::new();
    for entry in fs::read_dir(&path).map_err(|error| crate::i18n::text("native/lib.text006", &[("arg0", format!("{}", path)), ("arg1", format!("{}", error))]))? {
        let entry = entry.map_err(|error| error.to_string())?;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
async fn fs_mkdirp(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    desktop::require_main(&window)?; desktop::check_path(&app, &path)?;
    fs::create_dir_all(&path).map_err(|error| crate::i18n::text("native/lib.text007", &[("arg0", format!("{}", path)), ("arg1", format!("{}", error))]))
}

/// 直接写，不保证原子。原子性由 core 侧"写临时文件 + rename"负责（§4.2）。
#[tauri::command]
async fn fs_write_file(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String, data: String) -> Result<(), String> {
    desktop::require_main(&window)?; desktop::check_path(&app, &path)?;
    fs::write(&path, data).map_err(|error| crate::i18n::text("native/lib.text008", &[("arg0", format!("{}", path)), ("arg1", format!("{}", error))]))
}

#[tauri::command]
async fn fs_rename(app: tauri::AppHandle, window: tauri::WebviewWindow, from: String, to: String) -> Result<(), String> {
    desktop::require_main(&window)?; desktop::check_path(&app, &from)?; desktop::check_path(&app, &to)?;
    fs::rename(&from, &to).map_err(|error| crate::i18n::text("native/lib.text009", &[("arg0", format!("{}", from)), ("arg1", format!("{}", to)), ("arg2", format!("{}", error))]))
}

#[tauri::command]
async fn fs_append_file(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String, data: String) -> Result<(), String> {
    desktop::require_main(&window)?; desktop::check_path(&app, &path)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| crate::i18n::text("native/lib.text010", &[("arg0", format!("{}", path)), ("arg1", format!("{}", error))]))?;
    file.write_all(data.as_bytes())
        .map_err(|error| crate::i18n::text("native/lib.text011", &[("arg0", format!("{}", path)), ("arg1", format!("{}", error))]))
}

/// 真正落盘。§4.2 的 WAL 承诺（"事件落盘后才算数"）最终靠这个 `sync_all` 兑现，
/// 而这件事 webview 做不到 —— 它是整个 Rust 侧存在的第一理由。
#[tauri::command]
async fn fs_fsync(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    desktop::require_main(&window)?; desktop::check_path(&app, &path)?;
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|error| crate::i18n::text("native/lib.text012", &[("arg0", format!("{}", path)), ("arg1", format!("{}", error))]))?;
    file.sync_all()
        .map_err(|error| crate::i18n::text("native/lib.text013", &[("arg0", format!("{}", path)), ("arg1", format!("{}", error))]))
}

#[tauri::command]
async fn fs_remove(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    desktop::require_main(&window)?; desktop::check_path(&app, &path)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // 删一个本来就不在的东西不算失败：core 侧的清理是 best-effort。
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(crate::i18n::text("native/lib.text014", &[("arg0", format!("{}", path)), ("arg1", format!("{}", error))])),
    }
}

/// 工作区位置：应用数据目录下的 `workspace/`。
/// 统一给出正斜杠形式，与 core 的 `joinPath` 对齐（Windows 也认）。
#[tauri::command]
async fn workspace_root(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<String, String> {
    let dir = desktop::root(&app)?;
    if window.label() == "main" { desktop::restore_window(&app, &window); }
    Ok(desktop::display_path(&dir))
}

/// 当前真实存在的卡片窗口标签。前端的镜像窗口用它对账，避免"内存里以为开着、其实早关了"。
#[tauri::command]
async fn card_window_labels(app: tauri::AppHandle) -> Vec<String> {
    card_labels_of(&app)
}

/// 把一张卡片提到屏幕窗口（§2.8「提出到屏幕窗口」）。已开着就只聚焦。
#[tauri::command]
async fn open_card_window(app: tauri::AppHandle, window: tauri::WebviewWindow, card_id: String) -> Result<(), String> {
    desktop::require_main(&window)?;
    spawn_card_window(&app, &card_id, false)?;
    if let Some(card_window) = app.get_webview_window(&label_of_card(&card_id)) {
        desktop::set_note_mode(app.clone(), card_window.clone(), Some(false), Some(true)).await?;
        card_window.unminimize().map_err(|error| error.to_string())?;
        card_window.show().map_err(|error| error.to_string())?;
        card_window.emit("kkb:window-activated", serde_json::json!({"label":card_window.label()})).map_err(|error| error.to_string())?;
        card_window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 关掉一张卡片的窗口。**只关窗口，不碰树** —— 用户定案：关闭不影响任何结构。
#[tauri::command]
async fn close_card_window(app: tauri::AppHandle, window: tauri::WebviewWindow, card_id: String) -> Result<(), String> {
    desktop::require_main(&window)?;
    close_card_window_impl(&app, &card_id)
}

/// 让真实窗口集合与 `wanted` 对齐（多退少补），返回过程中的问题而不是直接失败。
///
/// 写者（main）每次算出 `openWindowSet` 就调一次，于是"开窗 / 关窗 / 崩溃后残留"
/// 三种情况用同一条路径收敛 —— 不需要前端自己记"上一轮开了哪些"。
#[tauri::command]
async fn sync_card_windows(app: tauri::AppHandle, window: tauri::WebviewWindow, wanted: Vec<String>) -> Vec<String> {
    if let Err(e) = desktop::require_main(&window) { return vec![e]; }
    let mut problems = Vec::new();

    for card_id in &wanted {
        if let Err(error) = spawn_card_window(&app, card_id, false) {
            problems.push(error);
        }
    }

    for label in card_labels_of(&app) {
        let Some(card_id) = card_of_label(&label) else {
            continue;
        };
        if wanted.iter().any(|want| want == card_id) {
            continue;
        }
        if let Some(window) = app.get_webview_window(&label) {
            desktop::save_window(&app, &window);
            if let Err(error) = window.destroy() {
                problems.push(crate::i18n::text("native/lib.text004", &[("arg0", format!("{}", label)), ("arg1", format!("{}", error))]));
            }
        }
    }

    problems
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                window.set_title(&i18n::text("app.title", &[]))?;
            }
            Ok(())
        })
        .manage(WindowState::default())
        .manage(desktop::DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            fs_exists,
            fs_read_file,
            fs_read_dir,
            fs_mkdirp,
            fs_write_file,
            fs_rename,
            fs_append_file,
            fs_fsync,
            fs_remove,
            workspace_root,
            card_window_labels,
            open_card_window,
            close_card_window,
            sync_card_windows,
            desktop::finish_exit,
            desktop::reload_workspace,
            desktop::window_preferences,
            desktop::set_note_mode,
            desktop::move_note,
            desktop::drag_mouse_buttons,
            desktop::resize_note,
            desktop::set_board_view,
            desktop::window_at_point,
            desktop::position_card_window,
            desktop::open_link,
            desktop::git_summary,
            desktop::select_workspace,
            desktop::choose_workspace_folder,
        ])
        .on_window_event(|window, event| {
            // 管理器一关就顺手收掉所有卡片窗口 —— 照抄便签项目的那条规则。
            //
            // 这个应用的 main 窗口不只是门面：按方案 A（§14）它是**唯一写者**，
            // 没有它就没有人会写盘，剩下的卡片窗口只会是一堆只读浮窗。
            //
            // 用 Destroyed 而不是 CloseRequested：后者发生在 main "正在关"的时候，
            // 在里面再去关别的窗口容易和关窗流程互相纠缠；Destroyed 时 main 已经关完了。
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == MAIN_LABEL {
                let app = window.app_handle();
                for label in card_labels_of(app) {
                    if let Some(card_window) = app.get_webview_window(&label) {
                        let _ = card_window.close();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect(&crate::i18n::text("native/lib.text015", &[]));
}

