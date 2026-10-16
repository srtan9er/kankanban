import {uiText} from '../i18n/text.ts';
import {tutorialCards} from './tutorial-template.ts';
import type {TutorialCardTemplate} from './tutorial-schema.ts';
import {createCard,setField,transact,type Session} from './workspace.ts';
import {savePrefabBase,prefabSnapshot} from './prefab-sync.ts';
import {ensureTables} from './table-markdown.ts';
import {emptyInk,validInk,remapInkCards,type InkDocument} from './drawing.ts';
import {tutorialImage} from '../tutorial/assets.ts';
import doodleData from '../tutorial/doodle-data.json' with {type:'json'};
export const TUTORIAL_EDITION=8;
/** Reuse a current learning copy; a new edition gets a fresh tree. */
export function ensureTutorial(session:Session,existingId?:string,edition=TUTORIAL_EDITION,cards:readonly TutorialCardTemplate[]=tutorialCards):string {
 const existing=existingId ?? 'tutorial-welcome';
 if(edition===TUTORIAL_EDITION && session.state.cards.get(existing) && !session.state.cards.get(existing)!.deleted)return existing;
 return transact(session,s=>{
  const ids=new Map<string,string>();
  const templates=new Map(cards.map(card=>[card.key,card]));
  const create=(key:string):string=>{
   const existing=ids.get(key);if(existing)return existing;
   const card=templates.get(key)!;
   const parent=card.parent===null?null:templates.has(card.parent)?create(card.parent):card.parent;
   // Tutorial fixtures obey the same library boundary as normal prefab moves.
   if(card.isPrefab && parent!=='003' && !s.state.cards.get(parent ?? '')?.isPrefab)throw new Error(uiText('core/workspace.text004'));
   const images=card.images?.map(image=>tutorialImage(image.asset,s.newId()));
   const parameters=Object.fromEntries((card.images ?? []).map((image,index)=>{
    const source=images![index]!;
    const attributes=[`src="../assets/images/${source.assetId}"`,`name="image_${index}"`,`layout="${image.layout}"`,...(['width','height','x','y','layer'] as const).flatMap(key=>image[key]===undefined?[]:[`${key}="${image[key]}"`])];
    return [`arg${index}`,`<image ${attributes.join(' ')}></image>`];
   }));
   let doodle:InkDocument|undefined=card.doodle?emptyInk(s.newId(),400,360):undefined;
   if(card.doodleAsset){
    const stored=(doodleData as Record<string,unknown>)[card.doodleAsset];
    const ink:unknown={...(stored && typeof stored==='object'?structuredClone(stored):{}),id:s.newId()};
    if(!validInk(ink))throw new Error(uiText('tutorialBuild.invalidGraph'));
    const strokeIds=new Map(ink.strokes.map(stroke=>[stroke.id,s.newId()]));
    ink.strokes=ink.strokes.map(stroke=>({...stroke,id:strokeIds.get(stroke.id)!}));
    if(ink.groups)ink.groups=ink.groups.map(group=>({...group,strokes:group.strokes.map(id=>strokeIds.get(id)!)}));
    doodle=ink;
   }
   if(doodle && card.doodle==='sample')doodle.strokes=[{id:s.newId(),color:'text',width:3,points:[{x:24,y:24},{x:170,y:24},{x:170,y:46}]}];
   const id=createCard(s,{parentId:parent,title:uiText(card.title),content:ensureTables(uiText(card.content,parameters)),layout:card.layout,layoutSizes:card.layoutSizes,isPrefab:card.isPrefab,plane:card.plane, ...(images?{images}:{}),...(doodle?{doodle}:{})});
   ids.set(card.key,id);return id;
  };
  for(const card of cards)create(card.key);
  for(const card of cards)if(card.doodleAsset){
   const id=ids.get(card.key)!,ink=s.state.cards.get(id)!.doodle!;
   if(ink.groups?.some(group=>group.cards.some(key=>!ids.has(key))))throw new Error(uiText('tutorialBuild.invalidGraph'));
   setField(s,id,'/doodle',remapInkCards(ink,ids));
  }
  for(const card of cards)if(card.prefabRef)setField(s,ids.get(card.key)!,'/prefabRef',ids.get(card.prefabRef)!);
  for(const card of cards)if(card.prefabRef || card.prefabBaseContent){
   const id=ids.get(card.key)!;savePrefabBase(s,id);
   if(card.prefabBaseContent){
    const before=prefabSnapshot(s.state,id);before[0]!.content=uiText(card.prefabBaseContent);
    setField(s,id,'/prefabBase',JSON.stringify(before));
   }
  }
  return ids.get('root')!;
 });
}
