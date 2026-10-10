import {uiText} from '../i18n/text.ts';
import {tutorialCards} from './tutorial-template.ts';
import {createCard,setField,transact,type Session} from './workspace.ts';
import {savePrefabBase} from './prefab-sync.ts';
/** Reopen the user's copy without replacing practice edits; recreate only after root deletion. */
export function ensureTutorial(session:Session,existingId?:string):string {
 const existing=existingId ?? 'tutorial-welcome';
 if(session.state.cards.get(existing) && !session.state.cards.get(existing)!.deleted)return existing;
 return transact(session,s=>{
  const ids=new Map<string,string>();
  const templates=new Map(tutorialCards.map(card=>[card.key,card]));
  const create=(key:string):string=>{
   const existing=ids.get(key);if(existing)return existing;
   const card=templates.get(key)!;
   const parent=card.parent===null?null:templates.has(card.parent)?create(card.parent):card.parent;
   const id=createCard(s,{parentId:parent,title:uiText(card.title),content:uiText(card.content),layout:card.layout,isPrefab:card.isPrefab,plane:card.plane ?? undefined});
   ids.set(card.key,id);return id;
  };
  for(const card of tutorialCards)create(card.key);
  for(const card of tutorialCards)if(card.prefabRef)setField(s,ids.get(card.key)!,'/prefabRef',ids.get(card.prefabRef)!);
  for(const card of tutorialCards)if(card.prefabRef)savePrefabBase(s,ids.get(card.key)!);
  return ids.get('root')!;
 });
}
