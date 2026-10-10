import {useEffect,useRef,type PointerEvent as ReactPointerEvent} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {cursorPosition,getCurrentWindow} from '@tauri-apps/api/window';
import {isTauri} from './tauri-backend.ts';
import {watchDragRelease} from './drag-release.ts';
/** Native resizing is disabled; this handle is the single interactive resize entry. */
export function useWindowResize(onError:(message:string)=>void) {
 const dispose=useRef<(()=>void)|null>(null);
 useEffect(()=>()=>dispose.current?.(),[]);
 return (event:ReactPointerEvent):void=>{
  if(!isTauri() || event.button!==0)return;
  event.preventDefault();event.stopPropagation();dispose.current?.();
  const target=event.currentTarget,pointer=event.pointerId;target.setPointerCapture(pointer);
  document.documentElement.classList.add('resizing-note');
  const origin=Promise.all([cursorPosition(),getCurrentWindow().innerSize(),getCurrentWindow().scaleFactor()]);
  let stopped=false,frame:number|null=null,running:Promise<void>=Promise.resolve(),busy=false,stopWatch=()=>{};
  const apply=async(finish:boolean)=>{const [[mouse,size,scale],now]=await Promise.all([origin,cursorPosition()]);await invoke('resize_note',{width:(size.width+now.x-mouse.x)/scale,height:(size.height+now.y-mouse.y)/scale,finish});};
  const move=()=>{if(stopped || busy || frame!==null)return;frame=requestAnimationFrame(()=>{frame=null;if(stopped)return;busy=true;running=apply(false).catch(error=>onError(String(error))).finally(()=>{busy=false;});});};
  const end=()=>{
   if(stopped)return;stopped=true;stopWatch();if(frame!==null)cancelAnimationFrame(frame);
   document.removeEventListener('pointermove',move);document.removeEventListener('pointercancel',end);document.documentElement.classList.remove('resizing-note');
   if(target.hasPointerCapture(pointer))target.releasePointerCapture(pointer);dispose.current=null;
   void running.then(()=>apply(true)).catch(error=>onError(String(error)));
  };
  dispose.current=end;document.addEventListener('pointermove',move);document.addEventListener('pointercancel',end);
  stopWatch=watchDragRelease(target,pointer,event.buttons,end);
 };
}
