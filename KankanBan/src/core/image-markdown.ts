import {parseTables} from './table-markdown.ts';
import {imageNames} from './image-identity.ts';
import type {CardImage} from './card-images.ts';
import {uiText} from '../i18n/text.ts';
export type ImageLayout='inline'|'float'|'overlay'|'underlay';
export type ImagePlacement={layout:ImageLayout;width?:number;height?:number;x?:number;y?:number;layer?:number};
export type MarkdownImage=ImagePlacement & {start:number;end:number;alt:string;name?:string;assetId:string;image?:CardImage;syntax:'markdown'|'image'};
export type ImageMarkdownToken=ImagePlacement & {start:number;end:number;alt:string;name?:string;path:string;syntax:'markdown'|'image'};
const assetPath=/^\.\.\/assets\/images\/([a-f0-9]{64}\.(?:png|jpg|webp|gif))$/;
const unescape=(text:string)=>text.replace(/\\([^\w\s])/g,'$1');
const layouts:ReadonlySet<string>=new Set(['inline','float','overlay','underlay']);
const tagAttributes=new Set(['src','layout','width','height','x','y','alt','name','layer']);
const numericKeys=['width','height','x','y','layer'] as const;
const validName=(name:string)=>/^image_(0|[1-9]\d*)$/.test(name) && Number.isSafeInteger(Number(name.slice(6)));
const decode=(text:string)=>text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[a-f0-9]+);/gi,entity=>{
 const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
 if(Object.hasOwn(named,entity))return named[entity]!;
 if(!entity.startsWith('&#'))return entity;
 const hex=entity[2]?.toLowerCase()==='x',point=parseInt(entity.slice(hex?3:2,-1),hex?16:10);
 return Number.isSafeInteger(point) && point>0 && point<=0x10ffff && !(point>=0xd800 && point<=0xdfff)?String.fromCodePoint(point):entity;
});
const escape=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function validPlacement(value:ImagePlacement):boolean {
 if(!layouts.has(value.layout))return false;
 return numericKeys.every(key=>value[key]===undefined || (typeof value[key]==='number' && Number.isFinite(value[key]) && (key==='width' || key==='height'?value[key]!>=8 && value[key]!<=16384:key==='layer'?Number.isSafeInteger(value[key]) && Math.abs(value[key]!)<=1e6:Math.abs(value[key]!)<=1e7)));
}
function controlledImageAt(text:string,start:number):{end:number;token?:ImageMarkdownToken} {
 const closing=text.indexOf('</image>',start+6),end=closing<0?text.length:closing+8;
 if(closing<0)return {end};
 const attrs=new Map<string,string>();let i=start+6;
 while(i<closing){
  const before=i;while(/\s/.test(text[i] ?? '') && i<closing)i++;
  if(text[i]==='>'){i++;break;}
  if(i===before || i>=closing)return {end};
  const match=/^([a-z]+)\s*=\s*(["'])/.exec(text.slice(i));
  if(!match || !tagAttributes.has(match[1]!) || attrs.has(match[1]!))return {end};
  i+=match[0].length;const from=i,quote=match[2]!;while(i<closing && text[i]!==quote)i++;
  if(i>=closing)return {end};const raw=text.slice(from,i);if(/[<>\u0000]/.test(raw))return {end};
  attrs.set(match[1]!,decode(raw));i++;
 }
 if(text[i-1]!=='>')return {end};
 const path=attrs.get('src');if(!path || !assetPath.test(path))return {end};
 const rawAlt=text.slice(i,closing);if(/[<>\u0000]/.test(rawAlt))return {end};
 // The former paragraph mode is a read-time alias; paragraph boundaries belong to the body.
 const storedLayout=attrs.get('layout') ?? 'inline';
 const placement:ImagePlacement={layout:(storedLayout==='block'?'inline':storedLayout) as ImageLayout};
 for(const key of numericKeys)if(attrs.has(key)){
  const value=attrs.get(key)!.trim();if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))return {end};
  placement[key]=Number(value);
 }
 const name=attrs.get('name');if(!validPlacement(placement) || (name!==undefined && !validName(name)))return {end};
 return {end,token:{start,end,alt:attrs.get('alt') ?? decode(rawAlt),...(name===undefined?{}:{name}),path,syntax:'image',...placement}};
}
function imageAt(text:string,start:number):ImageMarkdownToken|undefined {
 let i=start+2,depth=1;
 const altStart=i;
 for(;i<text.length;i++){
  if(text[i]==='\\'){i++;continue;}
  if(text[i]==='[')depth++;
  if(text[i]===']' && --depth===0)break;
 }
 if(i>=text.length || text[i+1]!=='(')return;
 const alt=unescape(text.slice(altStart,i));i+=2;
 while(/\s/.test(text[i] ?? '') && i<text.length)i++;
 let path='';
 if(text[i]==='<'){
  const from=++i;
  for(;i<text.length && text[i]!=='>';i++){if(text[i]==='\n' || text[i]==='<')return;if(text[i]==='\\')i++;}
  if(i>=text.length)return;path=unescape(text.slice(from,i));i++;
 }else{
  const from=i;let nesting=0;
  for(;i<text.length;i++){
   const char=text[i]!;
   if(char==='\\'){i++;continue;}
   if(char==='('){if(++nesting>32)return;continue;}
   if(char===')'){if(nesting===0)break;nesting--;continue;}
   if(/\s/.test(char)){if(nesting!==0)return;break;}
  }
  if(nesting!==0)return;path=unescape(text.slice(from,i));
 }
 const afterPath=i;while(/\s/.test(text[i] ?? '') && i<text.length)i++;
 if(i>afterPath && (text[i]==='"' || text[i]==="'" || text[i]==='(')){
  const closing=text[i]==='('?')':text[i]!;i++;
  for(;i<text.length && text[i]!==closing;i++){if(text[i]==='\\')i++;}
  if(i>=text.length)return;i++;while(/\s/.test(text[i] ?? '') && i<text.length)i++;
 }
 if(text[i]!==')')return;
 return {start,end:i+1,alt,path,syntax:'markdown',layout:'inline'};
}
/** Scan inline image syntax while preserving code and escaped text byte for byte. */
export function imageMarkdownTokens(text:string):ImageMarkdownToken[]{
 const result:ImageMarkdownToken[]=[];let fence:{char:string;length:number}|undefined;
 for(let i=0;i<text.length;){
  if(i===0 || text[i-1]==='\n'){
   const end=text.indexOf('\n',i),line=text.slice(i,end<0?text.length:end),match=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
   if(fence){if(match && match[1]![0]===fence.char && match[1]!.length>=fence.length && !match[2]!.trim())fence=undefined;i=end<0?text.length:end+1;continue;}
   if(match){fence={char:match[1]![0]!,length:match[1]!.length};i=end<0?text.length:end+1;continue;}
   if(/^(?: {4}|\t)/.test(line)){i=end<0?text.length:end+1;continue;}
  }
  if(text[i]==='\\'){i+=2;continue;}
  if(text[i]==='`'){
   let end=i+1;while(text[end]==='`')end++;const delimiter=text.slice(i,end);let close=text.indexOf(delimiter,end);
   while(close>=0 && (text[close-1]==='`' || text[close+delimiter.length]==='`'))close=text.indexOf(delimiter,close+delimiter.length);
   if(close>=0){i=close+delimiter.length;continue;}i=end;continue;
  }
  if(text.startsWith('<image',i) && /[\s>]/.test(text[i+6] ?? '')){const found=controlledImageAt(text,i);if(found.token)result.push(found.token);i=found.end;continue;}
  if(text[i]==='!' && text[i+1]==='['){const found=imageAt(text,i);if(found){result.push(found);i=found.end;continue;}}
  i++;
 }
 return result;
}
/** Local workspace assets only. Repeated references stay repeated; metadata is an index. */
export function parseCardImages(content:string,metadata:readonly CardImage[]=[]):MarkdownImage[]{
 const byAsset=new Map(metadata.map(image=>[image.assetId,image]));
 return imageMarkdownTokens(content).flatMap(token=>{
  const match=assetPath.exec(token.path);if(!match)return [];
  const assetId=match[1]!,image=byAsset.get(assetId);
  const {path:_,...reference}=token;return [{...reference,assetId,...(image?{image}: {})}];
 });
}
function replaceImages(content:string,replacement:string):{text:string;count:number}{
 const tokens=imageMarkdownTokens(content);let from=0,text='';
 for(const token of tokens){text+=content.slice(from,token.start)+replacement;from=token.end;}
 return {text:text+content.slice(from),count:tokens.length};
}
export function imageOnly(content:string):boolean {const stripped=replaceImages(content,'');return stripped.count>0 && !stripped.text.trim();}
export function mixedPreview(content:string):string{
 const tables=parseTables(content),images=imageMarkdownTokens(content),names=imageNames(images.map(image=>({...image,assetId:''}))),tokens=[...images.map((image,i)=>({...image,label:`<${names[i]}>`})).filter(image=>!tables.some(table=>image.start>=table.start && image.end<=table.end)),...tables.map(table=>({...table,label:`<${table.name}>`}))].sort((a,b)=>a.start-b.start);let from=0,value='';
 for(const token of tokens){value+=content.slice(from,token.start)+token.label;from=token.end;}return value+content.slice(from);
}
export function markdownForImage(image:CardImage):string {const alt=image.name.replace(/[\\[\]]/g,'\\$&');return `![${alt}](../assets/images/${image.assetId})`;}
/** New imports are atomic editor fields immediately, before any layout edits. */
export function imageTagForImage(image:CardImage,name?:string):string {
 return serializeImage({start:0,end:0,assetId:image.assetId,alt:image.name,layout:'inline',syntax:'image',...(name===undefined?{}:{name})});
}
/** Serialize only controlled attributes. Never retain arbitrary HTML from a source token. */
export function serializeImage(reference:MarkdownImage,changes:Partial<ImagePlacement>&{alt?:string;name?:string}={}):string {
 const placement:ImagePlacement={layout:changes.layout ?? reference.layout};
 for(const key of numericKeys){const value=changes[key] ?? reference[key];if(value!==undefined)placement[key]=value;}
 const alt=changes.alt ?? reference.alt,path=`../assets/images/${reference.assetId}`;
 if(!assetPath.test(path) || !validPlacement(placement) || typeof alt!=='string' || alt.length>65536 || alt.includes('\u0000'))throw new Error(uiText('images.invalid'));
 const name=changes.name ?? reference.name;if(name!==undefined && !validName(name))throw new Error(uiText('images.invalid'));
 const attrs=[`src="${escape(path)}"`,`layout="${escape(placement.layout)}"`,...(name===undefined?[]:[`name="${escape(name)}"`]),...numericKeys.filter(key=>placement[key]!==undefined).map(key=>`${key}="${placement[key]}"`)];
 return `<image ${attrs.join(' ')}>${escape(alt)}</image>`;
}
