import {remapInkCards,type InkDocument} from './drawing.ts';
import {copyCardImages,type CardImage} from './card-images.ts';
import {copyLayoutSizes,type LayoutSizes} from './layout-sizes.ts';
import {uiText} from '../i18n/text.ts';
import type {CardFields,Layout} from './types.ts';
import type {CoreState} from './state.ts';
import {createCard,setField,setLayout,moveCard,deleteCard,type Session,type PlanePlacement} from './workspace.ts';

type Node = {key:string; parent:string|null; index:number; title:string; content:string; images?:CardImage[]; doodle:InkDocument|null; layout:Layout; layoutSizes:LayoutSizes|null; type:string|null; plane:PlanePlacement|null};
type Tree = Node[];
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const identity=(card:CardFields)=>card.prefabRef ?? card.id;
export function prefabSnapshot(state:CoreState,id:string):Tree {
 const nodes:Tree=[],seen=new Set<string>(),canonicalIds=new Map<string,string>();
 const visit=(id:string,parent:string|null,index:number,plane:PlanePlacement|null)=>{
  const card=state.cards.get(id);if(!card || card.deleted)return;
  const preferred=identity(card),key=seen.has(preferred)?id:preferred;seen.add(key);canonicalIds.set(id,key);
  nodes.push({key,parent,index,title:card.title,content:card.content,images:copyCardImages(card.images ?? []),doodle:card.doodle ?? null,layout:card.layout,layoutSizes:card.layoutSizes?copyLayoutSizes(card.layoutSizes):null,type:card.type,plane});
  (state.children.get(id) ?? []).forEach((entry,i)=>visit(entry.id,key,i,'x' in entry?{x:entry.x,y:entry.y,w:entry.w,h:entry.h,z:entry.z}:null));
 };
 visit(id,null,0,null);return nodes.map(node=>({...node,doodle:node.doodle?remapInkCards(node.doodle,canonicalIds):null}));
}
function nodeIds(state:CoreState,root:string):Map<string,string> {
 const ids=new Map<string,string>();
 const visit=(id:string)=>{const card=state.cards.get(id)!,preferred=identity(card);ids.set(ids.has(preferred)?id:preferred,id);for(const e of state.children.get(id) ?? [])visit(e.id);};
 visit(root);return ids;
}
function baseline(s:Session,id:string):Tree {
 const card=s.state.cards.get(id)!;
 if(card.prefabBase)return (JSON.parse(card.prefabBase) as Tree).map(node=>({...node,images:copyCardImages(node.images ?? []),layoutSizes:node.layoutSizes?copyLayoutSizes(node.layoutSizes):null}));
 // Old instances have no recorded baseline: compare with their current template.
 return card.prefabRef?prefabSnapshot(s.state,card.prefabRef):[];
}
export function rememberPrefabBases(s:Session):void {
 for(const card of [...s.state.cards.values()])if(!card.deleted && (card.isPrefab || card.prefabRef) && !card.prefabBase)
  setField(s,card.id,'/prefabBase',JSON.stringify(card.prefabRef?prefabSnapshot(s.state,card.prefabRef):prefabSnapshot(s.state,card.id)));
}
export function savePrefabBase(s:Session,id:string):void {
 setField(s,id,'/prefabBase',JSON.stringify(prefabSnapshot(s.state,id)));
}
const fields=['title','content','images','doodle','layout','layoutSizes','type','parent','index','plane'] as const;
/** Apply only source changes, keeping unrelated target edits. */
function merge(before:Tree,after:Tree,target:Tree):Tree {
 const old=new Map(before.map(n=>[n.key,n])),now=new Map(after.map(n=>[n.key,n]));
 const result=new Map(target.map(n=>[n.key,{...n}]));
 for(const node of before)if(!now.has(node.key))result.delete(node.key);
 for(const node of after){
  const prev=old.get(node.key),existing=result.get(node.key);
  if(!prev){result.set(node.key,{...node});continue;}
  if(!existing){if(!equal(prev,node))result.set(node.key,{...node});continue;}
  for(const field of fields)if(!equal(field==='images'?prev.images ?? []:prev[field],node[field]))Object.assign(existing,{[field]:node[field]});
 }
 // A target-only child of a removed node remains local, rehomed to the root.
 const root=after[0]?.key;
 for(const node of result.values())if(node.parent!==null && !result.has(node.parent))node.parent=root ?? null;
 return [...result.values()];
}
function remap(tree:Tree,keys:Map<string,string>):Tree {
 const allKeys=new Map(tree.map(node=>[node.key,keys.get(node.key) ?? node.key]));
 return tree.map(n=>({...n,key:keys.get(n.key) ?? n.key,parent:n.parent===null?null:keys.get(n.parent) ?? n.parent,doodle:n.doodle?remapInkCards(n.doodle,allKeys):null}));
}
function applyDelta(s:Session,root:string,before:Tree,after:Tree,toPrefab:boolean):Map<string,string> {
 if(equal(before,after))return new Map();
 const original=prefabSnapshot(s.state,root),desired=merge(before,after,original);
 const oldBase=baseline(s,root),nextBase=merge(before,after,oldBase);
 const ids=nodeIds(s.state,root);
 const keys=new Map<string,string>(),oldNodes=new Map(original.map(n=>[n.key,n]));
 // Temporarily remove fixed-column constraints while reconciling the tree in one transaction.
 for(const id of ids.values()){
  setField(s,id,'/type',null);
  if(s.state.cards.get(id)?.layout==='columns')setLayout(s,id,'plain');
 }
 const pending=desired.filter(n=>!ids.has(n.key));
 while(pending.length){
  const index=pending.findIndex(n=>n.parent===null || ids.has(n.parent));
  if(index<0)throw new Error(uiText("core/prefab-sync.text001"));
  const node=pending.splice(index,1)[0]!;
  const parent=node.parent===null?root:ids.get(node.parent)!;
  const id=createCard(s,{parentId:parent,title:node.title,content:node.content,images:node.images,doodle:node.doodle ?? null,layout:'plain',layoutSizes:node.layoutSizes ?? undefined,isPrefab:toPrefab,plane:node.plane ?? {x:32,y:32,w:220,h:120,z:node.index}});
  ids.set(node.key,id);
  if(toPrefab)keys.set(node.key,id);else setField(s,id,'/prefabRef',node.key);
 }
 // Flatten only reparented survivors first, so reversing a parent/child pair cannot form a cycle.
 for(const node of desired){
  const previous=oldNodes.get(node.key),id=ids.get(node.key)!;
  if(id!==root && previous && previous.parent!==node.parent)moveCard(s,id,root,(s.state.children.get(root) ?? []).length,node.plane ?? {x:32,y:32,w:220,h:120,z:node.index});
 }
 // Parents precede children in the desired tree, even after arbitrary reparenting.
 const ordered:Tree=[],remaining=[...desired];
 while(remaining.length){
  const i=remaining.findIndex(n=>n.parent===null || ordered.some(p=>p.key===n.parent));
  if(i<0)throw new Error(uiText("core/prefab-sync.text002"));ordered.push(remaining.splice(i,1)[0]!);
 }
 for(const node of ordered){
  const id=ids.get(node.key)!,previous=oldNodes.get(node.key);
  for(const field of ['title','content','images','doodle','layoutSizes'] as const)setField(s,id,`/${field}`,field==='doodle'?(node.doodle?remapInkCards(node.doodle,ids):null):field==='images'?copyCardImages(node.images ?? []):node[field]);
  if(node.parent!==null && (!previous || previous.parent!==node.parent || previous.index!==node.index || !equal(previous.plane,node.plane))){
   moveCard(s,id,ids.get(node.parent)!,node.index,node.plane ?? {x:32,y:32,w:220,h:120,z:node.index});
  }
 }
 const wanted=new Set(desired.map(n=>n.key));
 for(const node of [...original].reverse())if(!wanted.has(node.key)){
  const id=ids.get(node.key)!;if(!s.state.cards.get(id)?.deleted)deleteCard(s,id,true);
 }
 for(const node of ordered){
  const id=ids.get(node.key)!;
  const placements=(s.state.children.get(id) ?? []).map((entry,i)=>{const n=desired.find(n=>ids.get(n.key)===entry.id);return {id:entry.id,...(n?.plane ?? {x:32+i*244,y:32,w:220,h:120,z:i})};});
  setLayout(s,id,node.layout,{placements});
  // A same-layout plane still needs the changed geometry applied.
  if(node.layout==='plane')for(const [i,p] of placements.entries())moveCard(s,p.id,id,i,p);
 }
 for(const node of ordered)setField(s,ids.get(node.key)!,'/type',node.type);
 setField(s,root,'/prefabBase',JSON.stringify(remap(nextBase,keys)));
 return keys;
}
export function syncPrefab(s:Session,id:string,target:'prefab'|'all'):void {
 const source=s.state.cards.get(id);
 if(!source || source.deleted || (!source.isPrefab && !source.prefabRef))throw new Error(uiText("core/prefab-sync.text003"));
 const templateId=source.isPrefab?id:source.prefabRef!;
 const template=s.state.cards.get(templateId);
 if(!template?.isPrefab || template.deleted)throw new Error(uiText("core/prefab-sync.text004"));
 if(!source.isPrefab){
  const pendingTemplateBase=template.prefabBase;
  const before=baseline(s,id),after=prefabSnapshot(s.state,id),sourceIds=nodeIds(s.state,id);
  const keys=applyDelta(s,templateId,before,after,true);
  // Changes sent only to the template remain pending for its other instances.
  setField(s,templateId,'/prefabBase',pendingTemplateBase ?? JSON.stringify(before));
  for(const node of after)if(keys.has(node.key))setField(s,sourceIds.get(node.key)!,'/prefabRef',keys.get(node.key)!);
  savePrefabBase(s,id);
 }
 if(target==='all'){
  const before=baseline(s,templateId),after=prefabSnapshot(s.state,templateId);
  const branch=(tree:Tree,key:string):Tree=>{
   const result:Tree=[],queue=[key];
   while(queue.length){const key=queue.shift()!,node=tree.find(n=>n.key===key);if(!node)continue;result.push({...node});queue.push(...tree.filter(n=>n.parent===key).map(n=>n.key));}
   if(result[0])result[0]={...result[0],parent:null,index:0,plane:null};
   return result;
  };
  // Include independently instantiated descendants, not only copies of the root.
  for(const node of after){
   const instances=[...s.state.cards.values()].filter(c=>!c.deleted && c.prefabRef===node.key);
   for(const instance of instances)applyDelta(s,instance.id,branch(before,node.key),branch(after,node.key),false);
   savePrefabBase(s,node.key);
  }
  const aliveKeys=new Set(after.map(node=>node.key));
  for(const node of [...before].reverse())if(!aliveKeys.has(node.key) && s.state.cards.get(node.key)?.deleted){
   for(const instance of [...s.state.cards.values()])if(!instance.deleted && instance.prefabRef===node.key && !s.state.cards.get(instance.id)?.deleted)deleteCard(s,instance.id,true);
  }
 }
}
