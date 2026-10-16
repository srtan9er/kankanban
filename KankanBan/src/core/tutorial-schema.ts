import {uiText,type TextKey} from '../i18n/text.ts';
import type {Layout} from './types.ts';
import type {PlanePlacement} from './workspace.ts';
import type {ImagePlacement} from './image-markdown.ts';
import type {LayoutSizes} from './layout-sizes.ts';

/** Tutorial structure is data. All visible prose belongs to the locale catalog. */
export type TutorialCardTemplate={
 key:string;parent:string|null;title:TextKey;content:TextKey;
 role:'root'|'face'|'level'|'step'|'practice';
 level?:string;layout?:Layout;isPrefab?:boolean;prefabRef?:string;plane?:PlanePlacement;
 layoutSizes?:LayoutSizes;
 images?:readonly (ImagePlacement & {asset:'star'|'starLarge'|'sunrise'|'night'})[];
 /** A seeded example can carry pending content edits on both sides of a sync. */
 prefabBaseContent?:TextKey;
 doodle?:'empty'|'sample';
 /** Authored ink, with card bindings expressed as template keys. */
 doodleAsset?:string;
};
export type ExtensionTutorial={root:string;cards:readonly TutorialCardTemplate[]};

/** A provider cannot create cross-module parents, cycles or unreachable lessons. */
export function validExtensionTutorial(value:unknown):value is ExtensionTutorial {
 if(!value || typeof value!=='object')return false;
 const tutorial=value as ExtensionTutorial;
 if(typeof tutorial.root!=='string'||!Array.isArray(tutorial.cards)||!tutorial.cards.length||tutorial.cards.length>1000)return false;
 const cards=new Map<string,TutorialCardTemplate>();
 for(const card of tutorial.cards){
  if(!card || typeof card.key!=='string'||!card.key||cards.has(card.key)||typeof card.title!=='string'||typeof card.content!=='string'||!['level','step','practice'].includes(card.role))return false;
  cards.set(card.key,card);
 }
 if(cards.get(tutorial.root)?.role!=='level'||cards.get(tutorial.root)?.parent!==null)return false;
 for(const card of cards.values()){
  const seen=new Set<string>();let current:TutorialCardTemplate|undefined=card;
  while(current.key!==tutorial.root){
   if(seen.has(current.key)||current.parent===null)return false;seen.add(current.key);
   current=cards.get(current.parent);if(!current)return false;
  }
  if(card.prefabRef && !cards.has(card.prefabRef))return false;
 }
 try{return tutorial.cards.every(card=>uiText(card.title).trim()&&uiText(card.content).trim());}catch{return false;}
}
