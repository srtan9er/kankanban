use std::{collections::BTreeMap,fs,io::{BufRead,BufReader,Read,Write},net::{TcpListener,TcpStream},path::PathBuf,sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,AtomicUsize,Ordering},mpsc},time::{Duration,Instant}};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use tauri::{Emitter,Manager};
const LIMIT:u64=1_048_576;
static NEXT_ID:AtomicU64=AtomicU64::new(1);
#[derive(Default)]
pub struct BridgeState(Mutex<Option<Arc<Bridge>>>);
pub fn running(app:&tauri::AppHandle)->bool {
 app.state::<BridgeState>().0.lock().map(|slot|slot.is_some()).unwrap_or(false)
}
struct Pending {sender:mpsc::Sender<Value>,started:Instant,claimed:bool,event:Event}
struct Bridge {root:PathBuf,port:u16,token:String,stopped:AtomicBool,pending:Mutex<BTreeMap<u64,Pending>>,connections:AtomicUsize}
#[derive(Serialize)]
struct Discovery {version:u8,host:&'static str,port:u16,token:String,root:String}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {token:String,workspace:String,tool:String,args:Value,#[serde(default)]context:Value}
#[derive(Clone,Serialize)]
pub struct Event {id:String,tool:String,args:Value,context:Value}
fn error(key:&str)->Value {json!({"error":crate::i18n::text(key,&[])})}
fn token()->Result<String,String>{
 let mut bytes=[0u8;32];
 #[cfg(windows)]{
  #[link(name="bcrypt")] extern "system" {fn BCryptGenRandom(algorithm:*mut std::ffi::c_void,buffer:*mut u8,length:u32,flags:u32)->i32;}
  if unsafe{BCryptGenRandom(std::ptr::null_mut(),bytes.as_mut_ptr(),32,2)}!=0{return Err(crate::i18n::text("native/mcpBridge.entropy",&[]));}
 }
 #[cfg(not(windows))]fs::File::open("/dev/urandom").and_then(|mut file|file.read_exact(&mut bytes)).map_err(|e|e.to_string())?;
 Ok(bytes.iter().map(|byte|format!("{byte:02x}")).collect())
}
fn authorized(actual:&str,expected:&str)->bool {
 if actual.len()!=expected.len(){return false;}
 actual.bytes().zip(expected.bytes()).fold(0u8,|diff,(a,b)|diff|(a^b))==0
}
pub fn stop(app:&tauri::AppHandle){
 let old=app.state::<BridgeState>().0.lock().ok().and_then(|mut slot|slot.take());
 if let Some(bridge)=old{
  bridge.stopped.store(true,Ordering::SeqCst);
  if let Ok(mut pending)=bridge.pending.lock(){for (_,request) in std::mem::take(&mut *pending){let _=request.sender.send(error("native/mcpBridge.stopped"));}}
  let _=TcpStream::connect(("127.0.0.1",bridge.port));
  let _=fs::remove_file(bridge.root.join(".kkb/mcp-bridge.json"));
 }
}
#[tauri::command]
pub async fn mcp_bridge_start(app:tauri::AppHandle,window:tauri::WebviewWindow)->Result<(),String>{
 crate::desktop::require_main(&window)?;
 let root=crate::desktop::root(&app)?;
 stop(&app);
 let listener=TcpListener::bind(("127.0.0.1",0)).map_err(|e|e.to_string())?;
 let port=listener.local_addr().map_err(|e|e.to_string())?.port();
 let bridge=Arc::new(Bridge{root:root.clone(),port,token:token()?,stopped:AtomicBool::new(false),pending:Mutex::new(BTreeMap::new()),connections:AtomicUsize::new(0)});
 let discovery=Discovery{version:1,host:"127.0.0.1",port,token:bridge.token.clone(),root:crate::desktop::display_path(&root)};
 let tmp=root.join(".kkb/mcp-bridge.tmp");
 fs::write(&tmp,serde_json::to_vec(&discovery).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
 fs::rename(tmp,root.join(".kkb/mcp-bridge.json")).map_err(|e|e.to_string())?;
 *app.state::<BridgeState>().0.lock().map_err(|e|e.to_string())?=Some(bridge.clone());
 std::thread::spawn(move || {
  for stream in listener.incoming(){
   if bridge.stopped.load(Ordering::SeqCst){break;}
   let Ok(stream)=stream else{continue;};
   if bridge.connections.fetch_add(1,Ordering::SeqCst)>=8{bridge.connections.fetch_sub(1,Ordering::SeqCst);continue;}
   let app=app.clone();let bridge=bridge.clone();
   std::thread::spawn(move || {let _=handle(&app,&bridge,stream);bridge.connections.fetch_sub(1,Ordering::SeqCst);});
  }
 });
 Ok(())
}
fn handle(app:&tauri::AppHandle,bridge:&Arc<Bridge>,mut stream:TcpStream)->Result<(),String>{
 stream.set_read_timeout(Some(Duration::from_secs(2))).map_err(|e|e.to_string())?;
 stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|e|e.to_string())?;
 let mut line=String::new();
 BufReader::new(stream.try_clone().map_err(|e|e.to_string())?).take(LIMIT+1).read_line(&mut line).map_err(|e|e.to_string())?;
 let reply=if line.len() as u64>LIMIT || !line.ends_with('\n'){
  error("native/mcpBridge.invalidRequest")
 }else if let Ok(request)=serde_json::from_str::<Request>(&line){
  if !authorized(&request.token,&bridge.token) || request.workspace!=crate::desktop::display_path(&bridge.root){error("native/mcpBridge.unauthorized")}
  else if !request.args.is_object() || request.tool.len()>64 || !request.tool.bytes().all(|b|b.is_ascii_lowercase() || b==b'_') {error("native/mcpBridge.invalidRequest")}
  else if bridge.stopped.load(Ordering::SeqCst){error("native/mcpBridge.stopped")}
  else{
   let id=NEXT_ID.fetch_add(1,Ordering::SeqCst);
   let (sender,receiver)=mpsc::channel();
   let event=Event{id:id.to_string(),tool:request.tool,args:request.args,context:request.context};
   bridge.pending.lock().map_err(|e|e.to_string())?.insert(id,Pending{sender,started:Instant::now(),claimed:false,event:event.clone()});
   let emitted=app.emit_to("main","kkb:mcp-request",event);
   let reply=if emitted.is_err(){error("native/mcpBridge.stopped")}else{receiver.recv_timeout(Duration::from_secs(30)).unwrap_or_else(|_|error("native/mcpBridge.timeout"))};
   bridge.pending.lock().map_err(|e|e.to_string())?.remove(&id);
   reply
  }
 }else{error("native/mcpBridge.invalidRequest")};
 let mut data=serde_json::to_vec(&reply).map_err(|e|e.to_string())?;data.push(b'\n');stream.write_all(&data).map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn mcp_bridge_claim(app:tauri::AppHandle,window:tauri::WebviewWindow,id:String)->Result<Option<Event>,String>{
 crate::desktop::require_main(&window)?;
 let id=id.parse::<u64>().map_err(|e|e.to_string())?;
 let bridge=app.state::<BridgeState>().0.lock().map_err(|e|e.to_string())?.clone();
 let Some(bridge)=bridge else{return Ok(None);};
 let mut pending=bridge.pending.lock().map_err(|e|e.to_string())?;
 let Some(request)=pending.get_mut(&id) else{return Ok(None);};
 if request.claimed || request.started.elapsed()>=Duration::from_secs(30) || bridge.stopped.load(Ordering::SeqCst){return Ok(None);}
 request.claimed=true;Ok(Some(request.event.clone()))
}
#[tauri::command]
pub async fn mcp_bridge_active(app:tauri::AppHandle,window:tauri::WebviewWindow,id:String)->Result<bool,String>{
 crate::desktop::require_main(&window)?;
 let id=id.parse::<u64>().map_err(|e|e.to_string())?;
 let bridge=app.state::<BridgeState>().0.lock().map_err(|e|e.to_string())?.clone();
 let Some(bridge)=bridge else{return Ok(false);};
 let pending=bridge.pending.lock().map_err(|e|e.to_string())?;
 Ok(!bridge.stopped.load(Ordering::SeqCst) && pending.get(&id).is_some_and(|request|request.claimed && request.started.elapsed()<Duration::from_secs(30)))
}
#[tauri::command]
pub async fn mcp_bridge_reply(app:tauri::AppHandle,window:tauri::WebviewWindow,id:String,reply:Value)->Result<(),String>{
 crate::desktop::require_main(&window)?;
 let id=id.parse::<u64>().map_err(|e|e.to_string())?;
 let bridge=app.state::<BridgeState>().0.lock().map_err(|e|e.to_string())?.clone();
 if let Some(bridge)=bridge{
  let mut pending=bridge.pending.lock().map_err(|e|e.to_string())?;
  if pending.get(&id).is_some_and(|request|request.claimed){if let Some(request)=pending.remove(&id){let _=request.sender.send(reply);}}
 }
 Ok(())
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn tokens_are_random_and_fixed_size(){let first=token().unwrap();let second=token().unwrap();assert_eq!(first.len(),64);assert_ne!(first,second);assert!(first.bytes().all(|b|b.is_ascii_hexdigit()));}
 #[test]
 fn authorization_rejects_wrong_or_partial_tokens(){assert!(authorized("abc","abc"));assert!(!authorized("abc","abd"));assert!(!authorized("ab","abc"));}
 #[test]
 fn wire_request_rejects_extra_fields(){assert!(serde_json::from_value::<Request>(json!({"token":"test","workspace":"test","tool":"read_tree","args":{},"action":"eval"})).is_err());}
}
