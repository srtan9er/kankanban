/** Reserve the perimeter for window alignment; nesting is an interior hit. */
export function insideMergeArea(rect: { left: number; top: number; right: number; bottom: number }, x: number, y: number): boolean {
  const inset = Math.min(12, (rect.right - rect.left) / 4, (rect.bottom - rect.top) / 4);
  return x >= rect.left + inset && x <= rect.right - inset && y >= rect.top + inset && y <= rect.bottom - inset;
}

export function onScrollbar(element: HTMLElement, x: number, y: number): boolean {
  const rect = element.getBoundingClientRect();
  return (element.offsetWidth - element.clientWidth > 6 && x >= rect.left + element.clientWidth) ||
    (element.offsetHeight - element.clientHeight > 6 && y >= rect.top + element.clientHeight);
}


/** A translated surface already includes the pan in its rect; viewport gaps do not. */
export function dropPosition(element: HTMLElement, x: number, y: number): {x:number;y:number} {
  const rect=element.getBoundingClientRect();
  const panX=Number(element.dataset.canvasPanX ?? 0), panY=Number(element.dataset.canvasPanY ?? 0);
  return {x:Math.max(0,x-rect.left+element.scrollLeft-panX),y:Math.max(0,y-rect.top+element.scrollTop-panY)};
}
