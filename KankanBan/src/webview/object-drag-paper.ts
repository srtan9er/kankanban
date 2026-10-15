type Point={clientX:number;clientY:number};
type Box={x:number;y:number;width:number;height:number};
const EDGE_ZONE=32;
const EDGE_ACCELERATION=600,MAX_SCROLL_SPEED=900;
export function edgeScrollVelocity(point:Point,rect:{left:number;top:number;right:number;bottom:number},seconds:number){
 const demand=(position:number,start:number,end:number)=>position>end-EDGE_ZONE?(position-end+EDGE_ZONE)*24:position<start+EDGE_ZONE?-(start+EDGE_ZONE-position)*24:0;
 const x=demand(point.clientX,rect.left,rect.right),y=demand(point.clientY,rect.top,rect.bottom),length=Math.hypot(x,y),maximum=Math.min(MAX_SCROLL_SPEED,EDGE_ACCELERATION*Math.sqrt(Math.max(0,seconds)));
 if(!length || !maximum)return {x:0,y:0};const scale=Math.min(1,maximum/length);return {x:x*scale,y:y*scale};
}
/** Temporary overflow space does not change the text width or the drawing origin. */
export function objectDragPaper(root:HTMLElement,onScroll:()=>void){
 const candidates='.preview,.ordinary-content,.document-region,.table-cell-content';
 let pane=root.closest<HTMLElement>(candidates) ?? root;
 for(let element:HTMLElement|null=pane;element;element=element.parentElement){
  const style=getComputedStyle(element);
  if(/auto|scroll/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)){pane=element;break;}
 }
 const spacer=document.createElement('div');spacer.dataset.objectDragPaper='true';spacer.setAttribute('aria-hidden','true');
 Object.assign(spacer.style,{position:'absolute',left:'0px',top:'0px',width:'0px',height:'0px',pointerEvents:'none'});root.append(spacer);
 let point:Point|null=null,frame:number|null=null,closed=false,width=0,height=0,lastTime:number|null=null,edgeStarted:number|null=null;
 const scrolled=()=>{if(!closed)onScroll();};pane.addEventListener('scroll',scrolled);
 const grow=(box?:Box)=>{
  const origin=root.getBoundingClientRect(),viewport=pane.getBoundingClientRect();
  if(!point || viewport.width<=0 || viewport.height<=0)return;
  const right=viewport.left+pane.clientLeft+(pane.clientWidth || viewport.width),bottom=viewport.top+pane.clientTop+(pane.clientHeight || viewport.height);
  if(point.clientX>right-EDGE_ZONE)width=Math.max(width,root.clientWidth,box?box.x+box.width+Math.max(100,viewport.width):0,right-origin.left+Math.max(100,viewport.width));
  if(point.clientY>bottom-EDGE_ZONE)height=Math.max(height,root.clientHeight,box?box.y+box.height+Math.max(100,viewport.height):0,bottom-origin.top+Math.max(100,viewport.height));
  spacer.style.width=`${width}px`;spacer.style.height=`${height}px`;
 };
 const visible=()=>{const rect=pane.getBoundingClientRect();return {left:rect.left+pane.clientLeft,top:rect.top+pane.clientTop,right:rect.left+pane.clientLeft+(pane.clientWidth || rect.width),bottom:rect.top+pane.clientTop+(pane.clientHeight || rect.height)};};
 const tick=(time:number)=>{
  frame=null;if(closed || !point || pane.clientWidth<=0 || pane.clientHeight<=0)return;
  const rect=visible(),active=edgeScrollVelocity(point,rect,1);
  if(!active.x && !active.y){lastTime=null;edgeStarted=null;return;}grow();
  edgeStarted ??= time;const {x:dx,y:dy}=edgeScrollVelocity(point,rect,(time-edgeStarted)/1000);
  const elapsed=lastTime===null?1/60:Math.min(.04,Math.max(0,(time-lastTime)/1000));lastTime=time;
  const x=pane.scrollLeft,y=pane.scrollTop;pane.scrollLeft=Math.max(0,x+dx*elapsed);pane.scrollTop=Math.max(0,y+dy*elapsed);
  if(pane.scrollLeft!==x || pane.scrollTop!==y)onScroll();
  if(!closed && frame===null)frame=requestAnimationFrame(tick);
 };
 return {
  update:(next:Point,box?:Box)=>{if(closed)return;point=next;const demand=edgeScrollVelocity(point,visible(),1);if(!demand.x && !demand.y){edgeStarted=null;lastTime=null;}grow(box);if(frame===null)frame=requestAnimationFrame(tick);},
  stop:()=>{closed=true;if(frame!==null)cancelAnimationFrame(frame);pane.removeEventListener('scroll',scrolled);spacer.remove();},
 };
}
