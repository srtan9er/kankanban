import {useLayoutEffect,useRef} from 'react';
import {createPortal} from 'react-dom';
import {uiText} from '../i18n/text.ts';

export type ImageHoverPoint={index:number;x:number;y:number;name?:string};
/** A pointer hint renders immediately; it never inherits the native title delay. */
export function ImageHoverHint({point}:{point:ImageHoverPoint|null}){
 const host=useRef<HTMLSpanElement>(null);
 useLayoutEffect(()=>{
  const element=host.current;if(!element || !point)return;
  const width=element.offsetWidth || 80,height=element.offsetHeight || 22;
  const place=({x,y}:{x:number;y:number})=>{
   const viewportWidth=document.documentElement.clientWidth || window.innerWidth,viewportHeight=document.documentElement.clientHeight || window.innerHeight;
   const left=x+12+width<=viewportWidth?x+12:x-width-12;
   const top=y+16+height<=viewportHeight?y+16:y-height-12;
   element.style.left=`${Math.max(4,Math.min(left,viewportWidth-width-4))}px`;
   element.style.top=`${Math.max(4,Math.min(top,viewportHeight-height-4))}px`;
  };
  place(point);
  // Move only the hint; pointer motion must not re-render the Markdown layout.
  const move=(event:PointerEvent)=>place({x:event.clientX,y:event.clientY});
  window.addEventListener('pointermove',move,true);return()=>window.removeEventListener('pointermove',move,true);
 },[point]);
 return point?createPortal(<span ref={host} className="image-hover-hint" role="tooltip">{uiText('images.editorToken',{arg0:point.name ?? `image_${point.index}`})}</span>,document.body):null;
}
