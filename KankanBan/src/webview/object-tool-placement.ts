type Rect={left:number;top:number;right:number;bottom:number};
export function objectToolPlacement(object:Rect,tools:{width:number;height:number},clip:{left:number;right:number;top?:number;bottom?:number},gap=8):{side:'right'|'below';left:number;top:number}{
 const right=object.right+gap+tools.width<=clip.right;
 const left=Math.max(clip.left,Math.min(right?object.right+gap:object.left,clip.right-tools.width)),desired=right?object.top:object.bottom+gap;
 const top=clip.top!==undefined && clip.bottom!==undefined?Math.max(clip.top,Math.min(desired,clip.bottom-tools.height)):desired;
 return {side:right?'right':'below',left,top};
}
