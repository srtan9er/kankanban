//! Physical window effects derived from the pure, stable-label next-chain model.
use std::collections::{BTreeMap, BTreeSet};
use crate::window_chain::WindowChains;

pub use crate::window_chain_follow::{Point,Rect};
#[derive(Clone, Debug, Default)]
pub struct Motion { pub positions: BTreeMap<String, Point>, pub notify: BTreeSet<String>, pub fixed: bool, pub attached: bool }
#[derive(Clone, Debug)]
struct Drag {
 source: String, original: WindowChains, rects: BTreeMap<String, Rect>, members: BTreeSet<String>,
 last: BTreeMap<String, Point>, preview: WindowChains, notified: BTreeSet<String>, fixed: bool,
}
#[derive(Clone)]
struct DisplayMotion {
 epoch:u64, source:String, rects:BTreeMap<String,Rect>, chains:WindowChains,
 labels:BTreeSet<String>, fixed:bool, released:bool, running:bool, return_to:Option<(String,Point)>,
}
struct DisplayFrame { motion:Motion, pending:bool, settled:bool }
trait DisplayEffects {
 fn apply(&mut self,positions:&BTreeMap<String,Point>)->Result<(),String>;
 fn persist(&mut self,labels:&BTreeSet<String>)->Result<(),String>;
 fn end(&mut self,labels:&BTreeSet<String>,fixed:bool)->Result<(),String>;
}
fn apply_display_frame(frame:&DisplayFrame,effects:&mut impl DisplayEffects)->Result<bool,String>{
 effects.apply(&frame.motion.positions)?;
 if frame.settled{let persisted=effects.persist(&frame.motion.notify);let ended=effects.end(&frame.motion.notify,frame.motion.fixed);persisted?;ended?;}
 Ok(frame.pending)
}
fn apply_stopped_motion(motion:&Motion,persist:bool,effects:&mut impl DisplayEffects)->Result<(),String>{
 let applied=effects.apply(&motion.positions);let saved=if persist{effects.persist(&motion.notify)}else{Ok(())};
 let ended=effects.end(&motion.notify,motion.fixed);applied?;saved?;ended?;Ok(())
}
#[derive(Clone, Default)]
pub struct WindowChainRuntime { pub chains: WindowChains, drag: Option<Drag>, display:Option<DisplayMotion>, pub suspended: bool, restoring: bool }
static DISPLAY_EPOCH:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(1);
pub fn eligible(label: &str) -> bool { label.starts_with("card-") && label.len()>5 }
enum Attachment<'a> { Preview, Accepted(Option<&'a str>) }
impl WindowChainRuntime {
 pub fn visible_chains(&self)->WindowChains {self.drag.as_ref().map(|drag|drag.preview.clone()).unwrap_or_else(||self.chains.clone())}
 fn start_display(&mut self,label:&str,rects:BTreeMap<String,Rect>,fixed:bool) {
  let epoch=DISPLAY_EPOCH.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
  self.display=Some(DisplayMotion{epoch,source:label.to_owned(),rects,chains:self.visible_chains(),labels:self.members(label),fixed,released:false,running:false,return_to:None});
 }
 fn display_move(&mut self,label:&str,motion:&Motion,released:bool,return_to:Option<(String,Point)>)->Option<Motion>{
  let mut chains=self.visible_chains();if !released{chains.detach_suffix(label);}
  let display=self.display.as_mut().filter(|display|display.source==label)?;
  display.labels.extend(motion.notify.iter().cloned());
  if let Some((head,_))=&return_to{display.labels.extend(chains.suffix(head));}
  chains.next.retain(|_,to|display.labels.contains(to));display.chains=chains;display.released=released;display.return_to=return_to;
  let mut positions=BTreeMap::new();
  if let Some(point)=motion.positions.get(label){let rect=display.rects.get_mut(label)?;rect.x=point.x;rect.y=point.y;positions.insert(label.to_owned(),*point);}
  Some(Motion{positions,notify:display.labels.clone(),fixed:display.fixed,attached:motion.attached})
 }
 fn display_tick(&mut self,epoch:u64,dt:f64,scale:f64)->Option<DisplayFrame>{
  if self.suspended{return None;}
  let display=self.display.as_mut().filter(|display|display.epoch==epoch)?;
  let mut positions=BTreeMap::new();let mut head_pending=false;
  if let Some((label,target))=&display.return_to {if let Some(rect)=display.rects.get_mut(label){
   let point=crate::window_chain_follow::chase_point(rect.position(),*target,dt,scale);head_pending=point!=*target;
   if point.x.round()!=rect.x.round() || point.y.round()!=rect.y.round(){positions.insert(label.clone(),point);}
   rect.x=point.x;rect.y=point.y;
  }}
  let tick=crate::window_chain_follow::chase_tick(&display.chains,&display.rects,dt,scale);
  for (label,point) in tick.positions {if let Some(rect)=display.rects.get_mut(&label){
   if point.x.round()!=rect.x.round() || point.y.round()!=rect.y.round(){positions.insert(label,point);}
   rect.x=point.x;rect.y=point.y;
  }}
  let pending=tick.pending || head_pending;let settled=!pending && display.released;
  let motion=Motion{positions,notify:display.labels.clone(),fixed:display.fixed,attached:false};
  if !pending{display.running=false;}if settled{self.display=None;}
  Some(DisplayFrame{motion,pending,settled})
 }
 fn stop_display(&mut self)->Option<Motion>{
  self.display.take().map(|display|Motion{positions:BTreeMap::new(),notify:display.labels,fixed:display.fixed,attached:false})
 }
 fn stop_active_motion(&mut self)->Option<(Motion,bool)>{
  if let Some(label)=self.active_label().map(str::to_owned){self.cancel(&label).map(|motion|(motion,false))}else{self.stop_display().map(|motion|(motion,true))}
 }
 pub fn begin(&mut self, label: &str, rects: BTreeMap<String, Rect>, fixed: bool) -> bool {
  if !eligible(label) || !rects.contains_key(label) || self.drag.is_some() || self.suspended {return false;}
  let members:BTreeSet<_>=self.chains.suffix(label).into_iter().filter(|key|rects.contains_key(key)).collect();
  self.drag=Some(Drag{source:label.to_owned(),original:self.chains.clone(),last:rects.iter().map(|(key,rect)|(key.clone(),rect.position())).collect(),rects,notified:members.clone(),members,preview:self.chains.clone(),fixed});true
 }
 pub fn dragging(&self, label: &str) -> bool { self.drag.as_ref().is_some_and(|drag|drag.source==label) }
 pub fn members(&self, label: &str) -> BTreeSet<String> { self.drag.as_ref().filter(|drag|drag.source==label).map(|drag|drag.members.clone()).unwrap_or_default() }
 pub fn preview(&mut self, label: &str, desired: Point, fallback: Point, radius: f64) -> Option<Motion> {
  self.preview_attachment(label,desired,fallback,radius,Attachment::Preview)
 }
 pub fn preview_with_snap(&mut self, label: &str, desired: Point, fallback: Point, radius: f64, accepted_after:Option<&str>) -> Option<Motion> {
  self.preview_attachment(label,desired,fallback,radius,Attachment::Accepted(accepted_after))
 }
 fn preview_attachment(&mut self, label: &str, desired: Point, fallback: Point, radius: f64, attachment:Attachment<'_>) -> Option<Motion> {
  let drag=self.drag.as_mut().filter(|drag|drag.source==label)?;
  let mut chain=drag.original.clone();chain.detach_suffix(label);
  let target=match attachment {
   Attachment::Accepted(target)=>target.filter(|target|eligible(target) && !drag.members.contains(*target) && drag.rects.contains_key(*target)).map(str::to_owned),
   Attachment::Preview=>drag.rects.iter().filter(|(key,_)|eligible(key) && !drag.members.contains(*key)).map(|(key,rect)|(key,(desired.x-rect.x).hypot(desired.y-rect.y-rect.height))).filter(|(_,distance)|*distance<=radius).min_by(|a,b|a.1.total_cmp(&b.1)).map(|(key,_)|key.clone()),
  };
  let mut positions: BTreeMap<_,_>=drag.rects.iter().map(|(key,rect)|(key.clone(),rect.position())).collect();
  let attached=target.as_ref().is_some_and(|target|chain.splice_after(target,label).is_ok());
  if let Some(target)=target.filter(|_|attached) {
   positions.extend(layout_suffix(&chain,&target,&drag.rects));
  } else {
   let origin=drag.rects.get(label)?;
   for key in &drag.members {if let Some(rect)=drag.rects.get(key){positions.insert(key.clone(),Point{x:rect.x+fallback.x-origin.x,y:rect.y+fallback.y-origin.y});}}
  }
  let changed:BTreeMap<_,_>=positions.iter().filter(|(key,point)|drag.last.get(*key)!=Some(*point)).map(|(key,point)|(key.clone(),*point)).collect();
  drag.notified.extend(changed.keys().cloned());drag.notified.extend(drag.members.iter().cloned());
  drag.last=positions;drag.preview=chain;
  Some(Motion{positions:changed,notify:drag.notified.clone(),fixed:drag.fixed,attached})
 }
 pub fn finish(&mut self, label: &str) -> Option<Motion> {
  if !self.dragging(label){return None;}
  let drag=self.drag.take()?;self.chains=drag.preview;
  let positions=drag.last.into_iter().filter(|(key,_)|drag.notified.contains(key)).collect();
  Some(Motion{positions,notify:drag.notified,fixed:drag.fixed,attached:false})
 }
 pub fn cancel(&mut self, label: &str) -> Option<Motion> {
  if !self.dragging(label){return None;}
  let display=self.stop_display();
  let mut drag=self.drag.take()?;if let Some(display)=display{drag.notified.extend(display.notify);}self.chains=drag.original;
  let positions=drag.rects.into_iter().filter(|(key,_)|drag.notified.contains(key)).map(|(key,rect)|(key,rect.position())).collect();
  Some(Motion{positions,notify:drag.notified,fixed:drag.fixed,attached:false})
 }
 pub fn active_label(&self) -> Option<&str> { self.drag.as_ref().map(|drag|drag.source.as_str()) }
}
pub fn layout_suffix(chains: &WindowChains, start: &str, rects: &BTreeMap<String, Rect>) -> BTreeMap<String, Point> {
 let mut result=BTreeMap::new();let Some(anchor)=rects.get(start) else{return result;};let x=anchor.x;let mut y=anchor.y;
 for key in chains.suffix(start){let Some(rect)=rects.get(&key) else{break;};result.insert(key,Point{x,y});y+=rect.height;}
 result
}

pub async fn with_effect_gate<T>(gate: &tokio::sync::Mutex<()>, operation: impl FnOnce()->Result<T,String>) -> Result<T,String> {
 let _guard=gate.lock().await;operation()
}
pub async fn with_window_effects<T>(app: &tauri::AppHandle, operation: impl FnOnce()->Result<T,String>) -> Result<T,String> {
 let state=app.state::<DesktopState>();with_effect_gate(&state.chain_effects,operation).await
}
trait CloseEffects {
 fn apply(&mut self, positions: &BTreeMap<String,Point>) -> Result<(),String>;
 fn persist(&mut self, chains: &WindowChains, labels: &BTreeSet<String>) -> Result<(),String>;
 fn suppress(&mut self, enabled: bool) -> Result<(),String>;
 fn destroy(&mut self) -> Result<(),String>;
 fn exists(&self) -> bool;
}
#[derive(Debug)]
struct CloseFailure { error: String, rollback: Vec<String> }
impl CloseFailure {
 fn message(self) -> String {
  if self.rollback.is_empty(){self.error}else{crate::i18n::text("native/desktop.windowChainRollbackFailed",&[("arg0",self.error),("arg1",self.rollback.join("\n"))])}
 }
}
fn close_transaction(runtime: &mut WindowChainRuntime, label: &str, rects: &BTreeMap<String,Rect>, destroy: bool, effects: &mut impl CloseEffects) -> Result<(),CloseFailure> {
 let original=runtime.chains.clone();
 let previous=runtime.chains.prev(label).map(str::to_owned);runtime.chains.remove(label);
 let positions=previous.map(|previous|layout_suffix(&runtime.chains,&previous,rects)).unwrap_or_default();let labels:BTreeSet<_>=positions.keys().cloned().collect();
 let result=effects.apply(&positions).and_then(|()|effects.persist(&runtime.chains,&labels)).and_then(|()|{if destroy{effects.suppress(true)?;effects.destroy()}else{Ok(())}});
 if let Err(error)=result {
  // A failed response does not prove that the OS window still exists.
  // Once it disappeared its label must never be restored into persisted links.
  let restored=if effects.exists(){runtime.chains=original;labels.iter().filter_map(|key|rects.get(key).map(|rect|(key.clone(),rect.position()))).collect()}else{positions};
  let mut rollback=Vec::new();
  if let Err(error)=effects.suppress(false){rollback.push(error);}
  if let Err(error)=effects.apply(&restored){rollback.push(error);}
  if let Err(error)=effects.persist(&runtime.chains,&labels){rollback.push(error);}
  runtime.restoring=!rollback.is_empty();
  return Err(CloseFailure{error,rollback});
 }
 Ok(())
}

trait PinEffects {
 fn apply(&mut self, pins:&BTreeMap<String,bool>)->Result<(),String>;
 fn persist(&mut self, pins:&BTreeMap<String,bool>)->Result<(),String>;
 fn notify(&mut self, pins:&BTreeMap<String,bool>)->Result<(),String>;
}
fn pin_transaction(current:&BTreeMap<String,bool>, desired:&BTreeMap<String,bool>, effects:&mut impl PinEffects)->Result<(),CloseFailure> {
 let changes:BTreeMap<_,_>=desired.iter().filter(|(key,value)|current.get(*key)!=Some(*value)).map(|(key,value)|(key.clone(),*value)).collect();
 if changes.is_empty(){return Ok(());}
 let mut next=current.clone();next.extend(changes.clone());
 if let Err(error)=effects.apply(&changes).and_then(|()|effects.persist(&next)).and_then(|()|effects.notify(&changes)) {
  let restore: BTreeMap<_,_>=changes.keys().map(|key|(key.clone(),current.get(key).copied().unwrap_or(false))).collect();let mut rollback=Vec::new();
  if let Err(error)=effects.apply(&restore){rollback.push(error);}
  if let Err(error)=effects.persist(current){rollback.push(error);}
  if let Err(error)=effects.notify(&restore){rollback.push(error);}
  return Err(CloseFailure{error,rollback});
 }
 Ok(())
}

use tauri::{Emitter, Manager};
use crate::desktop::{DesktopState, save_windows};

struct NativePinEffects<'a> {app:&'a tauri::AppHandle}
impl PinEffects for NativePinEffects<'_> {
 fn apply(&mut self,pins:&BTreeMap<String,bool>)->Result<(),String>{
  for (label,pinned) in pins {if let Some(window)=self.app.get_webview_window(label){window.set_always_on_top(*pinned).map_err(|error|error.to_string())?;}}Ok(())
 }
 fn persist(&mut self,pins:&BTreeMap<String,bool>)->Result<(),String>{crate::desktop::save_pin_preferences(self.app,pins)}
 fn notify(&mut self,pins:&BTreeMap<String,bool>)->Result<(),String>{
  for (label,pinned) in pins {if self.app.get_webview_window(label).is_some(){self.app.emit_to(label.as_str(),"kkb:window-chain-pin",serde_json::json!({"pinned":pinned})).map_err(|error|error.to_string())?;}}Ok(())
 }
}
fn pin_values(app:&tauri::AppHandle)->Result<BTreeMap<String,bool>,String>{
 let mut pins:BTreeMap<_,_>=app.state::<DesktopState>().prefs.lock().map_err(|error|error.to_string())?.iter().map(|(label,prefs)|(label.clone(),prefs.pinned)).collect();
 for (label,window) in app.webview_windows(){pins.insert(label,window.is_always_on_top().map_err(|error|error.to_string())?);}Ok(pins)
}
pub fn normalize_pins(app:&tauri::AppHandle)->Result<(),String>{
 let pins=pin_values(app)?;let desired={let state=app.state::<DesktopState>();let runtime=state.chains.lock().map_err(|error|error.to_string())?;crate::window_chain_pin::inherited_pins(&runtime.chains,&pins)};
 pin_transaction(&pins,&desired,&mut NativePinEffects{app}).map_err(CloseFailure::message)
}
pub fn set_pinned(app:&tauri::AppHandle,label:&str,pinned:bool)->Result<(),String>{
 let pins=pin_values(app)?;let desired={let state=app.state::<DesktopState>();let runtime=state.chains.lock().map_err(|error|error.to_string())?;crate::window_chain_pin::pin_chain(&runtime.chains,&pins,label,pinned)};
 pin_transaction(&pins,&desired,&mut NativePinEffects{app}).map_err(CloseFailure::message)?;
 let chains=app.state::<DesktopState>().chains.lock().map_err(|error|error.to_string())?.visible_chains();
 crate::window_chain_zorder::raise_group(app,&chains,label,false)
}
pub fn display_active(app:&tauri::AppHandle)->Result<bool,String>{Ok(app.state::<DesktopState>().chains.lock().map_err(|error|error.to_string())?.display.is_some())}

pub fn load(root: &std::path::Path) -> WindowChainRuntime {
 let mut chains:WindowChains=std::fs::read(root.join(".kkb/window-chains.json")).ok().and_then(|bytes|serde_json::from_slice(&bytes).ok()).unwrap_or_default();
 // Native restoration is incremental. Live-window filtering happens only after sync.
 chains.sanitize(eligible);WindowChainRuntime{chains,restoring:true,..Default::default()}
}
fn write_next(root: &std::path::Path, chains: &WindowChains) -> Result<(),String> {
 let bytes=serde_json::to_vec_pretty(chains).map_err(|error|error.to_string())?;
 let temporary=root.join(".kkb/window-chains.tmp");
 std::fs::write(&temporary,bytes).and_then(|()|std::fs::rename(temporary,root.join(".kkb/window-chains.json"))).map_err(|error|crate::i18n::text("native/desktop.windowChainSaveFailed",&[("arg0",error.to_string())]))
}
pub fn save(app: &tauri::AppHandle) -> Result<(),String> {
 let state=app.state::<DesktopState>();let root=state.root.lock().map_err(|error|error.to_string())?.clone();let Some(root)=root else{return Ok(());};
 let runtime=state.chains.lock().map_err(|error|error.to_string())?;
 write_next(&root,&runtime.chains)
}
fn rectangles(app: &tauri::AppHandle) -> BTreeMap<String,Rect> {
 app.webview_windows().into_iter().filter(|(label,_)|eligible(label)).filter_map(|(label,window)|{
  let position=window.outer_position().ok()?;let size=window.outer_size().ok()?;
  Some((label,Rect{x:position.x as f64,y:position.y as f64,width:size.width as f64,height:size.height as f64}))
 }).collect()
}
fn notify(app: &tauri::AppHandle, labels: &BTreeSet<String>, active: bool, fixed: bool) -> Result<(),String> {
 for label in labels {if app.get_webview_window(label).is_some(){app.emit_to(label.as_str(),"kkb:window-chain-motion",serde_json::json!({"active":active,"fixed":fixed})).map_err(|error|error.to_string())?;}}
 Ok(())
}
fn apply(app: &tauri::AppHandle, positions: &BTreeMap<String,Point>) -> Result<(),String> {
 apply_positions(positions,|label,x,y|{if let Some(window)=app.get_webview_window(label){window.set_position(tauri::PhysicalPosition::new(x,y)).map_err(|error|error.to_string())?;}Ok(())})
}
pub(crate) fn apply_positions(positions:&BTreeMap<String,Point>,mut set:impl FnMut(&str,i32,i32)->Result<(),String>)->Result<(),String>{
 for (label,point) in positions {set(label,point.x.round() as i32,point.y.round() as i32)?;}
 Ok(())
}
fn save_members(app: &tauri::AppHandle, labels: impl IntoIterator<Item=String>) -> Result<(),String> {
 save_windows(app,labels.into_iter().filter_map(|label|app.get_webview_window(&label)))
}
struct NativeDisplay<'a>(&'a tauri::AppHandle);
impl DisplayEffects for NativeDisplay<'_>{
 fn apply(&mut self,positions:&BTreeMap<String,Point>)->Result<(),String>{apply(self.0,positions)}
 fn persist(&mut self,labels:&BTreeSet<String>)->Result<(),String>{save_members(self.0,labels.iter().cloned())}
 fn end(&mut self,labels:&BTreeSet<String>,fixed:bool)->Result<(),String>{notify(self.0,labels,false,fixed)}
}
fn release_target(app:&tauri::AppHandle,window:&tauri::WebviewWindow)->Result<Option<(String,Point)>,String>{
 let position=window.outer_position().map_err(|error|error.to_string())?;
 let monitor=window.current_monitor().map_err(|error|error.to_string())?.or_else(||window.available_monitors().ok()?.into_iter().min_by(|a,b|{
  let distance=|monitor:&tauri::Monitor|{let area=monitor.work_area();let x=position.x as f64;let y=position.y as f64;
   (x-x.clamp(area.position.x as f64,(area.position.x+area.size.width as i32) as f64)).hypot(y-y.clamp(area.position.y as f64,(area.position.y+area.size.height as i32) as f64))};distance(a).total_cmp(&distance(b))
 }));
 let Some(monitor)=monitor else{return Ok(None);};let area=monitor.work_area();
 let state=app.state::<DesktopState>();let runtime=state.chains.lock().map_err(|error|error.to_string())?;
 let Some(display)=&runtime.display else{return Ok(None);};
 Ok(crate::window_chain_bounds::return_target(&runtime.chains,&display.rects,window.label(),Rect{x:area.position.x as f64,y:area.position.y as f64,width:area.size.width as f64,height:area.size.height as f64}).map(|point|(runtime.chains.head(window.label()),point)))
}
fn tick_display(app:&tauri::AppHandle,epoch:u64,dt:f64)->Result<bool,String>{
 let state=app.state::<DesktopState>();
 let source={let runtime=state.chains.lock().map_err(|error|error.to_string())?;let Some(display)=runtime.display.as_ref().filter(|display|display.epoch==epoch)else{return Ok(false);};display.source.clone()};
 let scale=app.get_webview_window(&source).and_then(|window|window.scale_factor().ok()).unwrap_or(1.0);
 let frame=state.chains.lock().map_err(|error|error.to_string())?.display_tick(epoch,dt,scale);
 let Some(frame)=frame else{return Ok(false);};
 match apply_display_frame(&frame,&mut NativeDisplay(app)){
  Ok(pending)=>Ok(pending),
  Err(error)=>{let mut rollback=Vec::new();if let Err(error)=cancel_active(app){rollback.push(error);}if let Err(error)=notify(app,&frame.motion.notify,false,frame.motion.fixed){rollback.push(error);}Err(CloseFailure{error,rollback}.message())}
 }
}
fn ensure_display_clock(app:&tauri::AppHandle)->Result<(),String>{
 let epoch={let state=app.state::<DesktopState>();let mut runtime=state.chains.lock().map_err(|error|error.to_string())?;
  let Some(display)=runtime.display.as_mut()else{return Ok(());};if display.running{return Ok(());}display.running=true;display.epoch};
 let app=app.clone();
 std::thread::Builder::new().name("kkb-window-follow".into()).spawn(move||{
  let mut previous=std::time::Instant::now();
  loop{
   std::thread::sleep(std::time::Duration::from_millis(16));let now=std::time::Instant::now();let dt=now.duration_since(previous).as_secs_f64();previous=now;
   let result=tauri::async_runtime::block_on(with_window_effects(&app,||tick_display(&app,epoch,dt)));
   match result{Ok(true)=>{},Ok(false)=>break,Err(error)=>{let _=app.emit("kkb:window-chain-error",serde_json::json!({"error":error}));break;}}
  }
 }).map_err(|error|error.to_string())?;Ok(())
}
pub fn begin(app: &tauri::AppHandle, label: &str, fixed: bool) -> Result<(),String> {
 if !eligible(label){return Ok(());}
 cancel_active(app)?;
 normalize_pins(app)?;
 let state=app.state::<DesktopState>();let rects=rectangles(app);
 let members={let mut runtime=state.chains.lock().map_err(|error|error.to_string())?;if !runtime.begin(label,rects.clone(),fixed){return Ok(());}runtime.start_display(label,rects,fixed);runtime.members(label)};
 if let Err(error)=notify(app,&members,true,fixed){cancel(app,label)?;return Err(error);}
 Ok(())
}
pub fn cancel(app: &tauri::AppHandle, label: &str) -> Result<(),String> {
 let motion=app.state::<DesktopState>().chains.lock().map_err(|error|error.to_string())?.cancel(label);
 if let Some(motion)=motion {let applied=apply(app,&motion.positions);let notified=notify(app,&motion.notify,false,motion.fixed);applied?;notified?;}
 Ok(())
}
pub fn cancel_active(app: &tauri::AppHandle) -> Result<(),String> {
 let stopped=app.state::<DesktopState>().chains.lock().map_err(|error|error.to_string())?.stop_active_motion();
 if let Some((motion,persist))=stopped{apply_stopped_motion(&motion,persist,&mut NativeDisplay(app))?;}
 Ok(())
}
pub fn move_active(app: &tauri::AppHandle, window: &tauri::WebviewWindow, x: f64, y: f64, finish: bool) -> Result<Option<serde_json::Value>,String> {
 let state=app.state::<DesktopState>();let label=window.label();
 let members={let runtime=state.chains.lock().map_err(|error|error.to_string())?;if !runtime.dragging(label){return Ok(None);}runtime.members(label)};
 let snapped=crate::snap::calculate(app,window,x,y,&members)?;
 let desired=Point{x,y};let fallback=if finish {Point{x:snapped.x,y:snapped.y}}else{desired};
 let radius=12.0*window.scale_factor().map_err(|error|error.to_string())?;
 let motion={let mut runtime=state.chains.lock().map_err(|error|error.to_string())?;
  if finish{runtime.preview_with_snap(label,desired,fallback,radius,snapped.chain_after.as_deref())}else{runtime.preview(label,desired,fallback,radius)}};
 let Some(motion)=motion else{return Ok(None);};
 let immediate=state.chains.lock().map_err(|error|error.to_string())?.display_move(label,&motion,false,None);
 let Some(immediate)=immediate else{return Ok(None);};
 if let Err(error)=notify(app,&immediate.notify,true,immediate.fixed).and_then(|()|apply(app,&immediate.positions)){cancel(app,label)?;return Err(error);}
 if finish {
  let mut rollback=state.chains.lock().map_err(|error|error.to_string())?.clone();
  let completed=state.chains.lock().map_err(|error|error.to_string())?.finish(label);
  let Some(completed)=completed else{return Ok(None);};
  let finished=(||{
   let return_to=release_target(app,window)?;
   let released=state.chains.lock().map_err(|error|error.to_string())?.display_move(label,&motion,true,return_to);
   if let Some(released)=released{
    if let Some(drag)=rollback.drag.as_mut(){drag.notified.extend(released.notify.iter().cloned());}
    notify(app,&released.notify,true,released.fixed)?;
   }
   save(app)?;normalize_pins(app)?;
   let chains=state.chains.lock().map_err(|error|error.to_string())?.visible_chains();
   crate::window_chain_zorder::raise_group(app,&chains,label,true)
  })();
  if let Err(error)=finished {
   *state.chains.lock().map_err(|error|error.to_string())?=rollback;
   let restored=cancel(app,label);let resaved=save(app);let preferences=save_members(app,completed.notify.iter().cloned());restored?;resaved?;preferences?;return Err(error);
  }
 }
 if let Err(error)=ensure_display_clock(app){cancel_active(app)?;return Err(error);}
 let mut hints=snapped.hints;if motion.attached {hints["top"]=serde_json::Value::Bool(true);}
 Ok(Some(hints))
}
pub fn reflow(app: &tauri::AppHandle, label: &str, persist: bool) -> Result<(),String> {
 cancel_active(app)?;
 let rects=rectangles(app);let positions={let state=app.state::<DesktopState>();let runtime=state.chains.lock().map_err(|error|error.to_string())?;layout_suffix(&runtime.chains,label,&rects)};
 apply(app,&positions)?;if persist {save_members(app,positions.into_keys())?;}Ok(())
}
pub fn restore_available(app: &tauri::AppHandle) -> Result<(),String> {
 let rects=rectangles(app);
 let positions={let state=app.state::<DesktopState>();let runtime=state.chains.lock().map_err(|error|error.to_string())?;
  if runtime.drag.is_some() || runtime.display.is_some(){return Ok(());}
  let heads:BTreeSet<_>=rects.keys().map(|label|runtime.chains.head(label)).collect();let mut positions=BTreeMap::new();
  for head in heads {positions.extend(layout_suffix(&runtime.chains,&head,&rects));}positions};
 apply(app,&positions)?;normalize_pins(app)
}
pub fn prune(app: &tauri::AppHandle) -> Result<(),String> {
 let live:BTreeSet<_>=rectangles(app).into_keys().collect();
 {let state=app.state::<DesktopState>();let mut runtime=state.chains.lock().map_err(|error|error.to_string())?;if runtime.drag.is_some() || runtime.display.is_some() || runtime.suspended{return Ok(());}let changed=runtime.chains.sanitize(|label|live.contains(label));if !changed && !runtime.restoring{return Ok(());}runtime.restoring=false;}
 let result=restore_available(app).and_then(|()|save(app)).and_then(|()|save_members(app,live));
 if result.is_err(){app.state::<DesktopState>().chains.lock().map_err(|error|error.to_string())?.restoring=true;}result
}
struct NativeCloseEffects<'a> {app:&'a tauri::AppHandle,label:&'a str}
impl CloseEffects for NativeCloseEffects<'_> {
 fn apply(&mut self, positions:&BTreeMap<String,Point>)->Result<(),String>{apply(self.app,positions)}
 fn persist(&mut self, chains:&WindowChains, labels:&BTreeSet<String>)->Result<(),String>{
  let root=self.app.state::<DesktopState>().root.lock().map_err(|error|error.to_string())?.clone();
  if let Some(root)=root{write_next(&root,chains)?;}save_members(self.app,labels.iter().cloned())
 }
 fn suppress(&mut self, enabled:bool)->Result<(),String>{
  let state=self.app.state::<DesktopState>();let mut ignored=state.chain_destroy_suppression.lock().map_err(|error|error.to_string())?;
  if enabled{ignored.insert(self.label.to_owned());}else{ignored.remove(self.label);}Ok(())
 }
 fn destroy(&mut self)->Result<(),String>{if let Some(window)=self.app.get_webview_window(self.label){window.destroy().map_err(|error|error.to_string())?;}Ok(())}
 fn exists(&self)->bool{self.app.get_webview_window(self.label).is_some_and(|window|window.outer_position().is_ok())}
}
pub fn close_window(app: &tauri::AppHandle, label: &str, destroy: bool) -> Result<(),String> {
 if !eligible(label){return Ok(());}
 let state=app.state::<DesktopState>();
 if state.chains.lock().map_err(|error|error.to_string())?.suspended{return Ok(());}
 cancel_active(app)?;normalize_pins(app)?;let rects=rectangles(app);let mut staging=state.chains.lock().map_err(|error|error.to_string())?.clone();
 let result=close_transaction(&mut staging,label,&rects,destroy,&mut NativeCloseEffects{app,label});
 *state.chains.lock().map_err(|error|error.to_string())?=staging;result.map_err(CloseFailure::message)?;normalize_pins(app)
}
pub fn suspend(app: &tauri::AppHandle) -> Result<(),String> {
 cancel_active(app)?;save(app)?;app.state::<DesktopState>().chains.lock().map_err(|error|error.to_string())?.suspended=true;Ok(())
}
pub fn suppress_destroy(app: &tauri::AppHandle, label: &str) -> Result<(),String> {
 app.state::<DesktopState>().chain_destroy_suppression.lock().map_err(|error|error.to_string())?.insert(label.to_owned());Ok(())
}
pub fn destroyed(app: &tauri::AppHandle, label: &str) -> Result<(),String> {
 if app.state::<DesktopState>().chain_destroy_suppression.lock().map_err(|error|error.to_string())?.remove(label){return Ok(());}
 close_window(app,label,false)
}

#[cfg(test)]
mod tests {
 use super::*;
 fn rect(x:f64,y:f64,h:f64)->Rect {Rect{x,y,width:200.0,height:h}}
 fn fixture()->WindowChainRuntime {WindowChainRuntime{chains:WindowChains::from_links(BTreeMap::from([("card-a".into(),"card-b".into()),("card-b".into(),"card-c".into()),("card-x".into(),"card-y".into())])),..Default::default()}}
 fn windows()->BTreeMap<String,Rect>{BTreeMap::from([("card-a".into(),rect(10.0,20.0,100.0)),("card-b".into(),rect(10.0,120.0,120.0)),("card-c".into(),rect(10.0,240.0,80.0)),("card-x".into(),rect(500.0,20.0,90.0)),("card-y".into(),rect(500.0,110.0,70.0)),("main".into(),rect(900.0,20.0,600.0))])}
 fn p(x:f64,y:f64)->Point{Point{x,y}}
 #[test]fn follow_display_moves_only_head_immediately_and_continues_without_pointer_messages(){
  let mut runtime=fixture();runtime.begin("card-a",windows(),true);runtime.start_display("card-a",windows(),true);
  let target=runtime.preview("card-a",p(210.0,220.0),p(210.0,220.0),12.0).unwrap();
  let immediate=runtime.display_move("card-a",&target,false,None).unwrap();
  assert_eq!(immediate.positions,BTreeMap::from([("card-a".into(),p(210.0,220.0))]));
  let epoch=runtime.display.as_ref().unwrap().epoch;
  let first=runtime.display_tick(epoch,0.016,1.0).unwrap();
  let b=runtime.display.as_ref().unwrap().rects["card-b"].position();
  let c=runtime.display.as_ref().unwrap().rects["card-c"].position();
  assert!(first.pending);assert!(b.x>10.0 && b.x<210.0);assert!(c.x>10.0 && c.x<b.x);
  for _ in 0..200{runtime.display_tick(epoch,0.016,1.0);}
  assert_eq!(runtime.display.as_ref().unwrap().rects["card-c"].position(),p(210.0,440.0));
  assert!(runtime.dragging("card-a"));
 }
 #[test]fn released_follow_settles_before_end_and_an_old_epoch_cannot_write_again(){
  let mut runtime=fixture();runtime.begin("card-a",windows(),false);runtime.start_display("card-a",windows(),false);
  let target=runtime.preview("card-a",p(210.0,220.0),p(210.0,220.0),12.0).unwrap();
  runtime.finish("card-a").unwrap();runtime.display_move("card-a",&target,true,None).unwrap();
  let epoch=runtime.display.as_ref().unwrap().epoch;
  assert!(!runtime.display_tick(epoch,0.016,1.0).unwrap().settled);
  let mut settled=false;for _ in 0..200{if let Some(frame)=runtime.display_tick(epoch,0.016,1.0){if frame.settled{settled=true;break;}}}
  assert!(settled);assert!(runtime.display.is_none());assert!(runtime.display_tick(epoch,0.016,1.0).is_none());
 }
 #[derive(Default)]struct DisplayRecorder{writes:usize,saves:usize,ends:usize,fail_save:bool}
 #[test]fn a_released_worker_failure_clears_running_state_preserves_topology_and_ends_fixed_guard(){
  let mut runtime=fixture();runtime.begin("card-a",windows(),true);runtime.start_display("card-a",windows(),true);
  let target=runtime.preview("card-a",p(210.0,220.0),p(210.0,220.0),12.0).unwrap();runtime.finish("card-a").unwrap();runtime.display_move("card-a",&target,true,None).unwrap();
  let epoch=runtime.display.as_ref().unwrap().epoch;runtime.display.as_mut().unwrap().running=true;
  let committed=runtime.chains.clone();let (stopped,persist)=runtime.stop_active_motion().unwrap();
  let mut effects=DisplayRecorder::default();apply_stopped_motion(&stopped,persist,&mut effects).unwrap();
  assert_eq!((effects.writes,effects.saves,effects.ends),(0,1,1));assert_eq!(runtime.chains,committed);
  assert!(runtime.display.is_none());assert!(runtime.display_tick(epoch,0.016,1.0).is_none());
 }
 #[test]fn cancelling_follow_restores_original_geometry_and_invalidates_queued_frames(){
  let mut runtime=fixture();runtime.begin("card-a",windows(),true);runtime.start_display("card-a",windows(),true);
  let target=runtime.preview("card-a",p(210.0,220.0),p(210.0,220.0),12.0).unwrap();runtime.display_move("card-a",&target,false,None).unwrap();
  let epoch=runtime.display.as_ref().unwrap().epoch;runtime.display_tick(epoch,0.016,1.0).unwrap();
  let restored=runtime.cancel("card-a").unwrap();assert_eq!(restored.positions["card-c"],windows()["card-c"].position());
  assert!(runtime.display_tick(epoch,0.016,1.0).is_none());assert!(runtime.display.is_none());
 }
 #[test]fn a_new_workspace_cannot_reuse_an_old_worker_epoch(){
  let mut old=fixture();old.begin("card-a",windows(),false);old.start_display("card-a",windows(),false);let old_epoch=old.display.as_ref().unwrap().epoch;
  old.stop_display();
  let mut next=fixture();next.begin("card-a",windows(),false);next.start_display("card-a",windows(),false);
  assert_ne!(old_epoch,next.display.as_ref().unwrap().epoch);
  assert!(next.display_tick(old_epoch,0.016,1.0).is_none());
 }
 #[test]fn released_head_returns_smoothly_and_its_tail_tracks_its_current_position(){
  let mut runtime=fixture();runtime.begin("card-a",windows(),true);runtime.start_display("card-a",windows(),true);
  let target=runtime.preview("card-a",p(900.0,500.0),p(900.0,500.0),12.0).unwrap();runtime.finish("card-a").unwrap();
  runtime.display_move("card-a",&target,true,Some(("card-a".into(),p(600.0,300.0)))).unwrap();
  let epoch=runtime.display.as_ref().unwrap().epoch;let frame=runtime.display_tick(epoch,0.016,1.0).unwrap();
  let rects=&runtime.display.as_ref().unwrap().rects;assert!(rects["card-a"].x>600.0 && rects["card-a"].x<900.0);assert!(rects["card-b"].x<rects["card-a"].x);assert!(frame.pending);
  let mut written=BTreeMap::new();let mut settled=false;
  for _ in 0..300{if let Some(frame)=runtime.display_tick(epoch,0.016,1.0){apply_positions(&frame.motion.positions,|label,x,y|{written.insert(label.to_owned(),(x,y));Ok(())}).unwrap();if frame.settled{settled=true;break;}}}
  assert!(settled);assert_eq!(written["card-a"],(600,300));assert_eq!(written["card-b"],(600,400));assert_eq!(written["card-c"],(600,520));
 }
 #[test]fn a_new_drag_freezes_released_motion_at_current_geometry_without_undoing_the_committed_chain(){
  let mut runtime=fixture();runtime.begin("card-a",windows(),false);runtime.start_display("card-a",windows(),false);
  let target=runtime.preview("card-a",p(210.0,220.0),p(210.0,220.0),12.0).unwrap();runtime.finish("card-a").unwrap();runtime.display_move("card-a",&target,true,None).unwrap();
  let old_epoch=runtime.display.as_ref().unwrap().epoch;runtime.display_tick(old_epoch,0.016,1.0).unwrap();
  let current=runtime.display.as_ref().unwrap().rects.clone();let inherited=runtime.chains.clone();
  runtime.stop_display().unwrap();assert_eq!(runtime.chains,inherited);
  assert!(runtime.begin("card-b",current.clone(),true));runtime.start_display("card-b",current.clone(),true);
  assert!(runtime.display_tick(old_epoch,0.016,1.0).is_none());
  let point=current["card-b"].position();let next=p(point.x+30.0,point.y+40.0);
  let target=runtime.preview("card-b",next,next,12.0).unwrap();let immediate=runtime.display_move("card-b",&target,false,None).unwrap();
  assert_eq!(immediate.positions["card-b"],next);assert_eq!(runtime.display.as_ref().unwrap().rects["card-c"],current["card-c"]);
 }
 impl DisplayEffects for DisplayRecorder{
  fn apply(&mut self,positions:&BTreeMap<String,Point>)->Result<(),String>{self.writes+=positions.len();Ok(())}
  fn persist(&mut self,_:&BTreeSet<String>)->Result<(),String>{self.saves+=1;if self.fail_save{Err("injected display save failure".into())}else{Ok(())}}
  fn end(&mut self,_:&BTreeSet<String>,fixed:bool)->Result<(),String>{assert!(fixed);self.ends+=1;Ok(())}
 }
 #[test]fn follow_frame_effects_save_once_after_release_and_clear_fixed_even_on_save_error(){
  for fail_save in [false,true]{
   let mut runtime=fixture();runtime.begin("card-a",windows(),true);runtime.start_display("card-a",windows(),true);
   let target=runtime.preview("card-a",p(210.0,220.0),p(210.0,220.0),12.0).unwrap();runtime.display_move("card-a",&target,false,None).unwrap();
   let epoch=runtime.display.as_ref().unwrap().epoch;let mut effects=DisplayRecorder{fail_save,..Default::default()};
   for _ in 0..5{let frame=runtime.display_tick(epoch,0.016,1.0).unwrap();apply_display_frame(&frame,&mut effects).unwrap();}
   assert!(effects.writes>0);assert_eq!((effects.saves,effects.ends),(0,0));
   runtime.finish("card-a").unwrap();runtime.display_move("card-a",&target,true,None).unwrap();
   let mut result=Ok(true);for _ in 0..200{let Some(frame)=runtime.display_tick(epoch,0.016,1.0)else{break;};result=apply_display_frame(&frame,&mut effects);if frame.settled{break;}}
   assert_eq!(result.is_err(),fail_save);assert_eq!((effects.saves,effects.ends),(1,1));
  }
 }
 #[test]fn middle_drag_moves_only_suffix_and_does_not_commit_until_finish(){
  let mut runtime=fixture();let original=runtime.chains.clone();assert!(runtime.begin("card-b",windows(),false));
  let motion=runtime.preview("card-b",p(200.0,300.0),p(200.0,300.0),12.0).unwrap();
  assert_eq!(motion.positions.get("card-b"),Some(&p(200.0,300.0)));assert_eq!(motion.positions.get("card-c"),Some(&p(200.0,420.0)));assert!(!motion.positions.contains_key("card-a"));assert_eq!(runtime.chains,original);
  runtime.finish("card-b").unwrap();assert_eq!(runtime.chains.prev("card-b"),None);assert_eq!(runtime.chains.next.get("card-b").map(String::as_str),Some("card-c"));
 }
 #[test]fn head_drag_moves_entire_chain_and_main_never_joins(){
  let mut runtime=fixture();assert!(!runtime.begin("main",windows(),false));assert!(runtime.begin("card-a",windows(),true));
  let motion=runtime.preview("card-a",p(60.0,70.0),p(60.0,70.0),12.0).unwrap();assert!(motion.fixed);assert_eq!(motion.positions.len(),3);assert_eq!(motion.positions.get("card-c"),Some(&p(60.0,290.0)));assert!(!motion.positions.contains_key("main"));
 }
 #[test]fn insert_at_lower_left_previews_middle_reflow_and_cancel_restores_all_affected_positions(){
  let mut runtime=fixture();let original=runtime.chains.clone();assert!(runtime.begin("card-x",windows(),true));
  let motion=runtime.preview("card-x",p(12.0,121.0),p(12.0,121.0),12.0).unwrap();assert!(motion.attached);
  assert_eq!(motion.positions.get("card-x"),Some(&p(10.0,120.0)));assert_eq!(motion.positions.get("card-y"),Some(&p(10.0,210.0)));assert_eq!(motion.positions.get("card-b"),Some(&p(10.0,280.0)));assert_eq!(motion.positions.get("card-c"),Some(&p(10.0,400.0)));assert_eq!(runtime.chains,original);
  let restored=runtime.cancel("card-x").unwrap();for label in ["card-x","card-y","card-b","card-c"]{assert_eq!(restored.positions.get(label),Some(&windows()[label].position()));}assert_eq!(runtime.chains,original);assert!(!runtime.dragging("card-x"));
 }
 #[test]fn leaving_a_preview_restores_target_tail_and_commits_only_the_final_connection(){
  let mut runtime=fixture();runtime.begin("card-x",windows(),false);runtime.preview("card-x",p(10.0,120.0),p(10.0,120.0),12.0).unwrap();
  let motion=runtime.preview("card-x",p(700.0,500.0),p(710.0,500.0),12.0).unwrap();assert!(!motion.attached);assert_eq!(motion.positions.get("card-b"),Some(&p(10.0,120.0)));assert_eq!(motion.positions.get("card-x"),Some(&p(710.0,500.0)));
  runtime.finish("card-x").unwrap();assert_eq!(runtime.chains.next.get("card-a").map(String::as_str),Some("card-b"));assert_eq!(runtime.chains.prev("card-x"),None);
 }
 #[test]fn attach_uses_only_raw_lower_left_proximity_and_ignores_moving_members(){
  let mut runtime=fixture();runtime.begin("card-b",windows(),false);
  let motion=runtime.preview("card-b",p(11.0,239.0),p(10.0,240.0),12.0).unwrap();assert!(!motion.attached);
  let motion=runtime.preview("card-b",p(500.0,200.0),p(500.0,110.0),12.0).unwrap();assert!(!motion.attached,"ordinary geometric snapping must not establish a chain");
 }
 #[test]fn resize_and_middle_close_reflow_the_remaining_suffix_from_the_same_anchor(){
  let mut runtime=fixture();let mut rects=windows();rects.get_mut("card-a").unwrap().height=38.0;
  assert_eq!(layout_suffix(&runtime.chains,"card-a",&rects).get("card-b"),Some(&p(10.0,58.0)));
  runtime.chains.remove("card-b");let positions=layout_suffix(&runtime.chains,"card-a",&rects);assert_eq!(positions.get("card-c"),Some(&p(10.0,58.0)));assert_eq!(runtime.chains.next.get("card-a").map(String::as_str),Some("card-c"));
 }
 #[test]fn saved_topology_roundtrips_full_view_labels_without_touching_window_preferences(){
  let root=std::env::temp_dir().join(format!("kkb-chain-runtime-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));std::fs::create_dir_all(root.join(".kkb")).unwrap();
  let preferences=root.join(".kkb/window-prefs.json");std::fs::write(&preferences,b"existing-prefs").unwrap();
  let chains=WindowChains::from_links(BTreeMap::from([("card-same__one".into(),"card-same__two".into()),("card-same__two".into(),"card-ext-git__one".into())]));
  write_next(&root,&chains).unwrap();let loaded=load(&root);assert_eq!(loaded.chains,chains);assert!(loaded.restoring);assert!(!loaded.suspended);assert!(loaded.active_label().is_none());assert_eq!(std::fs::read(&preferences).unwrap(),b"existing-prefs");
  let encoded:serde_json::Value=serde_json::from_slice(&std::fs::read(root.join(".kkb/window-chains.json")).unwrap()).unwrap();assert_eq!(encoded.as_object().unwrap().len(),1);assert!(encoded.get("next").is_some());std::fs::remove_dir_all(&root).unwrap();
 }
 #[test]fn loading_filters_main_bad_labels_and_cycles_but_preserves_not_yet_spawned_members(){
  let root=std::env::temp_dir().join(format!("kkb-chain-load-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));std::fs::create_dir_all(root.join(".kkb")).unwrap();
  std::fs::write(root.join(".kkb/window-chains.json"),br#"{"next":{"card-a":"card-b","card-b":"card-a","main":"card-c","invalid":"card-d"}}"#).unwrap();let loaded=load(&root);
  assert_eq!(loaded.chains.next,BTreeMap::from([("card-a".into(),"card-b".into())]));assert!(loaded.restoring);
  std::fs::write(root.join(".kkb/window-chains.json"),b"invalid-json").unwrap();assert!(load(&root).chains.next.is_empty());std::fs::remove_dir_all(&root).unwrap();
 }
 #[derive(Clone,Copy,PartialEq)]enum Fail {Apply,Persist,Suppress,Destroy,AfterDestroy}
 struct CloseFixture {positions:BTreeMap<String,Point>,stored:WindowChains,suppressed:bool,exists:bool,fail:Option<Fail>}
 impl CloseFixture {fn fail(&mut self,stage:Fail)->Result<(),String>{if self.fail==Some(stage){self.fail=None;Err("injected failure".into())}else{Ok(())}}}
 impl CloseEffects for CloseFixture {
  fn apply(&mut self,positions:&BTreeMap<String,Point>)->Result<(),String>{self.positions.extend(positions.iter().map(|(key,value)|(key.clone(),*value)));self.fail(Fail::Apply)}
  fn persist(&mut self,chains:&WindowChains,_:&BTreeSet<String>)->Result<(),String>{self.stored=chains.clone();self.fail(Fail::Persist)}
  fn suppress(&mut self,enabled:bool)->Result<(),String>{self.suppressed=enabled;if enabled{self.fail(Fail::Suppress)}else{Ok(())}}
  fn destroy(&mut self)->Result<(),String>{self.fail(Fail::Destroy)?;self.exists=false;self.fail(Fail::AfterDestroy)}
  fn exists(&self)->bool{self.exists}
 }
 fn closing(fail:Option<Fail>)->(WindowChainRuntime,BTreeMap<String,Rect>,CloseFixture){let runtime=fixture();let rects=windows();let effects=CloseFixture{positions:rects.iter().map(|(key,rect)|(key.clone(),rect.position())).collect(),stored:runtime.chains.clone(),suppressed:false,exists:true,fail};(runtime,rects,effects)}
 #[test]fn close_failure_restores_topology_geometry_storage_and_suppression(){
  for failure in [Fail::Apply,Fail::Persist,Fail::Suppress,Fail::Destroy]{let(mut runtime,rects,mut effects)=closing(Some(failure));let original=runtime.chains.clone();let before=effects.positions.clone();
   assert!(close_transaction(&mut runtime,"card-b",&rects,true,&mut effects).is_err());assert_eq!(runtime.chains,original);assert_eq!(effects.positions,before);assert_eq!(effects.stored,original);assert!(!effects.suppressed);assert!(effects.exists);
  }
 }
 #[test]fn close_failure_after_actual_destruction_does_not_restore_a_missing_node(){
  let(mut runtime,rects,mut effects)=closing(Some(Fail::AfterDestroy));let before=effects.positions.clone();
  assert!(close_transaction(&mut runtime,"card-b",&rects,true,&mut effects).is_err());assert!(!effects.exists);assert!(!runtime.chains.next.contains_key("card-b"));assert_eq!(runtime.chains.next.get("card-a").map(String::as_str),Some("card-c"));assert_eq!(effects.stored,runtime.chains);assert_ne!(effects.positions.get("card-c"),before.get("card-c"));assert_eq!(effects.positions.get("card-c"),Some(&p(10.0,120.0)));assert!(!effects.suppressed);
 }
 #[test]fn unexpected_destroy_failure_keeps_survivors_consistent_and_never_resurrects_the_removed_view(){
  let(mut runtime,mut rects,mut effects)=closing(Some(Fail::Persist));effects.exists=false;rects.remove("card-b");
  assert!(close_transaction(&mut runtime,"card-b",&rects,false,&mut effects).is_err());assert_eq!(runtime.chains.next.get("card-a").map(String::as_str),Some("card-c"));assert_eq!(effects.stored,runtime.chains);assert_eq!(effects.positions.get("card-c"),Some(&p(10.0,120.0)));assert!(!effects.suppressed);
 }
 struct PinFixture {native:BTreeMap<String,bool>,stored:BTreeMap<String,bool>,events:BTreeMap<String,bool>,fail:Option<u8>}
 impl PinFixture {fn fail(&mut self,stage:u8)->Result<(),String>{if self.fail==Some(stage){self.fail=None;Err("injected pin failure".into())}else{Ok(())}}}
 impl PinEffects for PinFixture {
  fn apply(&mut self,pins:&BTreeMap<String,bool>)->Result<(),String>{self.native.extend(pins.clone());self.fail(0)}
  fn persist(&mut self,pins:&BTreeMap<String,bool>)->Result<(),String>{self.stored=pins.clone();self.fail(1)}
  fn notify(&mut self,pins:&BTreeMap<String,bool>)->Result<(),String>{self.events.extend(pins.clone());self.fail(2)}
 }
 #[test]fn pin_failures_restore_native_flags_preferences_and_visible_button_state(){
  for stage in 0..3 {let current=BTreeMap::from([("card-a".into(),false),("card-b".into(),false),("card-other".into(),true)]);let desired=BTreeMap::from([("card-a".into(),true),("card-b".into(),true)]);let mut effects=PinFixture{native:current.clone(),stored:current.clone(),events:current.clone(),fail:Some(stage)};
   assert!(pin_transaction(&current,&desired,&mut effects).is_err());assert_eq!(effects.native,current);assert_eq!(effects.stored,current);assert_eq!(effects.events,current);
  }
 }
 #[test]fn successful_pin_change_targets_only_the_requested_chain_and_publishes_after_save(){
  let current=BTreeMap::from([("card-a".into(),false),("card-b".into(),false),("card-other".into(),true)]);let desired=BTreeMap::from([("card-a".into(),true),("card-b".into(),true)]);let mut effects=PinFixture{native:current.clone(),stored:current.clone(),events:current.clone(),fail:None};pin_transaction(&current,&desired,&mut effects).unwrap();assert_eq!(effects.native["card-a"],true);assert_eq!(effects.native["card-b"],true);assert_eq!(effects.native["card-other"],true);assert_eq!(effects.native,effects.stored);assert_eq!(effects.native,effects.events);
 }
}
