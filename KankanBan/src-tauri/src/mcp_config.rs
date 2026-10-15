use serde_json::{json,Value};
use tauri::{WebviewWindow,AppHandle};

fn configuration(path:&std::path::Path)->Value {
    json!({"mcpServers":{"KankanBan":{"command":path.to_string_lossy(),"args":[]}}})
}
#[tauri::command]
pub async fn mcp_connection_config(app:AppHandle,window:WebviewWindow)->Result<Value,String> {
    crate::desktop::require_main(&window)?;
    let executable=std::env::current_exe().map_err(|_|crate::i18n::text("mcp/release.nativeError",&[]))?;
    let filename=if cfg!(windows){"kankanban-mcp.exe"}else{"kankanban-mcp"};
    let mut path=executable.parent().ok_or_else(||crate::i18n::text("mcp/release.nativeError",&[]))?.join(filename);
    #[cfg(debug_assertions)]
    if !path.is_file() {
        let target=std::env::consts::ARCH;
        let triple=if cfg!(windows){format!("{target}-pc-windows-msvc")}else{String::new()};
        let suffix=if cfg!(windows){".exe"}else{""};
        let bundled=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(format!("kankanban-mcp-{triple}{suffix}"));
        if bundled.is_file(){path=bundled;}
    }
    let running=crate::mcp_bridge::running(&app);
    Ok(json!({"available":path.is_file(),"bridgeReady":running,"path":path.to_string_lossy(),"configuration":configuration(&path)}))
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn config_has_no_node_source_or_secret(){let result=configuration(std::path::Path::new("C:/Program Files/KankanBan/kankanban-mcp.exe"));assert_eq!(result["mcpServers"]["KankanBan"]["args"],json!([]));assert_eq!(result["mcpServers"]["KankanBan"]["command"],"C:/Program Files/KankanBan/kankanban-mcp.exe");}
}
