//! Shared local extension transport. Services run off the GUI thread; jobs never hold the card writer.
use std::{collections::BTreeMap,path::PathBuf,sync::{Arc,Mutex,Condvar,atomic::{AtomicU64,Ordering}},thread};
use serde_json::{json,Value};
use tauri::{Manager,Emitter};
#[derive(Default)]
pub struct ExtensionState {slots:Mutex<BTreeMap<String,Slot>>,jobs:Mutex<BTreeMap<u64,Value>>,next:AtomicU64}
#[derive(Default)]
struct SerialQueue {next:Mutex<u64>,ready:Condvar}
impl SerialQueue {
 fn run(&self,ticket:u64,operation:impl FnOnce()->Result<Value,String>)->Result<Value,String>{
  let mut next=self.next.lock().map_err(|_|crate::i18n::text("extensions.failed",&[]))?;
  while *next!=ticket{next=self.ready.wait(next).map_err(|_|crate::i18n::text("extensions.failed",&[]))?;}
  let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)).unwrap_or_else(|_|Err(crate::i18n::text("extensions.failed",&[])));
  *next+=1;self.ready.notify_all();result
 }
}
#[derive(Clone)]
struct Slot {root:PathBuf,enabled:bool,running:usize,queue:Arc<SerialQueue>,next_ticket:u64}
impl Slot {
 fn new(root:PathBuf,enabled:bool)->Self{Self{root,enabled,running:0,queue:Arc::new(SerialQueue::default()),next_ticket:0}}
 fn reserve(&mut self)->Result<(PathBuf,Arc<SerialQueue>,u64),String>{
  if self.running>=32{return Err(crate::i18n::text("extensions.busy",&[]));}
  let ticket=self.next_ticket;self.next_ticket+=1;self.running+=1;Ok((self.root.clone(),self.queue.clone(),ticket))
 }
}
struct Provider {
 configure:fn(&Value,&std::path::Path)->Result<PathBuf,String>,
 execute:fn(&std::path::Path,&str,&Value)->Result<Value,String>,
}
fn provider(id:&str)->Option<Provider>{match id{"git"=>Some(Provider{configure:crate::git_ops::validate_config,execute:crate::git_ops::execute_desktop}),_=>None}}
fn key(app:&tauri::AppHandle,id:&str)->Result<String,String>{if provider(id).is_none(){return Err(crate::i18n::text("extensions.missing",&[]));}Ok(format!("{}:{id}",crate::desktop::root(app)?.to_string_lossy()))}
fn result_event(workspace:&std::path::Path,job:u64,reply:&Value)->Value{
 json!({"workspace":crate::desktop::display_path(workspace),"jobId":job,"reply":{"id":reply["id"],"method":reply["method"],"state":reply["state"],"error":reply["error"]}})
}
#[tauri::command]
pub async fn extension_control(app:tauri::AppHandle,window:tauri::WebviewWindow,id:String,method:String,args:Value)->Result<Value,String>{
 crate::desktop::require_main(&window)?;let key=key(&app,&id)?;let state=app.state::<Arc<ExtensionState>>();let mut slots=state.slots.lock().map_err(|e|e.to_string())?;
 if slots.get(&key).is_some_and(|s|s.running>0){return Err(crate::i18n::text("extensions.busy",&[]));}
 match method.as_str(){
 "initialize"|"configure"=>{let default=crate::desktop::root(&app)?;let root=(provider(&id).ok_or_else(||crate::i18n::text("extensions.missing",&[]))?.configure)(&args,&default)?;let enabled=slots.get(&key).map(|s|s.enabled).unwrap_or(false);slots.insert(key.clone(),Slot::new(root,enabled));},
 "enable"=>{slots.get_mut(&key).ok_or_else(||crate::i18n::text("extensions.missing",&[]))?.enabled=true;},
 "disable"=>{if let Some(slot)=slots.get_mut(&key){slot.enabled=false;}},
 "dispose"=>{slots.remove(&key);},
 "status"=>{},
 _=>return Err(crate::i18n::text("extensions.invalid",&[]))
 }
 let status=slots.get(&key).map(|s|json!({"enabled":s.enabled,"running":s.running>0,"root":crate::desktop::display_path(&s.root)})).unwrap_or(Value::Null);Ok(status)
}
#[tauri::command]
pub async fn extension_start(app:tauri::AppHandle,window:tauri::WebviewWindow,id:String,method:String,args:Value)->Result<Value,String>{
 crate::desktop::require_main(&window)?;let key=key(&app,&id)?;
 if provider(&id).is_none() || !args.is_object() || serde_json::to_vec(&args).map_err(|e|e.to_string())?.len()>1024*1024{return Err(crate::i18n::text("extensions.invalid",&[]));}
 let state=app.state::<Arc<ExtensionState>>().inner().clone();let (root,queue,ticket)={let mut slots=state.slots.lock().map_err(|e|e.to_string())?;let slot=slots.get_mut(&key).ok_or_else(||crate::i18n::text("extensions.missing",&[]))?;if !slot.enabled{return Err(crate::i18n::text("extensions.notEnabled",&[]));}slot.reserve()?};
 let job=state.next.fetch_add(1,Ordering::SeqCst)+1;state.jobs.lock().map_err(|e|e.to_string())?.insert(job,json!({"id":id,"method":method,"state":"queued"}));
 let workspace=crate::desktop::root(&app)?;
 thread::spawn(move||{
  let result=queue.run(ticket,||{
   if let Ok(mut jobs)=state.jobs.lock(){jobs.insert(job,json!({"id":id,"method":method,"state":"running"}));}
   (provider(&id).unwrap().execute)(&root,&method,&args)
  });
  let reply=match result{Ok(value)=>json!({"id":id,"method":method,"state":"done","result":value}),Err(error)=>json!({"id":id,"method":method,"state":"failed","error":error})};
  if let Ok(mut jobs)=state.jobs.lock(){jobs.insert(job,reply.clone());while jobs.len()>64 || jobs.values().map(|v|serde_json::to_vec(v).map(|b|b.len()).unwrap_or(0)).sum::<usize>()>32*1024*1024{if let Some(old)=jobs.keys().copied().find(|old|*old!=job && (jobs[old]["state"]=="done" || jobs[old]["state"]=="failed")){jobs.remove(&old);}else{break;}}}
  if let Ok(mut slots)=state.slots.lock(){if let Some(slot)=slots.get_mut(&key){slot.running=slot.running.saturating_sub(1);}}
  let _=app.emit("kkb:extension-result",result_event(&workspace,job,&reply));
 });
 Ok(json!({"jobId":job}))
}
#[tauri::command]
pub async fn extension_job(app:tauri::AppHandle,window:tauri::WebviewWindow,job_id:u64)->Result<Value,String>{crate::desktop::require_main(&window)?;app.state::<Arc<ExtensionState>>().jobs.lock().map_err(|e|e.to_string())?.get(&job_id).cloned().ok_or_else(||crate::i18n::text("extensions.invalid",&[]))}

#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn completion_event_matches_the_workspace_path_exposed_to_the_webview(){
  for path in [r"\\?\C:\Users\test\workspace",r"\\?\UNC\server\share"]{
   let workspace=std::path::Path::new(path);let event=result_event(workspace,7,&json!({"id":"git","method":"status","state":"done","result":{"large":"payload"}}));
   assert_eq!(event["workspace"],crate::desktop::display_path(workspace));assert_eq!(event["jobId"],7);assert!(event["reply"].get("result").is_none());
  }
 }
 #[test] fn another_window_can_queue_work_without_a_busy_rejection(){
  let mut slot=Slot::new(PathBuf::from("repo"),true);assert!(slot.reserve().is_ok());assert!(slot.reserve().is_ok(),"a read in another window must not reject the next request");
 }
 #[test] fn queued_work_is_fifo_and_failure_does_not_block_the_next_request(){
  let mut slot=Slot::new(PathBuf::from("repo"),true);let (_,queue,first)=slot.reserve().unwrap();let (_,other,second)=slot.reserve().unwrap();let order=Arc::new(Mutex::new(Vec::new()));let later_order=order.clone();
  let later=thread::spawn(move||other.run(second,||{later_order.lock().unwrap().push(1);Ok(json!(true))}));
  let result=queue.run(first,||{order.lock().unwrap().push(0);Err("test failure".to_owned())});assert!(result.is_err());assert!(later.join().unwrap().is_ok());assert_eq!(*order.lock().unwrap(),vec![0,1]);
 }
}
