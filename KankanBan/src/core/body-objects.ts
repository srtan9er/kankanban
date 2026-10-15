import {parseCardImages,serializeImage,type MarkdownImage,type ImagePlacement} from './image-markdown.ts';
import {imageNames} from './image-identity.ts';
import {parseTables,serializeTable,type BodyTable,type TableData} from './table-markdown.ts';
import type {CardImage} from './types.ts';
import {imageStack,imageLayerActions} from './image-layers.ts';
export type BodyObject=MarkdownImage & {table?:BodyTable;displayName:string};
export function parseBodyObjects(text:string,images:readonly CardImage[]=[]):BodyObject[]{
 const tables=parseTables(text),pictures=parseCardImages(text,images),names=imageNames(pictures);
 return [...pictures.flatMap((picture,i)=>tables.some(table=>picture.start>=table.start && picture.end<=table.end)?[]:[{...picture,displayName:names[i]!}]),...tables.map(table=>({start:table.start,end:table.end,assetId:table.name,alt:table.name,name:table.name,displayName:table.name,syntax:'image' as const,layout:table.layout,width:table.data.columns.reduce((a,b)=>a+b,0),height:table.data.rows.reduce((a,b)=>a+b,0),...(table.x===undefined?{}:{x:table.x}),...(table.y===undefined?{}:{y:table.y}),...(table.layer===undefined?{}:{layer:table.layer}),table}))].sort((a,b)=>a.start-b.start);
}
export function serializeBodyObject(object:BodyObject,changes:Partial<ImagePlacement>&{name?:string;data?:TableData}={}):string{return object.table?serializeTable(object.table,changes):serializeImage(object,changes);}
export {imageStack as objectStack,imageLayerActions as objectLayerActions};
export function shiftBodyLayer(text:string,index:number,direction:'up'|'down'):string{
 const objects=parseBodyObjects(text),object=objects[index];if(!object)return text;
 const order=objects.map((_,i)=>i).filter(i=>(objects[i]!.layout==='underlay')===(object.layout==='underlay')).sort((a,b)=>(objects[a]!.layer ?? a)-(objects[b]!.layer ?? b) || a-b),rank=order.indexOf(index),target=rank+(direction==='up'?1:-1);if(target<0 || target>=order.length)return text;
 [order[rank],order[target]]=[order[target]!,order[rank]!];const layers=new Map(order.map((i,rank)=>[i,rank]));let from=0,value='';
 for(const [i,item] of objects.entries()){const layer=layers.get(i);if(layer===undefined)continue;value+=text.slice(from,item.start)+serializeBodyObject(item,{layer});from=item.end;}
 return value+text.slice(from);
}
