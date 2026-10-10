export type CanvasPick = {
 parent:string; tileX:number; tileY:number; periodWidth:number; periodHeight:number;
 grabX:number; grabY:number; width:number; height:number;
};
export type CanvasDrag = {id:string;x:number;y:number;phase:'move'|'drop'|'cancel'|'leave';pick?:CanvasPick};
export const CANVAS_DRAG_EVENT='kkb:canvas-drag';
export const CANVAS_WINDOW_SHIFT='kkb:canvas-window-shift';
export function canvasPick(target:HTMLElement,x:number,y:number):CanvasPick|undefined {
 const card=target.closest<HTMLElement>('.canvas-card'), viewport=card?.closest<HTMLElement>('.canvas-viewport');
 if(!card || !viewport) return undefined;
 const rect=card.getBoundingClientRect();
 const scale=Number(viewport.dataset.canvasZoom ?? 1) || 1;
 return {parent:viewport.dataset.dropParent ?? '',tileX:Number(card.dataset.tileX ?? 0),tileY:Number(card.dataset.tileY ?? 0),
  periodWidth:Number(viewport.dataset.canvasPeriodWidth ?? 1),periodHeight:Number(viewport.dataset.canvasPeriodHeight ?? 1),
  grabX:(x-rect.left)/scale,grabY:(y-rect.top)/scale,width:rect.width/scale,height:rect.height/scale};
}
export function dispatchCanvasDrag(element:HTMLElement,detail:CanvasDrag):boolean {
 const event=new CustomEvent(CANVAS_DRAG_EVENT,{detail,cancelable:true});
 element.dispatchEvent(event);return event.defaultPrevented;
}
