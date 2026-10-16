//! An activated chain occupies consecutive Windows Z-order slots without changing focus.
use std::collections::BTreeSet;
use crate::window_chain::WindowChains;

pub(crate) fn group_order(chains:&WindowChains,live:&BTreeSet<String>,member:&str)->Vec<String> {
 if !live.contains(member) || !crate::window_chain_runtime::eligible(member) {return Vec::new();}
 let mut chains=chains.clone();chains.sanitize(|label|live.contains(label) && crate::window_chain_runtime::eligible(label));
 let ordered=chains.suffix(&chains.head(member));if ordered.len()>1 {ordered}else{Vec::new()}
}

pub fn raise_group(app:&tauri::AppHandle,chains:&WindowChains,member:&str,require_foreground:bool)->Result<(),String> {
 #[cfg(windows)] {native::raise(app,chains,member,require_foreground)}
 #[cfg(not(windows))] {let _=(app,chains,member,require_foreground);Ok(())}
}

trait OrderEffects {
 fn foreground(&self)->Option<usize>;
 fn place_after(&mut self,window:usize,previous:Option<usize>)->Result<(),String>;
}
fn apply_order(handles:&[usize],require_foreground:bool,effects:&mut impl OrderEffects)->Result<(),String> {
 if handles.len()<2 || (require_foreground && !effects.foreground().is_some_and(|handle|handles.contains(&handle))) {return Ok(());}
 for (i,handle) in handles.iter().enumerate() {
  // A foreground event may have been queued before the user switched apps.
  // NOACTIVATE alone does not prevent covering that newly foreground app.
  if require_foreground && !effects.foreground().is_some_and(|foreground|handles.contains(&foreground)) {break;}
  effects.place_after(*handle,i.checked_sub(1).map(|previous|handles[previous]))?;
 }
 Ok(())
}

#[cfg(windows)]
mod native {
 use super::*;
 use std::{collections::BTreeMap,ffi::c_void};
 use tauri::Manager;
 const FLAGS:u32=0x0001|0x0002|0x0010|0x0200; // NOSIZE | NOMOVE | NOACTIVATE | NOOWNERZORDER
 #[link(name="user32")]
 unsafe extern "system" {
  fn GetForegroundWindow()->*mut c_void;
  fn IsWindowVisible(window:*mut c_void)->i32;
  fn IsIconic(window:*mut c_void)->i32;
  fn SetWindowPos(window:*mut c_void,after:*mut c_void,x:i32,y:i32,width:i32,height:i32,flags:u32)->i32;
 }
 struct NativeOrder {pinned:bool}
 impl OrderEffects for NativeOrder {
  fn foreground(&self)->Option<usize> {let value=unsafe{GetForegroundWindow()} as usize;(value!=0).then_some(value)}
  fn place_after(&mut self,window:usize,previous:Option<usize>)->Result<(),String> {
   let after=previous.map(|handle|handle as *mut c_void).unwrap_or(if self.pinned {(-1_isize) as *mut c_void}else{std::ptr::null_mut()});
   if unsafe{SetWindowPos(window as *mut c_void,after,0,0,0,0,FLAGS)}==0 {
    return Err(crate::i18n::text("native/desktop.windowChainOrderFailed",&[("arg0",std::io::Error::last_os_error().to_string())]));
   }
   Ok(())
  }
 }
 pub(super) fn raise(app:&tauri::AppHandle,chains:&WindowChains,member:&str,require_foreground:bool)->Result<(),String> {
  let windows:BTreeMap<_,_>=app.webview_windows().into_iter().filter_map(|(label,window)|window.hwnd().ok().map(|hwnd|(label,(window,hwnd.0 as usize)))).collect();
  let labels=group_order(chains,&windows.keys().cloned().collect(),member);
  let Some(head)=labels.first().and_then(|label|windows.get(label)) else{return Ok(());};
  let handles:Vec<_>=labels.iter().filter_map(|label|windows.get(label)).filter(|(_,handle)|unsafe{IsWindowVisible(*handle as *mut c_void)!=0 && IsIconic(*handle as *mut c_void)==0}).map(|(_,handle)|*handle).collect();
  let pinned=head.0.is_always_on_top().map_err(|error|error.to_string())?;
  apply_order(&handles,require_foreground,&mut NativeOrder{pinned})
 }
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn activating_any_member_selects_the_full_chain_in_head_first_order() {
  let chains=WindowChains::from_links([("card-same__head","card-same__middle"),("card-same__middle","card-ext-git__tail"),("card-other","card-other-tail")].map(|(a,b)|(a.to_owned(),b.to_owned())).into_iter().collect());
  let live=["card-same__head","card-same__middle","card-ext-git__tail","card-other","card-other-tail","main"].map(str::to_owned).into_iter().collect();
  for member in ["card-same__head","card-same__middle","card-ext-git__tail"] {
   assert_eq!(group_order(&chains,&live,member),["card-same__head","card-same__middle","card-ext-git__tail"]);
  }
 }
 #[test] fn manager_missing_or_independent_windows_do_not_raise_other_windows() {
  let chains=WindowChains::from_links([("main","card-one"),("card-one","card-two")].map(|(a,b)|(a.to_owned(),b.to_owned())).into_iter().collect());
  let live=["main","card-one","card-two","card-independent"].map(str::to_owned).into_iter().collect();
  for member in ["main","card-missing","card-independent"] {assert!(group_order(&chains,&live,member).is_empty());}
  assert_eq!(group_order(&chains,&live,"card-two"),["card-one","card-two"]);
 }
 #[test] fn a_destroyed_member_is_not_passed_to_native_ordering() {
  let chains=WindowChains::from_links([("card-a","card-dead"),("card-dead","card-b"),("card-b","card-c")].map(|(a,b)|(a.to_owned(),b.to_owned())).into_iter().collect());
  let live=["card-a","card-b","card-c"].map(str::to_owned).into_iter().collect();
  assert!(group_order(&chains,&live,"card-a").is_empty());
  assert_eq!(group_order(&chains,&live,"card-c"),["card-b","card-c"]);
 }
 struct Effects {front:Option<usize>,order:Vec<usize>,writes:Vec<(usize,Option<usize>)>,switch_after:Option<usize>,fail:Option<usize>}
 impl OrderEffects for Effects {
  fn foreground(&self)->Option<usize> {self.front}
  fn place_after(&mut self,window:usize,previous:Option<usize>)->Result<(),String> {
   self.writes.push((window,previous));if self.fail==Some(window) {return Err("native-error".into());}
   self.order.retain(|w|*w!=window);let i=previous.and_then(|p|self.order.iter().position(|w|*w==p).map(|i|i+1)).unwrap_or(0);self.order.insert(i,window);
   if self.switch_after==Some(window) {self.front=Some(99);}Ok(())
  }
 }
 fn effects()->Effects {Effects{front:Some(2),order:vec![2,99,1,3],writes:vec![],switch_after:None,fail:None}}
 #[test] fn native_group_application_is_contiguous_without_changing_the_focused_member() {
  let mut e=effects();apply_order(&[1,2,3],true,&mut e).unwrap();assert_eq!(e.order,[1,2,3,99]);assert_eq!(e.front,Some(2));assert_eq!(e.writes,[(1,None),(2,Some(1)),(3,Some(2))]);
 }
 #[test] fn stale_foreground_does_not_reorder_but_a_click_raises_an_already_contiguous_group() {
  for front in [None,Some(99)] {let mut e=effects();e.front=front;apply_order(&[1,2,3],true,&mut e).unwrap();assert!(e.writes.is_empty());}
  let mut e=effects();e.order=vec![99,1,2,3];apply_order(&[1,2,3],true,&mut e).unwrap();assert_eq!(e.order,[1,2,3,99]);assert_eq!(e.writes.len(),3);
 }
 #[test] fn a_foreground_change_during_the_batch_stops_further_raises() {
  let mut e=effects();e.switch_after=Some(1);apply_order(&[1,2,3],true,&mut e).unwrap();assert_eq!(e.writes,[(1,None)]);assert_eq!(e.front,Some(99));
 }
 #[test] fn explicit_pin_restacking_works_without_activation_and_reports_native_failures() {
  let mut e=effects();e.front=Some(99);apply_order(&[1,2,3],false,&mut e).unwrap();assert_eq!(e.order,[1,2,3,99]);assert_eq!(e.front,Some(99));
  let mut e=effects();e.fail=Some(2);assert_eq!(apply_order(&[1,2,3],true,&mut e),Err("native-error".into()));assert_eq!(e.writes,[(1,None),(2,Some(1))]);
 }
}
