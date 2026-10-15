import {useEffect,useRef,type ReactNode,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {bodyViewport} from './image-bounds.ts';
/** Controls live in window coordinates, outside all scrolling/transformed content. */
export function ViewportInkToolbar({anchor,children}:{anchor:RefObject<HTMLElement|null>;children:ReactNode}){
 const toolbar=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const element=anchor.current,control=toolbar.current;if(!element || !control)return;
  const measure=()=>{const clip=bodyViewport(element);control.style.visibility=clip?'visible':'hidden';if(!clip)return;
   const width=control.offsetWidth || 66;control.style.left=`${Math.max(clip.left+8,clip.right-width-8)}px`;control.style.top=`${clip.top+8}px`;control.style.maxWidth=`${Math.max(0,clip.right-clip.left-16)}px`;
  };
  measure();const observer=new ResizeObserver(measure);for(let current:HTMLElement|null=element;current;current=current.parentElement)observer.observe(current);
  window.addEventListener('scroll',measure,true);window.addEventListener('resize',measure);
  return()=>{observer.disconnect();window.removeEventListener('scroll',measure,true);window.removeEventListener('resize',measure);};
 },[anchor]);
 return createPortal(<div ref={toolbar} className="viewport-ink-toolbar" style={{position:'fixed',zIndex:1000003,pointerEvents:'auto',visibility:'hidden'}}>{children}</div>,document.getElementById('root') ?? document.body);
}
