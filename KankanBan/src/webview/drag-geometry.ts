/** Reserve the perimeter for window alignment; nesting is an interior hit. */
export function insideMergeArea(rect: { left: number; top: number; right: number; bottom: number }, x: number, y: number): boolean {
  const inset = Math.min(12, (rect.right - rect.left) / 4, (rect.bottom - rect.top) / 4);
  return x >= rect.left + inset && x <= rect.right - inset && y >= rect.top + inset && y <= rect.bottom - inset;
}

export function onScrollbar(element: HTMLElement, x: number, y: number): boolean {
  for(let current:HTMLElement|null=element;current;current=current.parentElement){
    if(current.clientWidth<=0 || current.clientHeight<=0)continue;
    const style=getComputedStyle(current),rect=current.getBoundingClientRect();
    const left=rect.left+current.clientLeft,top=rect.top+current.clientTop;
    const vertical=/^(auto|scroll)$/.test(style.overflowY || style.overflow) && current.scrollHeight>current.clientHeight && current.offsetWidth-current.clientWidth-current.clientLeft>6;
    const horizontal=/^(auto|scroll)$/.test(style.overflowX || style.overflow) && current.scrollWidth>current.clientWidth && current.offsetHeight-current.clientHeight-current.clientTop>6;
    if(x>=rect.left && x<=rect.right && y>=rect.top && y<=rect.bottom && ((vertical && x>=left+current.clientWidth) || (horizontal && y>=top+current.clientHeight)))return true;
  }
  return false;
}


/** A translated surface already includes the pan in its rect; viewport gaps do not. */
export function dropPosition(element: HTMLElement, x: number, y: number): {x:number;y:number} {
  const rect=element.getBoundingClientRect();
  const panX=Number(element.dataset.canvasPanX ?? 0), panY=Number(element.dataset.canvasPanY ?? 0);
  return {x:Math.max(0,x-rect.left+element.scrollLeft-panX),y:Math.max(0,y-rect.top+element.scrollTop-panY)};
}
