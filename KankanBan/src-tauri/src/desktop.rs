use std::{collections::{BTreeMap, BTreeSet}, fs, path::PathBuf, sync::Mutex, process::Command};
use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, LogicalSize};

#[derive(Clone, Serialize, Deserialize)]
pub struct WindowPrefs { pub x: i32, pub y: i32, pub width: f64, pub height: f64, pub collapsed: bool, pub pinned: bool }
#[derive(Default)]
pub struct DesktopState { pub boards: Mutex<BTreeSet<String>>, pub root: Mutex<Option<PathBuf>>, pub prefs: Mutex<BTreeMap<String, WindowPrefs>> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutMetrics {
    card_min_width: f64, card_min_height: f64, scrollbar: f64,
    child_padding: f64, child_header_height: f64, column_padding: f64,
    column_gap: f64, note_padding: f64, manager_padding: f64,
    sidebar_width: f64, window_border: f64, board_main_chrome_height: f64,
}
fn layout_metrics() -> &'static LayoutMetrics {
    static METRICS: std::sync::OnceLock<LayoutMetrics> = std::sync::OnceLock::new();
    METRICS.get_or_init(|| serde_json::from_str(include_str!("../../src/core/layout-metrics.json")).expect(&crate::i18n::text("native/desktop.text001", &[])))
}
pub fn note_min_width() -> f64 {
    let m = layout_metrics(); m.card_min_width + m.child_padding + m.scrollbar + 40.0 + m.window_border
}
fn note_min_height() -> f64 {
    let m = layout_metrics(); m.card_min_height + m.child_header_height + 40.0 + 38.0 + 24.0 + m.window_border
}
fn board_min_width(main: bool) -> f64 {
    let m = layout_metrics();
    3.0 * (m.card_min_width + m.column_padding + m.scrollbar) + 2.0 * m.column_gap + m.window_border
        + if main {m.manager_padding + m.sidebar_width} else {m.note_padding}
}
fn minimum_height(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> f64 {
    if window.label() == "main" {
        let board = app.state::<DesktopState>().boards.lock().map(|b|b.contains(window.label())).unwrap_or(false);
        return if board {layout_metrics().card_min_height + layout_metrics().board_main_chrome_height} else {320.0};
    }
    let collapsed = app.state::<DesktopState>().prefs.lock().ok().and_then(|p| p.get(window.label()).map(|p|p.collapsed)).unwrap_or(false);
    if collapsed {38.0} else {note_min_height()}
}

fn minimum_width(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> f64 {
    let board = app.state::<DesktopState>().boards.lock().map(|b| b.contains(window.label())).unwrap_or(false);
    if board { board_min_width(window.label() == "main") } else if window.label() == "main" { 480.0 } else { note_min_width() }
}

#[tauri::command]
pub async fn set_board_view(app: tauri::AppHandle, window: tauri::WebviewWindow, board: bool) -> Result<(), String> {
    {
        let state = app.state::<DesktopState>();
        let mut boards = state.boards.lock().map_err(|e| e.to_string())?;
        if board { boards.insert(window.label().to_owned()); } else { boards.remove(window.label()); }
    }
    let width = minimum_width(&app, &window);
    let height = minimum_height(&app, &window);
    window.set_min_size(Some(LogicalSize::new(width, height))).map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    if (size.width as f64 / scale) < width || (size.height as f64 / scale) < height {
        window.set_size(LogicalSize::new((size.width as f64 / scale).max(width), (size.height as f64 / scale).max(height))).map_err(|e| e.to_string())?;
    }
    save_window(&app, &window);
    Ok(())
}

fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> { app.path().app_data_dir().map_err(|e| e.to_string()) }
/// The directory picker is read-only; selection does not change the active workspace.
#[tauri::command]
pub async fn choose_workspace_folder(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    require_main(&window)?;
    use tauri_plugin_dialog::DialogExt;
    let initial = root(&app)?;
    let title = crate::i18n::text("native/desktop.chooseWorkspace", &[]);
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_parent(&window).set_title(title).set_directory(initial)
            .blocking_pick_folder()
            .map(|selected| selected.into_path().map(|path| display_path(&path)).map_err(|error| crate::i18n::text("native/desktop.folderPickerFailed", &[("arg0",error.to_string())])))
            .transpose()
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn select_workspace(app: tauri::AppHandle, window: tauri::WebviewWindow, path: Option<String>, check_only: Option<bool>) -> Result<(), String> {
    require_main(&window)?;
    let base = app_dir(&app)?;
    let path = match path { Some(value) => PathBuf::from(value.trim()), None => { let value=base.join("workspace");fs::create_dir_all(&value).map_err(|e|e.to_string())?;value } };
    if !path.is_absolute() || !path.is_dir() { return Err(crate::i18n::text("native/desktop.text002", &[]).into()); }
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if check_only.unwrap_or(false) {return Ok(());}
    let base = app_dir(&app)?;
    let tmp = base.join("workspace-path.tmp");
    fs::write(&tmp, display_path(&path)).map_err(|e| e.to_string())?;
    fs::rename(tmp, base.join("workspace-path.txt")).map_err(|e| e.to_string())
}
pub fn check_path(app: &tauri::AppHandle, raw: &str) -> Result<(), String> {
    let root = root(app)?;
    let path = PathBuf::from(raw);
    let lexical_root = PathBuf::from(display_path(&root));
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) { return Err(crate::i18n::text("native/desktop.text003", &[]).into()); }
    if path != lexical_root.join(".gitignore") && path != lexical_root.join(".gitignore.tmp") && !path.starts_with(lexical_root.join(".kkb")) { return Err(crate::i18n::text("native/desktop.text004", &[]).into()); }
    let mut existing = path.as_path();
    while !existing.exists() { existing = existing.parent().ok_or(crate::i18n::text("native/desktop.text005", &[]))?; }
    if !existing.canonicalize().map_err(|e| e.to_string())?.starts_with(&root) { return Err(crate::i18n::text("native/desktop.text006", &[]).into()); }
    Ok(())
}
pub fn display_path(path: &std::path::Path) -> String {
    let value = path.to_string_lossy();
    let normal = if let Some(unc) = value.strip_prefix(r"\\?\UNC\") { format!(r"\\{unc}") }
        else { value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned() };
    normal.replace('\\', "/")
}
pub fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { Err("卡片窗口不能直接写入工作区".into()) } else { Ok(()) }
}
pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<DesktopState>();
    let mut stored = state.root.lock().map_err(|e| e.to_string())?;
    if let Some(root) = stored.as_ref() { return Ok(root.clone()); }
    let base = app_dir(app)?; fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let root = fs::read_to_string(base.join("workspace-path.txt")).ok().map(|s| PathBuf::from(s.trim())).unwrap_or_else(|| base.join("workspace"));
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let data = root.join(".kkb");
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let lock = data.join("writer.lock");
    if lock.exists() {
        let owner = fs::read_to_string(lock.join("pid")).unwrap_or_default().trim().parse::<u32>().ok();
        if owner.map(process_alive).unwrap_or(true) { return Err("工作区正在由另一个应用、MCP 或 CLI 使用。请先关闭另一个写者。".into()); }
        let _ = fs::remove_file(lock.join("pid"));
        fs::remove_dir(&lock).map_err(|e| format!("无法清理过期工作区锁：{e}"))?;
    }
    fs::create_dir(&lock).map_err(|e| format!("工作区被占用：{e}"))?;
    if let Err(e) = fs::write(lock.join("pid"), std::process::id().to_string()) { let _ = fs::remove_file(lock.join("pid")); let _ = fs::remove_dir(&lock); return Err(e.to_string()); }
    // Snapshot core files only; never recurse into the backup destination or lease.
    let backups = data.join("backups");
    let backup = backups.join("before-iteration1");
    if data.join("tree.json").exists() && !backup.exists() {
        fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
        let staging = backups.join(format!("staging-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
        if let Err(error) = copy_directory(&data, &staging).and_then(|()| fs::rename(&staging, &backup).map_err(|e| e.to_string())) {
            let _ = fs::remove_file(lock.join("pid")); let _ = fs::remove_dir(&lock);
            return Err(format!("创建升级前备份失败，未打开工作区：{error}"));
        }
    }
    *state.prefs.lock().map_err(|e| e.to_string())? = fs::read(root.join(".kkb/window-prefs.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    *stored = Some(root.clone());
    Ok(root)
}
fn copy_directory(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    if fs::symlink_metadata(from).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("备份源包含符号链接".into()); }
    fs::create_dir(to).map_err(|e| e.to_string())?;
    for item in fs::read_dir(from).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        if from.file_name().and_then(|name| name.to_str()) == Some(".kkb") && (item.file_name() == "backups" || item.file_name() == "writer.lock" || item.file_name() == "mcp-bridge.json" || item.file_name() == "mcp-bridge.tmp") { continue; }
        let kind = item.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() { return Err("备份源包含符号链接".into()); }
        if kind.is_dir() { copy_directory(&item.path(), &to.join(item.file_name()))?; }
        else { fs::copy(item.path(), to.join(item.file_name())).map_err(|e| e.to_string())?; }
    }
    Ok(())
}
#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    #[link(name="kernel32")] extern "system" { fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void; fn CloseHandle(handle: *mut std::ffi::c_void) -> i32; fn GetLastError() -> u32; }
    unsafe { let handle = OpenProcess(0x1000, 0, pid); if handle.is_null() { GetLastError() != 87 } else { CloseHandle(handle); true } }
}
#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool { std::path::Path::new(&format!("/proc/{pid}")).exists() }

pub fn release(app: &tauri::AppHandle) {
    crate::mcp_bridge::stop(app);
    if let Ok(mut stored) = app.state::<DesktopState>().root.lock() {
        if let Some(root) = stored.take() { let lock = root.join(".kkb/writer.lock"); let _ = fs::remove_file(lock.join("pid")); let _ = fs::remove_dir(lock); }
    }
}
pub fn save_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let state = app.state::<DesktopState>();
    let root = state.root.lock().ok().and_then(|r| r.clone());
    let Some(root) = root else { return; };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else { return; };
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(mut prefs) = state.prefs.lock() else { return; };
    let value = prefs.entry(window.label().to_owned()).or_insert(WindowPrefs { x: position.x, y: position.y, width: size.width as f64 / scale, height: size.height as f64 / scale, collapsed: false, pinned: false });
    value.x = position.x; value.y = position.y;
    if !value.collapsed { value.width = size.width as f64 / scale; value.height = size.height as f64 / scale; }
    if let Ok(bytes) = serde_json::to_vec_pretty(&*prefs) {
        let tmp = root.join(".kkb/window-prefs.tmp");
        if fs::write(&tmp, bytes).is_ok() { let _ = fs::rename(tmp, root.join(".kkb/window-prefs.json")); }
    }
}
pub fn restore_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let _ = window.set_min_size(Some(LogicalSize::new(minimum_width(app,window),minimum_height(app,window))));
    let pref = app.state::<DesktopState>().prefs.lock().ok().and_then(|p| p.get(window.label()).cloned());
    if let Some(p) = pref {
        let _ = window.set_size(LogicalSize::new(p.width.max(minimum_width(app, window)), if p.collapsed { 38.0 } else { p.height.max(note_min_height()) }));
        let monitors = window.available_monitors().unwrap_or_default();
        let visible = monitors.iter().any(|m| { let a = m.work_area(); p.x + 80 > a.position.x && p.y + 38 > a.position.y && p.x < a.position.x + a.size.width as i32 && p.y < a.position.y + a.size.height as i32 });
        if visible { let _ = window.set_position(PhysicalPosition::new(p.x, p.y)); }
        let _ = window.set_always_on_top(p.pinned);
    }
}

#[tauri::command]
pub async fn finish_exit(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("只有主窗口可以退出应用".into()); }
    for w in app.webview_windows().values() { save_window(&app, w); }
    release(&app); app.exit(0); Ok(())
}
#[tauri::command]
pub async fn reload_workspace(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    let previous = root(&app)?;
    for w in app.webview_windows().values() { save_window(&app, w); }
    // Destroy mirrors before changing the writer root, so no old card can write into the new workspace.
    for (label, card_window) in app.webview_windows() {
        if label.starts_with("card-") { card_window.destroy().map_err(|e|e.to_string())?; }
    }
    release(&app);
    if let Err(error) = root(&app) {
        // A locked/unreadable destination must not strand the current session.
        let base = app_dir(&app)?;
        fs::write(base.join("workspace-path.txt"), display_path(&previous)).map_err(|e|e.to_string())?;
        root(&app)?;
        return Err(error);
    }
    app.state::<DesktopState>().boards.lock().map_err(|e|e.to_string())?.clear();
    restore_window(&app, &window);
    Ok(())
}

#[tauri::command]
pub async fn window_preferences(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Option<WindowPrefs> {
    app.state::<DesktopState>().prefs.lock().ok().and_then(|p| p.get(window.label()).cloned())
}
#[tauri::command]
pub async fn set_note_mode(app: tauri::AppHandle, window: tauri::WebviewWindow, collapsed: Option<bool>, pinned: Option<bool>) -> Result<(), String> {
    save_window(&app, &window);
    let preference = { let state = app.state::<DesktopState>(); let mut prefs = state.prefs.lock().map_err(|e| e.to_string())?;
        let p = prefs.get_mut(window.label()).ok_or("窗口状态不存在")?;
        if let Some(value) = collapsed { p.collapsed = value; } if let Some(value) = pinned { p.pinned = value; } p.clone() };
    window.set_min_size(Some(LogicalSize::new(minimum_width(&app,&window),minimum_height(&app,&window)))).map_err(|e|e.to_string())?;
    window.set_size(LogicalSize::new(preference.width.max(minimum_width(&app, &window)), if preference.collapsed { 38.0 } else { preference.height.max(note_min_height()) })).map_err(|e| e.to_string())?;
    window.set_always_on_top(preference.pinned).map_err(|e| e.to_string())?;
    save_window(&app, &window); Ok(())
}
#[tauri::command]
pub async fn move_note(app: tauri::AppHandle, window: tauri::WebviewWindow, x: f64, y: f64, finish: bool) -> Result<serde_json::Value, String> {
    let hint = crate::snap::move_and_snap(&app, &window, x, y, finish)?;
    if finish { save_window(&app, &window); } Ok(hint)
}
#[tauri::command]
pub async fn resize_note(app: tauri::AppHandle, window: tauri::WebviewWindow, width: f64, height: f64, finish: Option<bool>) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() { return Err("尺寸无效".into()); }
    let scale = window.scale_factor().unwrap_or(1.0);
    let area = window.current_monitor().ok().flatten().map(|m| m.work_area().size);
    let min_w = minimum_width(&app, &window);
    let max_w = area.map(|s| s.width as f64 / scale).unwrap_or(1600.0).max(min_w);
    let min_h = minimum_height(&app, &window);
    let max_h = area.map(|s| s.height as f64 / scale).unwrap_or(1200.0).max(min_h);
    window.set_size(LogicalSize::new(width.clamp(min_w, max_w), height.clamp(min_h, max_h))).map_err(|e| e.to_string())?;
    if finish.unwrap_or(true) { save_window(&app, &window); } Ok(())
}
#[derive(Serialize)] pub struct Hit { label: String, x: f64, y: f64 }
#[tauri::command]
pub async fn window_at_point(app: tauri::AppHandle, x: f64, y: f64, ignore_label: Option<String>) -> Option<Hit> {
    #[cfg(windows)]
    let root_hwnd = unsafe {
        #[repr(C)] struct Rect { left: i32, top: i32, right: i32, bottom: i32 }
        #[link(name="user32")] extern "system" {
            fn GetTopWindow(hwnd: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
            fn GetWindow(hwnd: *mut std::ffi::c_void, command: u32) -> *mut std::ffi::c_void;
            fn IsWindowVisible(hwnd: *mut std::ffi::c_void) -> i32;
            fn IsIconic(hwnd: *mut std::ffi::c_void) -> i32;
            fn GetWindowRect(hwnd: *mut std::ffi::c_void, rect: *mut Rect) -> i32;
        }
        let ignored = ignore_label.as_ref().and_then(|label| app.get_webview_window(label)).and_then(|w| w.hwnd().ok()).map(|h| h.0);
        let mut hwnd = GetTopWindow(std::ptr::null_mut());
        while !hwnd.is_null() {
            let mut rect = Rect { left: 0, top: 0, right: 0, bottom: 0 };
            if Some(hwnd) != ignored && IsWindowVisible(hwnd) != 0 && IsIconic(hwnd) == 0 && GetWindowRect(hwnd, &mut rect) != 0 &&
                x >= rect.left as f64 && x < rect.right as f64 && y >= rect.top as f64 && y < rect.bottom as f64 { break; }
            hwnd = GetWindow(hwnd, 2);
        }
        hwnd
    };
    for (label, w) in app.webview_windows() {
        if ignore_label.as_deref() == Some(label.as_str()) { continue; }
        #[cfg(windows)] if w.hwnd().ok().map(|h| h.0) != Some(root_hwnd) { continue; }
        let (Ok(p), Ok(s)) = (w.inner_position(), w.inner_size()) else { continue; };
        if x >= p.x as f64 && y >= p.y as f64 && x < p.x as f64 + s.width as f64 && y < p.y as f64 + s.height as f64 {
            let scale = w.scale_factor().unwrap_or(1.0); return Some(Hit { label, x: (x - p.x as f64) / scale, y: (y - p.y as f64) / scale });
        }
    }
    None
}
#[tauri::command]
pub async fn position_card_window(app: tauri::AppHandle, card_id: String, x: f64, y: f64) -> Result<(), String> {
    let w = app.get_webview_window(&format!("card-{card_id}")).ok_or("窗口尚未打开")?;
    w.set_position(PhysicalPosition::new(x as i32, y as i32)).map_err(|e| e.to_string())?; save_window(&app, &w); Ok(())
}
pub(crate) fn command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x08000000); }
    c
}
#[tauri::command]
pub async fn open_link(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.contains(['\r','\n','\0']) { return Err("只允许打开 http 或 https 链接".into()); }
    #[cfg(windows)] { command("rundll32.exe").args(["url.dll,FileProtocolHandler", &url]).spawn().map_err(|e| e.to_string())?; }
    #[cfg(not(windows))] { command("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?; }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn card_and_board_minima_include_scrollbars_and_chrome() {
        assert_eq!(note_min_width(), 222.0);
        assert_eq!(note_min_height(), 240.0);
        assert_eq!(board_min_width(false), 552.0);
        assert_eq!(board_min_width(true), 804.0);
    }
    #[test]
    fn display_paths_remove_windows_verbatim_prefix_without_breaking_unc() {
        assert_eq!(display_path(std::path::Path::new(r"\\?\C:\data\workspace")), "C:/data/workspace");
        assert_eq!(display_path(std::path::Path::new(r"\\?\UNC\server\share")), "//server/share");
    }
}

/// Global button state is only polled while a webview drag is active.
#[tauri::command]
pub fn drag_mouse_buttons() -> Option<u8> {
    #[cfg(windows)] {
        #[link(name="user32")]
        extern "system" { fn GetAsyncKeyState(key: i32) -> i16; }
        let mut buttons=0u8;
        unsafe {
            if GetAsyncKeyState(0x01)<0 { buttons|=1; }
            if GetAsyncKeyState(0x02)<0 { buttons|=2; }
            if GetAsyncKeyState(0x04)<0 { buttons|=4; }
        }
        Some(buttons)
    }
    #[cfg(not(windows))] { None }
}
