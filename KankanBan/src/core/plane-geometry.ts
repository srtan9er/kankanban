import {uiText} from '../i18n/text.ts';
import type {PlaneEntry} from './types.ts';
import {CARD_MIN_WIDTH,CARD_MIN_HEIGHT} from './layout-metrics.ts';
export type Point = {x:number;y:number};
export type PlaneSize = {width:number;height:number};
export function planePeriod(entries:readonly PlaneEntry[], viewport:PlaneSize):PlaneSize {
  const cardWidth=Math.max(CARD_MIN_WIDTH,...entries.map(e=>e.w));
  const cardHeight=Math.max(CARD_MIN_HEIGHT,...entries.map(e=>e.h));
  return {width:Math.max(1,viewport.width,...entries.map(e=>e.x+Math.max(CARD_MIN_WIDTH,e.w)))+cardWidth,
    height:Math.max(1,viewport.height,...entries.map(e=>e.y+Math.max(CARD_MIN_HEIGHT,e.h)))+cardHeight};
}
export function rebasePlane(entries:readonly PlaneEntry[],id:string,point:Point,size:PlaneSize) {
  if(![point.x,point.y,size.width,size.height].every(Number.isFinite)) throw new Error(uiText("core/plane-geometry.text001"));
  const existing=entries.find(e=>e.id===id);
  const moving:PlaneEntry={id,x:point.x,y:point.y,w:existing?.w ?? Math.max(CARD_MIN_WIDTH,size.width),
    h:existing?.h ?? Math.max(CARD_MIN_HEIGHT,size.height),z:existing?.z ?? entries.length};
  const free=nearestPlanePosition(entries,id,point,{width:moving.w,height:moving.h});
  moving.x=free.x;moving.y=free.y;
  const raw=existing ? entries.map(e=>e.id===id?moving:e) : [...entries,moving];
  const shift={x:Math.max(0,...raw.map(e=>-e.x)),y:Math.max(0,...raw.map(e=>-e.y))};
  return {shift,entries:raw.map(e=>({...e,x:e.x+shift.x,y:e.y+shift.y}))};
}
export const positiveModulo=(value:number,period:number):number=>((value%period)+period)%period;

// Select the nearest free rectangle among obstacle edges, including corner gaps.
export function nearestPlanePosition(entries:readonly PlaneEntry[],id:string,point:Point,size:PlaneSize):Point {
 const gap=8, others=entries.filter(e=>e.id!==id);
 const width=Math.max(CARD_MIN_WIDTH,size.width),height=Math.max(CARD_MIN_HEIGHT,size.height);
 const clear=(p:Point)=>others.every(e=>p.x+width+gap<=e.x || p.x>=e.x+Math.max(CARD_MIN_WIDTH,e.w)+gap || p.y+height+gap<=e.y || p.y>=e.y+Math.max(CARD_MIN_HEIGHT,e.h)+gap);
 if(clear(point))return point;
 const xs=[point.x,...others.flatMap(e=>[e.x-width-gap,e.x+Math.max(CARD_MIN_WIDTH,e.w)+gap])];
 const ys=[point.y,...others.flatMap(e=>[e.y-height-gap,e.y+Math.max(CARD_MIN_HEIGHT,e.h)+gap])];
 let best=point,distance=Infinity;
 for(const x of xs)for(const y of ys){const d=(x-point.x)**2+(y-point.y)**2;if(d<distance && clear({x,y})){best={x,y};distance=d;}}
 return best;
}

/** Keep the currently visible replica at exactly the same viewport coordinates.
 * A partly clipped replica may legitimately keep a negative coordinate.
 */
export function viewportPlane(entries:readonly PlaneEntry[],offset:Point,scale:number,period:PlaneSize,viewport:PlaneSize,minimum:PlaneSize={width:CARD_MIN_WIDTH,height:CARD_MIN_HEIGHT}):PlaneEntry[] {
 const visibleAxis=(position:number,size:number,span:number,extent:number):number=>{
  const wrapped=positiveModulo(position,span);
  let best=wrapped,coverage=0;
  const first=Math.floor((-wrapped-size)/span)+1,last=Math.ceil((extent-wrapped)/span)-1;
  for(let k=first;k<=last;k++) {
   const candidate=wrapped+k*span;
   const visible=Math.max(0,Math.min(extent,candidate+size)-Math.max(0,candidate));
   if(visible>coverage){best=candidate;coverage=visible;}
  }
  return best;
 };
 return entries.map(e=>({...e,
  x:visibleAxis(e.x+offset.x/scale,Math.max(minimum.width,e.w),period.width,viewport.width),
  y:visibleAxis(e.y+offset.y/scale,Math.max(minimum.height,e.h),period.height,viewport.height)}));
}
