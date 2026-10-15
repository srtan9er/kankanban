export type ImageBounds={left:number;top:number;right:number;bottom:number};
/** Visible window region, independent of the document's scrolling coordinates. */
export function bodyViewport(element:HTMLElement):ImageBounds|null{
 const pane=element.closest<HTMLElement>('.canvas-viewport,.preview,.ordinary-content,.document-region,.ordinary-document,.card-body-region') ?? element;
 const rect=pane.getBoundingClientRect();if(rect.width<=0 || rect.height<=0)return null;
 const clip={left:Math.max(0,rect.left+pane.clientLeft),top:Math.max(0,rect.top+pane.clientTop),right:Math.min(window.innerWidth,rect.left+pane.clientLeft+(pane.clientWidth || rect.width)),bottom:Math.min(window.innerHeight,rect.top+pane.clientTop+(pane.clientHeight || rect.height))};
 for(let parent=pane.parentElement;parent;parent=parent.parentElement){
  const style=getComputedStyle(parent);if(!/auto|scroll|hidden|clip/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`) && !parent.matches('.proto-note,.manager-shell'))continue;
  const box=parent.getBoundingClientRect();if(box.width<=0 || box.height<=0)continue;
  clip.left=Math.max(clip.left,box.left+parent.clientLeft);clip.top=Math.max(clip.top,box.top+parent.clientTop);
  clip.right=Math.min(clip.right,box.left+parent.clientLeft+(parent.clientWidth || box.width));clip.bottom=Math.min(clip.bottom,box.top+parent.clientTop+(parent.clientHeight || box.height));
 }
 return clip.right-clip.left>=8 && clip.bottom-clip.top>=8?clip:null;
}
/** Scroll coordinates are relative to the body; clipping limits stay at the visible card. */
export function imageBounds(element:HTMLElement):ImageBounds|null{
 const root=element.getBoundingClientRect(),clip=bodyViewport(element);if(!clip)return null;
 return {left:clip.left-root.left,top:clip.top-root.top,right:clip.right-root.left,bottom:clip.bottom-root.top};
}
export function boundedImage(bounds:ImageBounds,size:{width:number;height:number},position:{x:number;y:number}){
 const scale=Math.min(1,(bounds.right-bounds.left)/size.width,(bounds.bottom-bounds.top)/size.height);
 const width=Math.max(8,Math.min(bounds.right-bounds.left,size.width*scale)),height=Math.max(8,Math.min(bounds.bottom-bounds.top,size.height*scale));
 return {width,height,x:Math.max(bounds.left,Math.min(bounds.right-width,position.x)),y:Math.max(bounds.top,Math.min(bounds.bottom-height,position.y))};
}
