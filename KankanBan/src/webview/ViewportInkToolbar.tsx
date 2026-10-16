import {useEffect,useRef,type ReactNode,type RefObject} from 'react';
import {createPortal} from 'react-dom';
/** Float outside document layout, anchored to the body border box. Its client
 * width is deliberately ignored: a scrollbar must not move these controls. */
export function ViewportInkToolbar({anchor,children}:{anchor:RefObject<HTMLElement|null>;children:ReactNode}){
 const toolbar=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const element=anchor.current,control=toolbar.current;if(!element || !control)return;
  const pane=element.closest<HTMLElement>('.canvas-viewport') ?? element.closest<HTMLElement>('.ordinary-content') ?? element.closest<HTMLElement>('.card-body-region') ?? element.closest<HTMLElement>('.preview') ?? element;
  const measure=()=>{
   const rect=pane.getBoundingClientRect(),left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(window.innerWidth,rect.right),bottom=Math.min(window.innerHeight,rect.bottom),width=Math.max(0,right-left),height=Math.max(0,bottom-top);
   control.style.left=`${right-24}px`;control.style.top=`${bottom-24}px`;
   control.style.maxWidth=`${Math.max(0,width-32)}px`;control.style.maxHeight=`${Math.max(0,height-32)}px`;control.style.visibility=width>32 && height>32?'visible':'hidden';
  };
  measure();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);observer?.observe(pane);
  window.addEventListener('resize',measure);window.addEventListener('scroll',measure,true);
  return()=>{observer?.disconnect();window.removeEventListener('resize',measure);window.removeEventListener('scroll',measure,true);};
 },[anchor]);
 return createPortal(<div ref={toolbar} className="viewport-ink-toolbar" style={{position:'fixed',transform:'translate(-100%, -100%)',overflow:'hidden',visibility:'hidden',zIndex:1000003,pointerEvents:'auto'}}>{children}</div>,document.getElementById('root') ?? document.body);
}
