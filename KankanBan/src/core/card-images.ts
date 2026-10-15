import {uiText} from '../i18n/text.ts';
/** Immutable file references; bytes are stored and verified by the platform layer. */
export type CardImage = {
 id:string;
 assetId:string;
 name:string;
 mime:'image/png'|'image/jpeg'|'image/webp'|'image/gif';
 width:number;
 height:number;
};
export const MAX_CARD_IMAGES=64;
export const MAX_IMAGE_DIMENSION=16384;
const keys=['id','assetId','name','mime','width','height'] as const;
const extension:Readonly<Record<CardImage['mime'],string>>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'};
export function validCardImages(value:unknown):value is CardImage[] {
 if(!Array.isArray(value) || value.length>MAX_CARD_IMAGES)return false;
 if(Object.keys(value).length!==value.length)return false;
 const ids=new Set<string>();
 return value.every(item=>{
  if(!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).length!==keys.length || !keys.every(key=>Object.hasOwn(item,key)))return false;
  const image=item as CardImage;
  if(typeof image.id!=='string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(image.id) || ids.has(image.id))return false;
  ids.add(image.id);
  if(typeof image.mime!=='string' || !Object.hasOwn(extension,image.mime) || typeof image.assetId!=='string' || !new RegExp(`^[a-f0-9]{64}\\.${extension[image.mime]}$`).test(image.assetId))return false;
  if(!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width<1 || image.height<1 || image.width>MAX_IMAGE_DIMENSION || image.height>MAX_IMAGE_DIMENSION)return false;
  return typeof image.name==='string' && image.name.length<=512 && !/[\u0000-\u001f]/.test(image.name);
 });
}
export function copyCardImages(images:readonly CardImage[]):CardImage[]{return images.map(image=>({id:image.id,assetId:image.assetId,name:image.name,mime:image.mime,width:image.width,height:image.height}));}
/** Only stored data may contain the two retired fields. New mutations stay strict. */
export function readCardImages(value:unknown):CardImage[]{
 if(!Array.isArray(value) || value.length>MAX_CARD_IMAGES || Object.keys(value).length!==value.length || value.some(item=>!item || typeof item!=='object' || Array.isArray(item) || !keys.every(key=>Object.hasOwn(item,key)) || Object.keys(item).some(key=>!(keys as readonly string[]).includes(key) && key!=='sourceUrl' && key!=='sourceNote')))throw new Error(uiText('images.invalid'));
 const images=copyCardImages(value as CardImage[]);if(!validCardImages(images))throw new Error(uiText('images.invalid'));return images;
}
/** Missing legacy collections and empty collections describe the same card. */
export function sameCardImages(left:readonly CardImage[]|undefined,right:readonly CardImage[]|undefined):boolean {
 const a=left ?? [],b=right ?? [];return a.length===b.length && a.every((image,index)=>keys.every(key=>image[key]===b[index]![key]));
}
