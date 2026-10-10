import {useEffect,useRef,type MouseEvent as ReactMouseEvent,type PointerEvent as ReactPointerEvent} from 'react';
import {canvasGesture,type CanvasDragAction,type CanvasDragBindings} from '../core/canvas-drag.ts';
export const CANVAS_PAN_START='kkb:canvas-pan-start';
export function useFixedCanvasDrag(enabled:boolean,bindings:CanvasDragBindings,start:(event:ReactPointerEvent,mode:CanvasDragAction)=>void) {
 const active=useRef<string|null>(null);
 useEffect(()=>{
  const reset=()=>{active.current=null;};
  window.addEventListener('mouseup',reset,true);window.addEventListener('blur',reset);
  return()=>{window.removeEventListener('mouseup',reset,true);window.removeEventListener('blur',reset);};
 },[]);
 const begin=(event:ReactPointerEvent):void=>{
  if(document.documentElement.dataset.doodleExiting)return;
  if(!enabled || (event.target as HTMLElement).closest('button,textarea,select,input:not([readonly]),[role=separator],[data-drawing-surface]'))return;
  const gesture=canvasGesture(event.button,event.buttons);
  if(active.current===gesture)return;
  const mode=bindings[gesture];
  // A single-button drag of a child still moves that child.
  if(gesture!=='combined' && mode!=='pan' && (event.target as HTMLElement).closest('[data-card-id]'))return;
  event.preventDefault();event.stopPropagation();start(event,mode);
  if(mode==='pan'){
   // A busy rebase can decline the start. Retry held middle/chord moves until accepted.
   const target=event.currentTarget.querySelector('.canvas-viewport');
   const request=new CustomEvent(CANVAS_PAN_START,{detail:event,cancelable:true});
   active.current=target && !target.dispatchEvent(request)?gesture:null;
  }else active.current=gesture;
 };
 return {
  onPointerDownCapture:(event:ReactPointerEvent)=>{active.current=null;begin(event);},
  onPointerMoveCapture:(event:ReactPointerEvent)=>{if((event.buttons&4)!==0 || (event.buttons&3)===3)begin(event);},
  onPointerUpCapture:()=>{active.current=null;},
  onPointerCancelCapture:()=>{active.current=null;},
  onContextMenuCapture:(event:ReactMouseEvent)=>{if(enabled)event.preventDefault();},
  onAuxClickCapture:(event:ReactMouseEvent)=>{if(enabled)event.preventDefault();},
 };
}
