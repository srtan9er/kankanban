import {useLayoutEffect,useRef,type HTMLAttributes} from 'react';
import {CARD_MIN_WIDTH} from '../core/layout-metrics.ts';

/** Keep tree/DOM order; place each natural-height card into the shortest column. */
export function MasonryGrid({children,...props}:HTMLAttributes<HTMLDivElement>) {
 const host=useRef<HTMLDivElement>(null),surface=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  const element=host.current,body=surface.current;if(!element || !body)return;
  const slots=[...body.children] as HTMLElement[];
  let frame:number|null=null,disposed=false;
  const layout=()=>{
   if(disposed || body.clientWidth<=0)return;
   const gap=parseFloat(getComputedStyle(element).columnGap)||0;
   const columns=Math.max(1,Math.floor((body.clientWidth+gap)/(CARD_MIN_WIDTH+gap)));
   const width=CARD_MIN_WIDTH;
   // Assign widths first, then read heights, so wrapping is measured at the final width.
   for(const slot of slots)slot.style.width=`${width}px`;
   const heights=slots.map(slot=>slot.getBoundingClientRect().height);
   const bottoms=Array<number>(columns).fill(0);
   slots.forEach((slot,i)=>{
    const column=bottoms.indexOf(Math.min(...bottoms));
    slot.style.left=`${column*(width+gap)}px`;
    slot.style.top=`${bottoms[column]}px`;
    bottoms[column]=bottoms[column]!+heights[i]!+gap;
   });
   body.style.height=`${Math.max(0,Math.max(...bottoms)-gap)}px`;
   body.dataset.ready='true';
  };
  const schedule=()=>{if(frame!==null)return;frame=requestAnimationFrame(()=>{frame=null;layout();});};
  const observer=new ResizeObserver(schedule);
  observer.observe(element);observer.observe(body);slots.forEach(slot=>observer.observe(slot));
  layout();
  return()=>{disposed=true;observer.disconnect();if(frame!==null)cancelAnimationFrame(frame);};
 },[children]);
 return <div {...props} ref={host}><div className="masonry-surface" ref={surface}>{children}</div></div>;
}
