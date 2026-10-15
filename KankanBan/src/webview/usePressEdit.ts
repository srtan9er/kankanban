import {useEffect,useRef,type PointerEvent as ReactPointerEvent,type MouseEvent as ReactMouseEvent} from 'react';
import {passedDragThreshold} from './pointer-gesture.ts';
import {onScrollbar} from './drag-geometry.ts';
type Field='title'|'content';
export function editFieldAt(target:Element,scope:'note'|'manager'):Field|null{
 if(target.closest('button,a,.image-placement,.body-images,.editable-table,[data-drawing-surface],[data-card-id]'))return null;
 if(target.closest(scope==='note'?'.title':'.editable-title'))return 'title';
 if(target.closest('input,textarea,select,[contenteditable]'))return null;
 return target.closest(scope==='note'?'.preview':'.ordinary-content')?'content':null;
}
/** A click edits the field hit on press; a drag never becomes an editor activation. */
export function usePressEdit(scope:'note'|'manager',edit:(field:Field)=>void){
 const press=useRef<{pointerId:number;field:Field|null;clientX:number;clientY:number;screenX:number;screenY:number;moved:boolean}|null>(null);
 useEffect(()=>{
  const move=(event:PointerEvent)=>{const start=press.current;if(!start || start.pointerId!==event.pointerId)return;
   if(passedDragThreshold(start,event) || Math.hypot(event.screenX-start.screenX,event.screenY-start.screenY)>=6)start.moved=true;
  };
  const cancel=()=>{press.current=null;};
  document.addEventListener('pointermove',move,true);document.addEventListener('pointerup',move,true);document.addEventListener('pointercancel',cancel,true);window.addEventListener('blur',cancel);
  return()=>{document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',move,true);document.removeEventListener('pointercancel',cancel,true);window.removeEventListener('blur',cancel);};
 },[]);
 return {
  onPointerDownCapture:(event:ReactPointerEvent)=>{
   press.current=null;if(event.button!==0 || !(event.target instanceof Element))return;
   const field=onScrollbar(event.target as HTMLElement,event.clientX,event.clientY)?null:editFieldAt(event.target,scope);
   press.current={pointerId:event.pointerId,field,clientX:event.clientX,clientY:event.clientY,screenX:event.screenX,screenY:event.screenY,moved:false};
  },
  onClickCapture:(event:ReactMouseEvent)=>{
   const start=press.current;press.current=null;if(event.button!==0)return;
   const field=event.detail===0 && event.target instanceof Element?editFieldAt(event.target,scope):start && !start.moved?start.field:null;
   if(field)edit(field);
  },
 };
}
