import {parseCardImages,serializeImage,type MarkdownImage} from './image-markdown.ts';
import {uiText} from '../i18n/text.ts';

/** Names identify body occurrences, not deduplicated asset files. */
export function imageNames(references:readonly MarkdownImage[]):string[]{
 const reserved=new Set(references.flatMap(reference=>reference.name?[reference.name]:[])),used=new Set<string>();let next=0;
 return references.map(reference=>{
  if(reference.name && !used.has(reference.name)){used.add(reference.name);return reference.name;}
  while(reserved.has(`image_${next}`) || used.has(`image_${next}`))next++;
  const name=`image_${next++}`;used.add(name);return name;
 });
}
export function nextImageNumber(content:string):number{
 const names=imageNames(parseCardImages(content));const next=Math.max(-1,...names.map(name=>Number(name.slice(6))))+1;
 if(!Number.isSafeInteger(next))throw new Error(uiText('images.invalid'));return next;
}
/** Only a real save materializes names; reading old cards never writes operations. */
export function ensureImageNames(content:string,before=content):string{
 const previous=parseCardImages(before),oldNames=imageNames(previous),references=parseCardImages(content);
 const byToken=new Map<string,string[]>();previous.forEach((reference,index)=>{const token=before.slice(reference.start,reference.end),names=byToken.get(token) ?? [];names.push(oldNames[index]!);byToken.set(token,names);});
 const reserved=new Set(references.flatMap(reference=>reference.name?[reference.name]:[])),used=new Set<string>();
 let next=Math.max(nextImageNumber(before),0,...references.flatMap(reference=>reference.name?[Number(reference.name.slice(6))+1]:[])),from=0,value='';
 for(const reference of references){
  const token=content.slice(reference.start,reference.end),matched=byToken.get(token)?.shift();
  let name=reference.name;
  if(!name && matched && !used.has(matched) && !reserved.has(matched))name=matched;
  if(!name || used.has(name)){while(reserved.has(`image_${next}`) || used.has(`image_${next}`))next++;if(!Number.isSafeInteger(next))throw new Error(uiText('images.invalid'));name=`image_${next++}`;}
  used.add(name);value+=content.slice(from,reference.start)+(reference.name===name?token:serializeImage(reference,{name}));from=reference.end;
 }
 return value+content.slice(from);
}
/** A copied atom receives a new name when its old name is already in the target card. */
export function nameInsertedImages(inserted:string,surrounding:string):string{
 const references=parseCardImages(inserted),used=new Set(imageNames(parseCardImages(surrounding)));let next=Math.max(nextImageNumber(surrounding),0,...references.flatMap(reference=>reference.name?[Number(reference.name.slice(6))+1]:[])),from=0,value='';
 for(const reference of references){if(reference.syntax!=='image')continue;let name=reference.name;
  if(!name || used.has(name)){while(used.has(`image_${next}`))next++;if(!Number.isSafeInteger(next))throw new Error(uiText('images.invalid'));name=`image_${next++}`;}
  used.add(name);value+=inserted.slice(from,reference.start)+(reference.name===name?inserted.slice(reference.start,reference.end):serializeImage(reference,{name}));from=reference.end;
 }
 return value+inserted.slice(from);
}
