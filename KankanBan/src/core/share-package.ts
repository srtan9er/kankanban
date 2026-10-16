import {uiText,type TextKey} from '../i18n/text.ts';
import type {CoreState} from './state.ts';
import {createCard,setField,transact,type Session,type PlanePlacement} from './workspace.ts';
import type {CardImage,ChildEntry,Layout} from './types.ts';
import {validInk,type InkDocument} from './drawing.ts';
import {copyCardImages,validCardImages} from './card-images.ts';
import {collectSubtree} from './subtree.ts';
import {rendererOf,isBoard} from './renderer.ts';
import {entryKindOf,reshapeEntries} from './entries.ts';
import {pathFromRoot} from './scope.ts';
import {parseCardImages} from './image-markdown.ts';
import {copyLayoutSizes,validLayoutSizes,type LayoutSizes} from './layout-sizes.ts';

export type ShareCard={id:string;title:string;content:string;layout:Layout;layoutSizes?:LayoutSizes;type:string|null;prefabRef:string|null;isPrefab:boolean;images:CardImage[];doodle:InkDocument|null};
export type SharePackage={format:'kankanban-card';version:1;rootId:string;cards:ShareCard[];children:{parentId:string;entries:ChildEntry[]}[];assets:{assetId:string;base64:string}[]};
export type ShareAssetMetadata=Pick<CardImage,'mime'|'width'|'height'|'name'>;

export const MAX_SHARE_CARDS=10000;
export const MAX_SHARE_ASSETS=256;
export const MAX_SHARE_BASE64=150*1024*1024;
const MAX_SHARE_TEXT=32*1024*1024,MAX_SHARE_POINTS=500000;
const layouts:ReadonlySet<string>=new Set(['tabs','columns','ordered','grid','library','plane','plain']);
const assetPattern=/^[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/;
const base64Pattern=/^[A-Za-z0-9+/]*={0,2}$/;
function fail(key:TextKey):never{throw new Error(uiText(key));}
const validId=(value:unknown):value is string=>typeof value==='string' && /^[a-zA-Z0-9._-]{1,128}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const record=(value:unknown):value is Record<string,unknown>=>value!==null && typeof value==='object' && !Array.isArray(value) && (Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null);
function exact(value:unknown,keys:readonly string[],optional:readonly string[]=[]):value is Record<string,unknown>{
 return record(value) && keys.every(k=>Object.hasOwn(value,k)) && Object.keys(value).every(k=>keys.includes(k) || optional.includes(k));
}
const reference=(value:unknown):value is string|null=>value===null || validId(value);
const bounded=(value:unknown,max:number):value is string=>typeof value==='string' && value.length<=max && !value.includes('\u0000');

/** Only assets visible in the selected subtree are shared; synchronization history is excluded. */
export function shareAssetIds(state:CoreState,rootId:string):string[]{
 const walk=collectSubtree(state,rootId),used=new Set<string>();
 for(const id of walk.ids){const card=state.cards.get(id)!;if(card.deleted)fail('share.invalidTree');if(!validCardImages(card.images ?? []))fail('share.invalidAsset');for(const image of parseCardImages(card.content))used.add(image.assetId);}
 return [...used].sort();
}

/** Export by whitelist, never by serializing the workspace or raw CardFields. */
export function buildSharePackage(state:CoreState,rootId:string,assets:ReadonlyMap<string,string>,assetMetadata?:ReadonlyMap<string,ShareAssetMetadata>):SharePackage{
 const walk=collectSubtree(state,rootId),ids=new Set(walk.ids);
 const cards:ShareCard[]=walk.ids.map(id=>{
  const card=state.cards.get(id)!;if(card.deleted)fail('share.invalidTree');
  const type=card.type!==null && ids.has(card.type)?card.type:null;
  return {id,title:card.title,content:card.content,layout:card.type!==null && type===null?rendererOf(state,id):card.layout,...(card.layoutSizes===undefined?{}:{layoutSizes:copyLayoutSizes(card.layoutSizes)}),type,prefabRef:card.prefabRef!==null && ids.has(card.prefabRef)?card.prefabRef:null,isPrefab:card.isPrefab,images:referencedImages(card.content,card.images ?? [],assetMetadata),doodle:card.doodle?cleanInk(card.doodle,ids):null};
 });
 const byId=new Map(cards.map(card=>[card.id,card]));
 const children=Object.entries(walk.snapshot.children).map(([parentId,entries])=>{
  const layout=byId.get(parentId)!.layout,source=state.cards.get(parentId)!.layout;
  if(entryKindOf(layout)===entryKindOf(source))return {parentId,entries:entries.map(entry=>({...entry}))};
  if(layout==='plane')fail('share.invalidTree');
  return {parentId,entries:reshapeEntries(layout,entries)};
 });
 const payload=shareAssetIds(state,rootId).map(assetId=>{const base64=assets.get(assetId);if(base64===undefined)fail('share.missingAsset');return {assetId,base64};});
 return parseSharePackage({format:'kankanban-card',version:1,rootId,cards,children,assets:payload});
}

/** Treat package input as untrusted even after its binary assets have been verified natively. */
export function parseSharePackage(value:unknown):SharePackage{
 if(!exact(value,['format','version','rootId','cards','children','assets']) || value.format!=='kankanban-card' || value.version!==1 || !validId(value.rootId) || !Array.isArray(value.cards) || !Array.isArray(value.children) || !Array.isArray(value.assets))fail('share.invalid');
 if(value.cards.length<1 || value.cards.length>MAX_SHARE_CARDS || value.children.length>MAX_SHARE_CARDS || value.assets.length>MAX_SHARE_ASSETS)fail('share.tooLarge');
 const cards:ShareCard[]=[],byId=new Map<string,ShareCard>(),used=new Set<string>(),imageDimensions=new Map<string,{width:number;height:number}>();let textSize=0,points=0;
 for(const item of value.cards){
  if(!exact(item,['id','title','content','layout','type','prefabRef','isPrefab','images','doodle'],['layoutSizes']) || !validId(item.id) || byId.has(item.id) || !bounded(item.title,65536) || !bounded(item.content,MAX_SHARE_TEXT) || typeof item.layout!=='string' || !layouts.has(item.layout) || !reference(item.type) || !reference(item.prefabRef) || typeof item.isPrefab!=='boolean' || !validCardImages(item.images) || (item.doodle!==null && !safeInk(item.doodle)) || item.layoutSizes!==undefined&&!validLayoutSizes(item.layoutSizes))fail('share.invalid');
  const card:ShareCard={id:item.id,title:item.title,content:item.content,layout:item.layout as Layout,...(item.layoutSizes===undefined?{}:{layoutSizes:copyLayoutSizes(item.layoutSizes as LayoutSizes)}),type:item.type,prefabRef:item.prefabRef,isPrefab:item.isPrefab,images:copyCardImages(item.images),doodle:item.doodle===null?null:cleanInk(item.doodle)};
  // Undo-retained orphan metadata is local history, never part of a portable package.
  if(referencedImages(card.content,card.images).length!==card.images.length)fail('share.unusedAsset');
  textSize+=card.title.length+card.content.length;
  for(const image of card.images){
   const previous=imageDimensions.get(image.assetId);if(previous && (previous.width!==image.width || previous.height!==image.height))fail('share.invalidAsset');
   imageDimensions.set(image.assetId,{width:image.width,height:image.height});used.add(image.assetId);textSize+=image.name.length+256;
  }
  points+=card.doodle?.strokes.reduce((n,s)=>n+s.points.length,0) ?? 0;
  if(textSize>MAX_SHARE_TEXT || points>MAX_SHARE_POINTS)fail('share.tooLarge');
  cards.push(card);byId.set(card.id,card);
 }
 if(!byId.has(value.rootId))fail('share.invalidTree');
 for(const card of cards){
  if(card.type!==null && (!byId.has(card.type) || byId.get(card.type)!.type!==null))fail('share.invalidTree');
  if(card.prefabRef!==null && (card.prefabRef===card.id || !byId.get(card.prefabRef)?.isPrefab))fail('share.invalidTree');
  const ink=card.doodle;if(ink){const strokes=new Set(ink.strokes.map(s=>s.id));for(const group of ink.groups ?? [])if(group.strokes.some(id=>!strokes.has(id)) || group.cards.some(id=>!byId.has(id)))fail('share.invalidTree');}
 }
 const children:SharePackage['children']=[],rows=new Map<string,ChildEntry[]>(),parented=new Set<string>();
 for(const item of value.children){
  if(!exact(item,['parentId','entries']) || !validId(item.parentId) || !byId.has(item.parentId) || rows.has(item.parentId) || !Array.isArray(item.entries) || item.entries.length<1 || item.entries.length>MAX_SHARE_CARDS)fail('share.invalidTree');
  const entries:ChildEntry[]=[],kind=entryKindOf(byId.get(item.parentId)!.layout);let previous=-Infinity;
  for(const entry of item.entries){
   if(!record(entry) || !validId(entry.id) || !byId.has(entry.id) || parented.has(entry.id) || entry.id===value.rootId)fail('share.invalidTree');
   if(kind==='plain'){if(!exact(entry,['id']))fail('share.invalidTree');entries.push({id:entry.id});}
   else if(kind==='ordered'){
    if(!exact(entry,['id','order']) || typeof entry.order!=='number' || !Number.isFinite(entry.order) || entry.order<=previous)fail('share.invalidTree');previous=entry.order;entries.push({id:entry.id,order:entry.order});
   }else{
    if(!exact(entry,['id','x','y','w','h','z']) || !validPlane(entry))fail('share.invalidTree');
    entries.push({id:entry.id,x:entry.x as number,y:entry.y as number,w:entry.w as number,h:entry.h as number,z:entry.z as number});
   }
   parented.add(entry.id);
  }
  rows.set(item.parentId,entries);children.push({parentId:item.parentId,entries});
 }
 const reached=new Set<string>(),pending=[value.rootId];
 while(pending.length){const id=pending.pop()!;if(reached.has(id))fail('share.invalidTree');reached.add(id);for(const entry of rows.get(id) ?? [])pending.push(entry.id);}
 if(reached.size!==cards.length)fail('share.invalidTree');
 for(const card of cards){const layout=card.type===null?card.layout:byId.get(card.type)!.layout;if(layout==='columns' && (rows.get(card.id)?.length ?? 0)!==3)fail('share.boardStructure');}
 const assets:SharePackage['assets']=[],assetIds=new Set<string>();let base64Size=0;
 for(const item of value.assets){
  if(!exact(item,['assetId','base64']) || typeof item.assetId!=='string' || !assetPattern.test(item.assetId) || assetIds.has(item.assetId) || typeof item.base64!=='string' || item.base64.length<4 || item.base64.length>MAX_SHARE_BASE64)fail('share.invalidAsset');
  base64Size+=item.base64.length;if(base64Size>MAX_SHARE_BASE64)fail('share.tooLarge');if(!validBase64(item.base64))fail('share.invalidAsset');
  if(!used.has(item.assetId))fail('share.unusedAsset');assetIds.add(item.assetId);assets.push({assetId:item.assetId,base64:item.base64});
 }
 if([...used].some(id=>!assetIds.has(id)))fail('share.missingAsset');
 return {format:'kankanban-card',version:1,rootId:value.rootId,cards,children,assets};
}

function referencedImages(content:string,metadata:readonly CardImage[],assetMetadata?:ReadonlyMap<string,ShareAssetMetadata>):CardImage[]{
 if(!validCardImages(metadata))fail('share.invalidAsset');
 const references=parseCardImages(content,metadata);
 const used=new Set(references.map(reference=>reference.assetId));
 const images=copyCardImages(metadata.filter(image=>used.has(image.assetId))),ids=new Set(images.map(image=>image.id)),known=new Set(images.map(image=>image.assetId));
 for(const assetId of used){
  if(known.has(assetId))continue;
  const descriptor=assetMetadata?.get(assetId);if(!descriptor)fail('share.missingMetadata');
  let id='asset-'+assetId,index=0;while(ids.has(id))id='asset-'+assetId+'-'+(++index);
  ids.add(id);images.push({id,assetId,name:descriptor.name,mime:descriptor.mime,width:descriptor.width,height:descriptor.height});
 }
 if(!validCardImages(images))fail('share.invalidAsset');
 return images;
}

function validBase64(value:string):boolean{
 if(value.length%4!==0 || !base64Pattern.test(value))return false;
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
 if(value.endsWith('=='))return alphabet.indexOf(value[value.length-3]!)%16===0;
 if(value.endsWith('='))return alphabet.indexOf(value[value.length-2]!)%4===0;
 return true;
}

function validPlane(value:Record<string,unknown>):boolean{
 return ['x','y','w','h','z'].every(key=>typeof value[key]==='number' && Number.isFinite(value[key]) && Math.abs(value[key] as number)<=1e7) && (value.w as number)>0 && (value.h as number)>0;
}
function safeInk(value:unknown):value is InkDocument{
 if(!validInk(value) || !exact(value,['version','id','width','height','strokes'],['groups']) || !validId(value.id))return false;
 if(!value.strokes.every(stroke=>exact(stroke,['id','color','width','points']) && validId(stroke.id) && stroke.points.every(point=>exact(point,['x','y']))))return false;
 return (value.groups ?? []).every(group=>exact(group,['strokes','cards']) && group.strokes.every(validId) && group.cards.every(validId));
}
function cleanInk(ink:InkDocument,cardIds?:ReadonlySet<string>):InkDocument{
 return {version:1,id:ink.id,width:ink.width,height:ink.height,strokes:ink.strokes.map(s=>({id:s.id,color:s.color,width:s.width,points:s.points.map(p=>({x:p.x,y:p.y}))})),...(ink.groups===undefined?{}:{groups:ink.groups.map(g=>({strokes:[...g.strokes],cards:g.cards.filter(id=>!cardIds || cardIds.has(id))}))})};
}

/** The caller must verify and persist every package asset before this atomic tree import. */
export function importSharePackage(session:Session,value:unknown,parentId:string|null,plane?:PlanePlacement):{rootId:string;ids:string[];assetIds:string[]}{
 const pkg=parseSharePackage(value),parent=parentId===null?null:session.state.cards.get(parentId);
 if(parentId!==null && (!parent || parent.deleted || isBoard(session.state,parentId)))fail('share.invalidTarget');
 if(parent?.layout==='plane' && (!plane || !validPlane(plane)))fail('share.invalidTarget');
 const templates=parentId!==null && pathFromRoot(session.state,parentId).includes('003');
 const allocated=new Set<string>(session.state.cards.keys());
 const fresh=()=>{const id=session.newId();if(!validId(id) || allocated.has(id) || ['000','001','002','003'].includes(id))fail('share.idCollision');allocated.add(id);return id;};
 const ids=new Map(pkg.cards.map(card=>[card.id,fresh()]));
 const images=new Map(pkg.cards.map(card=>[card.id,card.images.map(image=>({...image,id:fresh()}))]));
 const inks=new Map(pkg.cards.map(card=>{
  if(!card.doodle)return [card.id,null] as const;
  const strokes=new Map(card.doodle.strokes.map(s=>[s.id,fresh()]));
  const ink:InkDocument={...card.doodle,id:fresh(),strokes:card.doodle.strokes.map(s=>({...s,id:strokes.get(s.id)!})),...(card.doodle.groups===undefined?{}:{groups:card.doodle.groups.map(g=>({strokes:g.strokes.map(id=>strokes.get(id)!),cards:g.cards.map(id=>ids.get(id)!)}))})};
  return [card.id,ink] as const;
 }));
 const byId=new Map(pkg.cards.map(card=>[card.id,card])),children=new Map(pkg.children.map(row=>[row.parentId,row.entries]));
 const ordered:{id:string;parentId:string|null;plane:PlanePlacement|undefined}[]=[{id:pkg.rootId,parentId,plane}];
 for(let index=0;index<ordered.length;index++)for(const entry of children.get(ordered[index]!.id) ?? [])ordered.push({id:entry.id,parentId:ids.get(ordered[index]!.id)!,plane:'x' in entry?{x:entry.x,y:entry.y,w:entry.w,h:entry.h,z:entry.z}:undefined});
 transact(session,draft=>{
  for(const node of ordered){const card=byId.get(node.id)!;createCard(draft,{id:ids.get(card.id)!,parentId:node.parentId,title:card.title,content:card.content,layout:card.layout,layoutSizes:card.layoutSizes,isPrefab:templates,images:images.get(card.id)!,doodle:inks.get(card.id)!,plane:node.plane});}
  for(const card of pkg.cards)if(card.type!==null)setField(draft,ids.get(card.id)!,'/type',ids.get(card.type)!);
 });
 return {rootId:ids.get(pkg.rootId)!,ids:[...ids.values()],assetIds:pkg.assets.map(asset=>asset.assetId)};
}
