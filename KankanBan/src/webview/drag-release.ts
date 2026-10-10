import {invoke} from '@tauri-apps/api/core';
import {isTauri} from './tauri-backend.ts';

/** A chord ends when either required button is released, including outside the webview. */
export function watchDragRelease(target:Element,pointerId:number,buttons:number,release:()=>void):()=>void {
 const mask=(buttons&3)===3?3:(buttons&4)?4:(buttons&2)?2:1;
 let captured=target.hasPointerCapture?.(pointerId) ?? false;
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 const check=(current:number)=>{if(!stopped && (current&mask)!==mask)release();};
 const pointer=(event:PointerEvent)=>{if(event.pointerId===pointerId)check(event.buttons);};
 const mouse=(event:MouseEvent)=>check(event.buttons);
 const got=(event:PointerEvent)=>{if(event.pointerId===pointerId && target.hasPointerCapture?.(pointerId))captured=true;};
 const lost=(event:PointerEvent)=>{if(event.pointerId===pointerId && captured && !stopped && !target.hasPointerCapture?.(pointerId))release();};
 const blur=()=>{if(!stopped)release();};
 const poll=async():Promise<void>=>{
  try {const current=await invoke<number|null>('drag_mouse_buttons');if(current!==null)check(current);}
  catch {return;} // DOM capture remains active if the native command is unavailable.
  if(!stopped)timer=setTimeout(()=>{void poll();},32);
 };
 window.addEventListener('pointerup',pointer,true);window.addEventListener('pointermove',pointer,true);
 window.addEventListener('mouseup',mouse,true);window.addEventListener('blur',blur);
 target.addEventListener('gotpointercapture',got as EventListener);
 target.addEventListener('lostpointercapture',lost as EventListener);
 // The drag owner captures only after its movement threshold is crossed.
 // Capturing on pointerdown retargets a simple click away from title/body editors.
 if(isTauri())timer=setTimeout(()=>{void poll();},32);
 return()=>{
  stopped=true;if(timer)clearTimeout(timer);
  window.removeEventListener('pointerup',pointer,true);window.removeEventListener('pointermove',pointer,true);
  window.removeEventListener('mouseup',mouse,true);window.removeEventListener('blur',blur);
  target.removeEventListener('gotpointercapture',got as EventListener);
  target.removeEventListener('lostpointercapture',lost as EventListener);
 };
}
