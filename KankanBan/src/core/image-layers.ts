import {parseCardImages,serializeImage,type MarkdownImage} from './image-markdown.ts';
import {imageNames} from './image-identity.ts';
const behind=(reference:MarkdownImage)=>reference.layout==='underlay';
function band(references:readonly MarkdownImage[],underlay:boolean):number[]{
 return references.map((_,index)=>index).filter(index=>behind(references[index]!)===underlay).sort((a,b)=>(references[a]!.layer ?? a)-(references[b]!.layer ?? b) || a-b);
}
/** Each text-side band has its own order; an underlay never crosses the text. */
export function imageStack(references:readonly MarkdownImage[]):number[]{
 const values=references.map(()=>0);
 for(const underlay of [true,false]){const order=band(references,underlay);order.forEach((index,rank)=>{values[index]=underlay?rank-order.length+1:rank+2;});}
 return values;
}
export function imageLayerActions(references:readonly MarkdownImage[],index:number):{up:boolean;down:boolean}{
 const reference=references[index];if(!reference)return {up:false,down:false};const order=band(references,behind(reference)),rank=order.indexOf(index);return {up:rank<order.length-1,down:rank>0};
}
export function shiftImageLayer(content:string,index:number,direction:'up'|'down'):string{
 const references=parseCardImages(content),reference=references[index];if(!reference)return content;
 const order=band(references,behind(reference)),rank=order.indexOf(index),target=rank+(direction==='up'?1:-1);if(target<0 || target>=order.length)return content;
 [order[rank],order[target]]=[order[target]!,order[rank]!];const ranks=new Map(order.map((value,position)=>[value,position])),names=imageNames(references);let from=0,value='';
 references.forEach((item,position)=>{const layer=ranks.get(position);if(layer===undefined)return;value+=content.slice(from,item.start)+serializeImage(item,{layer,name:names[position]!});from=item.end;});
 return value+content.slice(from);
}
