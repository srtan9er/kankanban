export const DRAG_THRESHOLD=6;
export function passedDragThreshold(start:{clientX:number;clientY:number},point:{clientX:number;clientY:number}):boolean{return Math.hypot(point.clientX-start.clientX,point.clientY-start.clientY)>=DRAG_THRESHOLD;}
/** The release click belongs to the drag, never to a title/body editor underneath it. */
export function swallowDragClick():void{
 const swallow=(event:MouseEvent)=>{event.preventDefault();event.stopImmediatePropagation();};
 document.addEventListener('click',swallow,{capture:true,once:true});
 setTimeout(()=>document.removeEventListener('click',swallow,true),0);
}
