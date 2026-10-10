// Windows 下发布版不弹控制台窗口（`windows_subsystem` 只在 release 生效）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kankanban_lib::run()
}
