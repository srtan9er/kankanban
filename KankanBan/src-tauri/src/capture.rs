use tauri::Manager;
use serde_json::{json,Value};
#[tauri::command]
pub async fn capture_app_window(app:tauri::AppHandle,window:tauri::WebviewWindow,label:String)->Result<Value,String>{
 crate::desktop::require_main(&window)?;
 if label!="main" && !label.starts_with("card-"){return Err(crate::i18n::text("mcp/extended.invalidWindow",&[]));}
 let target=app.get_webview_window(&label).ok_or_else(||crate::i18n::text("mcp/extended.invalidWindow",&[]))?;
 #[cfg(windows)]{
  use base64::Engine;
  use windows::Win32::{Foundation::HGLOBAL,System::Com::{StructuredStorage::CreateStreamOnHGlobal,STATSTG,STATFLAG_NONAME,STREAM_SEEK_SET}};
  use webview2_com::{CapturePreviewCompletedHandler,Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG};
  let (sender,receiver)=std::sync::mpsc::channel::<Result<Vec<u8>,String>>();
  target.with_webview(move |webview| {
   let operation=(||->windows::core::Result<()>{unsafe{
    let stream=CreateStreamOnHGlobal(HGLOBAL::default(),true)?;
    let read_stream=stream.clone();let completed=sender.clone();
    let callback=CapturePreviewCompletedHandler::create(Box::new(move |status|{
     let result=(||->Result<Vec<u8>,String>{
      status.map_err(|e|e.to_string())?;
      let mut stat=STATSTG::default();read_stream.Stat(&mut stat,STATFLAG_NONAME).map_err(|e|e.to_string())?;
      if stat.cbSize>8_000_000 || stat.cbSize<24{return Err(crate::i18n::text("native/mcpBridge.invalidRequest",&[]));}
      read_stream.Seek(0,STREAM_SEEK_SET,None).map_err(|e|e.to_string())?;
      let mut data=vec![0u8;stat.cbSize as usize];let mut read=0;read_stream.Read(data.as_mut_ptr().cast(),data.len() as u32,Some(&mut read)).ok().map_err(|e|e.to_string())?;
      data.truncate(read as usize);Ok(data)
     })();let _=completed.send(result);Ok(())
    }));
    webview.controller().CoreWebView2()?.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,&stream,&callback)?;Ok(())
   }})();
   if let Err(error)=operation{let _=sender.send(Err(error.to_string()));}
  }).map_err(|e|e.to_string())?;
  let data=tauri::async_runtime::spawn_blocking(move ||receiver.recv_timeout(std::time::Duration::from_secs(10))).await.map_err(|e|e.to_string())?.map_err(|_|crate::i18n::text("mcp/extended.captureTimeout",&[]))?.map_err(|e|crate::i18n::text("mcp/extended.captureFailed",&[("arg0",e)]))?;
  if data.len()<24 || &data[..8]!=b"\x89PNG\r\n\x1a\n"{return Err(crate::i18n::text("mcp/extended.captureFailed",&[("arg0",crate::i18n::text("mcp/desktop.invalidReply",&[]))]));}
  let width=u32::from_be_bytes(data[16..20].try_into().unwrap());let height=u32::from_be_bytes(data[20..24].try_into().unwrap());
  return Ok(json!({"windowLabel":label,"mimeType":"image/png","data":base64::engine::general_purpose::STANDARD.encode(data),"width":width,"height":height}));
 }
 #[cfg(not(windows))]{let _=target;Err(crate::i18n::text("mcp/extended.captureUnsupported",&[]))}
}

#[tauri::command]
pub async fn emit_window_inspection(app:tauri::AppHandle,window:tauri::WebviewWindow,label:String,token:String)->Result<(),String>{
 use tauri::Emitter;
 crate::desktop::require_main(&window)?;
 if label!="main" && !label.starts_with("card-"){return Err(crate::i18n::text("mcp/extended.invalidWindow",&[]));}
 let target=app.get_webview_window(&label).ok_or_else(||crate::i18n::text("mcp/extended.invalidWindow",&[]))?;
 target.emit("kkb:inspect",json!({"token":token})).map_err(|e|e.to_string())
}
