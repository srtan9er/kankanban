//! Release-time return targets in physical monitor work-area coordinates.
use std::collections::BTreeMap;
use crate::window_chain::WindowChains;
use crate::window_chain_runtime::{Point, Rect};

pub fn return_target(chains:&WindowChains,rects:&BTreeMap<String,Rect>,member:&str,area:Rect)->Option<Point> {
 if !crate::window_chain_runtime::eligible(member) || !valid(area) {return None;}
 let head=chains.head(member);let first=*rects.get(&head)?;
 if !crate::window_chain_runtime::eligible(&head) || !valid(first) {return None;}
 let mut width=first.width;let mut height=0.0;
 for label in chains.suffix(&head) {
  if !crate::window_chain_runtime::eligible(&label) {break;}
  let rect=*rects.get(&label)?;
  if !valid(rect) {return None;}
  width=width.max(rect.width);height+=rect.height;
 }
 // A stack taller than the work area starts at its top; keeping its links is
 // more important than trying to fold or overlap its off-screen tail.
 let target=Point{x:first.x.clamp(area.x,area.x+(area.width-width).max(0.0)),y:first.y.clamp(area.y,area.y+(area.height-height).max(0.0))};
 (target!=first.position()).then_some(target)
}
fn valid(rect:Rect)->bool {
 [rect.x,rect.y,rect.width,rect.height].into_iter().all(f64::is_finite) && rect.width>0.0 && rect.height>0.0
}

#[cfg(test)]
mod tests {
 use super::*;
 fn rect(x:f64,y:f64,width:f64,height:f64)->Rect {Rect{x,y,width,height}}
 fn chain()->WindowChains {WindowChains::from_links(BTreeMap::from([("card-head".into(),"card-tail".into())]))}
 #[test] fn release_returns_the_whole_stack_inside_the_work_area() {
  let rects=BTreeMap::from([("card-head".into(),rect(1000.0,650.0,400.0,200.0)),("card-tail".into(),rect(1000.0,850.0,500.0,120.0))]);
  assert_eq!(return_target(&chain(),&rects,"card-tail",rect(0.0,0.0,1280.0,720.0)),Some(Point{x:780.0,y:400.0}));
 }
 #[test] fn oversize_chain_keeps_its_head_operable_and_does_not_break_links() {
  let chains=chain();let before=chains.clone();
  let rects=BTreeMap::from([("card-head".into(),rect(120.0,200.0,400.0,600.0)),("card-tail".into(),rect(120.0,800.0,400.0,600.0))]);
  assert_eq!(return_target(&chains,&rects,"card-head",rect(0.0,0.0,1280.0,720.0)),Some(Point{x:120.0,y:0.0}));
  assert_eq!(chains,before);
 }
 #[test] fn a_negative_origin_monitor_is_a_real_destination_not_an_overflow() {
  let chains=WindowChains::default();let rects=BTreeMap::from([("card-one".into(),rect(-1800.0,-200.0,400.0,300.0))]);
  assert_eq!(return_target(&chains,&rects,"card-one",rect(-1920.0,-400.0,1920.0,1080.0)),None);
 }
 #[test] fn clamps_against_all_four_edges_and_excludes_the_taskbar() {
  let chains=WindowChains::default();let area=rect(-1920.0,40.0,1920.0,1000.0);
  for (x,y,target) in [(-2000.0,-100.0,Point{x:-1920.0,y:40.0}),(-100.0,1000.0,Point{x:-400.0,y:740.0})] {
   let rects=BTreeMap::from([("card-one".into(),rect(x,y,400.0,300.0))]);
   assert_eq!(return_target(&chains,&rects,"card-one",area),Some(target));
  }
 }
 #[test] fn leaves_an_already_fitting_stack_untouched() {
  let rects=BTreeMap::from([("card-head".into(),rect(100.0,100.0,400.0,200.0)),("card-tail".into(),rect(100.0,300.0,400.0,120.0))]);
  assert_eq!(return_target(&chain(),&rects,"card-head",rect(0.0,0.0,1280.0,720.0)),None);
 }
 #[test] fn missing_invalid_and_manager_windows_do_not_receive_return_targets() {
  let mut rects=BTreeMap::from([("main".into(),rect(-100.0,-100.0,400.0,300.0)),("card-bad".into(),rect(f64::NAN,0.0,400.0,300.0))]);
  let area=rect(0.0,0.0,1280.0,720.0);let chains=WindowChains::default();
  for label in ["main","card-missing","card-bad"] {assert_eq!(return_target(&chains,&rects,label,area),None);}
  rects.insert("card-one".into(),rect(-10.0,-10.0,1400.0,1000.0));
  assert_eq!(return_target(&chains,&rects,"card-one",rect(0.0,0.0,0.0,0.0)),None);
  assert_eq!(return_target(&chains,&rects,"card-one",area),Some(Point{x:0.0,y:0.0}));
 }
}
