export type OrderedDrop={element:HTMLElement;gap:number;marker:{left:number;top:number;width:number;height:number}};
/** Native drops use the same axis-based middle half as browser drops. */
export function listNestingTarget(hit:Element|null,x:number,y:number):HTMLElement|null {
 const list=hit?.closest<HTMLElement>('.horizontal-card-list,.vertical-card-list,.column-cards,.masonry-grid');
 const card=hit?.closest<HTMLElement>('[data-card-id][data-drop-parent]'),slot=card?.closest<HTMLElement>('.card-slot');
 if(!list?.hasAttribute('data-drop-parent') || !card || !slot)return null;
 const viewport=list.getBoundingClientRect(),r=slot.getBoundingClientRect();
 if(x<viewport.left || x>viewport.right || y<viewport.top || y>viewport.bottom || x<r.left || x>r.right || y<r.top || y>r.bottom)return null;
 const fraction=list.classList.contains('horizontal-card-list')?(x-r.left)/Math.max(1,r.width):(y-r.top)/Math.max(1,r.height);
 return fraction>.25 && fraction<.75?card:null;
}
/** Both drag handles use the middle half for nesting and the outer quarters for sorting. */
export function orderedDrop(hit:Element|null,x:number,y:number,_relationship?:boolean):OrderedDrop|null {
 const list=hit?.closest<HTMLElement>('.horizontal-card-list,.vertical-card-list,.column-cards,.masonry-grid');if(!list || !list.hasAttribute('data-drop-parent'))return null;
 const horizontal=list.classList.contains('horizontal-card-list'),rect=list.getBoundingClientRect();
 if(x<rect.left || x>rect.right || y<rect.top || y>rect.bottom)return null;
 const masonry=list.classList.contains('masonry-grid');
 const slots=[...list.querySelectorAll<HTMLElement>(masonry?':scope > .masonry-surface > .card-slot':':scope > .card-slot')];
 const at=horizontal?x:y;
 const cards=slots.map(slot=>({slot,rect:slot.getBoundingClientRect(),index:Number(slot.querySelector<HTMLElement>('.insertion-zone')?.dataset.dropIndex ?? 0)}));
 const hovered=cards.find(card=>x>=card.rect.left && x<=card.rect.right && y>=card.rect.top && y<=card.rect.bottom);
 if(hovered){const start=horizontal?hovered.rect.left:hovered.rect.top,end=horizontal?hovered.rect.right:hovered.rect.bottom,fraction=(at-start)/Math.max(1,end-start);if(fraction>.25 && fraction<.75)return null;}
 if(masonry && cards.length){
  const nearest=hovered ?? cards.reduce((a,b)=>{
   const distance=(r:DOMRect)=>Math.hypot(Math.max(r.left-x,0,x-r.right),Math.max(r.top-y,0,y-r.bottom));
   return distance(a.rect)<=distance(b.rect)?a:b;
  });
  const before=y<(nearest.rect.top+nearest.rect.bottom)/2;
  return {element:list,gap:nearest.index+(before?0:1),marker:{left:nearest.rect.left-rect.left+list.scrollLeft,top:(before?nearest.rect.top:nearest.rect.bottom)-rect.top+list.scrollTop-1,width:nearest.rect.width,height:2}};
 }
 if(hovered){
  const before=at<(horizontal?(hovered.rect.left+hovered.rect.right)/2:(hovered.rect.top+hovered.rect.bottom)/2);
  const boundary=horizontal?(before?hovered.rect.left:hovered.rect.right):(before?hovered.rect.top:hovered.rect.bottom);
  const marker=horizontal?{left:boundary-rect.left+list.scrollLeft-1,top:Math.max(0,list.scrollTop+4),width:2,height:Math.max(12,list.clientHeight-8)}:{left:Math.max(0,list.scrollLeft+4),top:boundary-rect.top+list.scrollTop-1,width:Math.max(12,list.clientWidth-8),height:2};
  return {element:list,gap:hovered.index+(before?0:1),marker};
 }
 const next=cards.find(card=>at<(horizontal?(card.rect.left+card.rect.right)/2:(card.rect.top+card.rect.bottom)/2));
 const last=cards.at(-1);
 const gap=next?next.index:last?last.index+1:Number(list.dataset.dropIndex ?? 0);
 const boundary=next?(horizontal?next.rect.left:next.rect.top):last?(horizontal?last.rect.right:last.rect.bottom):(horizontal?rect.left:rect.top);
 const marker=horizontal?{left:boundary-rect.left+list.scrollLeft-1,top:Math.max(0,list.scrollTop+4),width:2,height:Math.max(12,list.clientHeight-8)}:{left:Math.max(0,list.scrollLeft+4),top:boundary-rect.top+list.scrollTop-1,width:Math.max(12,list.clientWidth-8),height:2};
 return {element:list,gap,marker};
}
export function showOrderedMarker(drop:OrderedDrop):HTMLElement {
 const marker=document.createElement('div');marker.className='child-sort-marker';marker.setAttribute('aria-hidden','true');
 Object.assign(marker.style,Object.fromEntries(Object.entries(drop.marker).map(([key,value])=>[key,`${value}px`])));drop.element.append(marker);return marker;
}
