import {useEffect,useRef,type PointerEvent as ReactPointerEvent} from 'react';
import {cursorPosition,getCurrentWindow} from '@tauri-apps/api/window';
import {invoke} from '@tauri-apps/api/core';
import {isTauri} from './tauri-backend.ts';
import {watchDragRelease} from './drag-release.ts';
/** Move the manager's shell; cards and interactive controls retain their own gestures. */
export function useManagerDrag(enabled:boolean,onError:(error:string)=>void){
 const dispose=useRef<(()=>void)|null>(null);
 const rightPointer=useRef<number|null>(null);
 useEffect(()=>()=>dispose.current?.(),[]);
 return (event:ReactPointerEvent)=>{
  const right=event.button===2 || event.type==='pointermove' && !!(event.buttons&2);
  if(!enabled || !isTauri() || !right && event.button!==0)return;
  if(right && dispose.current && rightPointer.current===event.pointerId)return;
  const hit=event.target as HTMLElement;
  const body=hit.closest<HTMLElement>('.card-body-editor'),idleBody=body?.dataset.bodyEditing==='false';
  if(!right && (hit.closest('button,input,textarea,select,a,label,summary,[role=separator],[data-card-id],[contenteditable=true],.image-placement,.editable-table,[data-drawing-surface],.note-row,.task-card,.edit-dialog,.action-menu,.modal-backdrop,.menu-backdrop,.canvas-viewport,.editable-title,.proto-note') || !idleBody && hit.closest('.card-regions,.ordinary-document')))return;
  dispose.current?.();
  rightPointer.current=right?event.pointerId:null;event.preventDefault();event.stopPropagation();
  const target=event.currentTarget,pointer=event.pointerId,x=event.clientX,y=event.clientY;
  const origin=Promise.all([cursorPosition(),getCurrentWindow().outerPosition()]);
  let ended=false,started=false,busy=false,frame:number|null=null,running=Promise.resolve(),stopWatch=()=>{};
  const apply=async(finish:boolean)=>{const [[mouse,position],now]=await Promise.all([origin,cursorPosition()]);await invoke('move_note',{x:position.x+now.x-mouse.x,y:position.y+now.y-mouse.y,finish});if(finish)document.dispatchEvent(new CustomEvent('kkb:window-operation',{detail:{operation:'move',position:await getCurrentWindow().outerPosition()}}));};
  const end=()=>{if(ended)return;ended=true;stopWatch();if(frame!==null)cancelAnimationFrame(frame);document.removeEventListener('pointermove',move);document.removeEventListener('pointercancel',end);if(target.hasPointerCapture(pointer))target.releasePointerCapture(pointer);dispose.current=null;rightPointer.current=null;if(started){document.documentElement.classList.remove('card-dragging');void running.then(()=>apply(true)).catch(error=>onError(String(error)));}};
  const move=(e:PointerEvent)=>{if(ended || e.pointerId!==pointer)return;if(!started && Math.hypot(e.clientX-x,e.clientY-y)<6)return;if(!started){started=true;target.setPointerCapture(pointer);document.documentElement.classList.add('card-dragging');}e.preventDefault();if(busy || frame!==null)return;frame=requestAnimationFrame(()=>{frame=null;if(ended)return;busy=true;running=apply(false).catch(error=>onError(String(error))).finally(()=>{busy=false;});});};
  dispose.current=end;document.addEventListener('pointermove',move);document.addEventListener('pointercancel',end);stopWatch=watchDragRelease(target,pointer,right?2:event.buttons,end);
 };
}
