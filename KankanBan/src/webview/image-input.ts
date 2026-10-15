import type {CardImage} from '../core/types.ts';
import {uiText} from '../i18n/text.ts';
import {parseCardImages,imageMarkdownTokens,imageOnly as onlyImages,mixedPreview} from '../core/image-markdown.ts';
import {imageNames} from '../core/image-identity.ts';
export type ImageImportInput={name:string;base64?:string;path?:string};
export function cardImagePreview(card:{content:string;images?:CardImage[]}) {
 const images=parseCardImages(card.content,card.images ?? []).map((reference,index)=>reference.image?{...reference.image,name:reference.alt || reference.image.name}:{id:`asset-${index}`,assetId:reference.assetId,name:reference.alt,mime:reference.assetId.endsWith('.jpg')?'image/jpeg':reference.assetId.endsWith('.webp')?'image/webp':reference.assetId.endsWith('.gif')?'image/gif':'image/png',width:1,height:1} as CardImage),imageOnly=images.length>0 && images.length===imageMarkdownTokens(card.content).length && onlyImages(card.content);
 return {images,names:imageNames(parseCardImages(card.content)),imageOnly,text:imageOnly?'':mixedPreview(card.content)};
}
export function imageRequestSummary(request:{kind:'images-import';id:string;inputs:ImageImportInput[]}) {
 return {kind:request.kind,id:request.id,images:request.inputs.map(input=>input.name)};
}
export async function imageFileInputs(files:File[]):Promise<ImageImportInput[]> {
 if(files.length>64 || files.some(file=>!Number.isSafeInteger(file.size) || file.size<0 || file.size>20*1024*1024) || files.reduce((size,file)=>size+file.size,0)>150*1024*1024)throw new Error(uiText('images.tooLarge'));
 if(files.some(file=>!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type) && !(file.type==='' && /\.(png|jpe?g|webp|gif)$/i.test(file.name))))throw new Error(uiText('images.unsupported'));
 const result:ImageImportInput[]=[];
 for(const file of files)result.push(await new Promise<ImageImportInput>((resolve,reject)=>{
  const reader=new FileReader();reader.onerror=()=>reject(new Error(uiText('images.failed')));reader.onload=()=>resolve({name:file.name,base64:String(reader.result).split(',')[1]!});reader.readAsDataURL(file);
 }));
 return result;
}
