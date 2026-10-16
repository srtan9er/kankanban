import {useLayoutEffect} from 'react';
type Position={left:number;top:number};
const STORAGE='kkb-scroll-memory-v1',LIMIT=512;
export class ScrollPositions {
 private values=new Map<string,Position>();
 get(key:string):Position|undefined{return this.values.get(key);}
 set(key:string,position:Position):void{this.values.delete(key);this.values.set(key,{left:Math.max(0,position.left),top:Math.max(0,position.top)});while(this.values.size>LIMIT)this.values.delete(this.values.keys().next().value!);}
 entries():[string,Position][]{return [...this.values];}
}
const positions=new ScrollPositions();
try{for(const [key,value] of JSON.parse(sessionStorage.getItem(STORAGE) ?? '[]'))if(typeof key==='string' && value && Number.isFinite(value.left) && Number.isFinite(value.top))positions.set(key,value);}catch{/* Temporary in-memory cache remains available. */}
let saveTimer:ReturnType<typeof setTimeout>|undefined;
const persist=()=>{if(saveTimer)clearTimeout(saveTimer);saveTimer=undefined;try{sessionStorage.setItem(STORAGE,JSON.stringify(positions.entries()));}catch{/* Storage is optional. */}};
const saveLater=()=>{if(!saveTimer)saveTimer=setTimeout(persist,150);};
const regions:readonly [string,string][]=[
 ['.git-sidebar-content','git-references'],['.git-commit-files','git-commit-files'],['.git-popover','git-popover'],['.git-panel','git-panel'],['.git-list','git-list'],['.git-detail','git-detail'],['.git-graph','git-graph'],['.git-diff','git-diff'],
 ['.preview','body'],['textarea.content,.markdown-editor.content','body'],['input.title','title'],['.card-body-region','body-region'],
 ['.horizontal-card-list','children-horizontal'],['.vertical-card-list','children-vertical'],['.masonry-grid','children-waterfall'],
 ['.note-children','children-region'],['.column-cards','board-column'],['.settings-page','settings'],['.manager-home','manager'],
 ['.ordinary-content','document-content'],['.table-cell-content','table-cell'],['.table-cell-editor','table-cell-editor'],
 ['.collection-region','collection'],['.ordinary-document','document'],['.desktop-list','desktop-list'],['.manager-tabs','navigation'],
 ['.edit-dialog','edit-dialog'],['.edit-dialog textarea,.edit-dialog [data-markdown-editor]','edit-content'],['.edit-dialog input','edit-title'],['.action-menu','menu'],['.layout-choices','layout-menu'],
];
type Binding={key:string;region:string;target:Position;pending:boolean;visibleAt:number;hidden:boolean};
/** Capture scrolls only; restoration never changes tree, view-state or canvas pan/zoom. */
export function attachScrollMemory(root:HTMLElement,scope:string,cache=positions):()=>void {
 const bindings=new Map<HTMLElement,Binding>();let frame:number|undefined,disposed=false;
 const schedule=()=>{if(frame===undefined)frame=requestAnimationFrame(()=>{frame=undefined;scan();});};
 const keyFor=(element:HTMLElement,region:string)=>{
  const owner=element.closest<HTMLElement>('[data-scroll-owner]')?.dataset.scrollOwner ?? 'root';
  const column=region==='board-column'?element.closest<HTMLElement>('[data-drop-parent]')?.dataset.dropParent ?? '':region.startsWith('table-cell')?JSON.stringify([element.closest<HTMLElement>('[data-object-name]')?.dataset.objectName,element.closest<HTMLElement>('[data-table-cell]')?.dataset.tableCell]):'';
  return JSON.stringify([scope,owner,region,column]);
 };
 const restore=(element:HTMLElement,binding:Binding)=>{
  // A source-character anchor owns mode transitions; a cached pixel offset can
  // refer to a different line after Markdown is rendered or made editable.
  if(element.dataset.bodyPositionManaged==='true'){binding.pending=false;binding.hidden=false;return;}
  if(!element.clientWidth || !element.clientHeight){binding.hidden=true;return;}
  if(binding.hidden){binding.hidden=false;binding.target=cache.get(binding.key) ?? binding.target;binding.pending=true;binding.visibleAt=0;}
  if(!binding.pending)return;
  if(!binding.visibleAt)binding.visibleAt=Date.now();
  element.scrollLeft=binding.target.left;element.scrollTop=binding.target.top;
  if((Math.abs(element.scrollLeft-binding.target.left)<1 && Math.abs(element.scrollTop-binding.target.top)<1) || Date.now()-binding.visibleAt>600)binding.pending=false;
 };
 const resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(schedule);
 const scan=()=>{
  if(disposed)return;
  const found=new Set<HTMLElement>();
  for(const [selector,region] of regions)for(const element of root.querySelectorAll<HTMLElement>(selector)){
   // Shared body editors overflow into their persistent preview viewport.
   // Binding them too would restore and overwrite the same body key at zero.
   if(region==='body' && element.hasAttribute('data-markdown-editor') && element.closest('.card-body-editor'))continue;
   if(found.has(element))continue;found.add(element);
   const key=keyFor(element,region);let binding=bindings.get(element);
   if(!binding || binding.key!==key){binding={key,region,target:cache.get(key) ?? {left:0,top:0},pending:true,visibleAt:0,hidden:false};bindings.set(element,binding);resize?.observe(element);}
   restore(element,binding);
  }
  for(const element of bindings.keys())if(!found.has(element)){resize?.unobserve(element);bindings.delete(element);}
  if([...bindings].some(([element,binding])=>binding.pending && element.clientWidth>0 && element.clientHeight>0))schedule();
 };
 const scroll=(event:Event)=>{
  const element=event.target as HTMLElement,binding=bindings.get(element);if(!binding || binding.pending || !element.clientWidth || !element.clientHeight)return;
  if(keyFor(element,binding.region)!==binding.key){schedule();return;}
  binding.target={left:element.scrollLeft,top:element.scrollTop};cache.set(binding.key,binding.target);if(cache===positions)saveLater();
 };
 const intent=(event:Event)=>{
  const target=event.target as Element;if(!target.closest)return;
  for(const [element,binding] of bindings)if(element===target || element.contains(target))binding.pending=false;
 };
 const mutation=new MutationObserver(records=>{
  // Infinite-plane transforms are not scrolling and must not rescan every frame.
  if(records.some(record=>record.attributeName==='data-scroll-owner' || !(record.target instanceof Element) || !record.target.closest('.canvas-viewport')))schedule();
 });mutation.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','data-scroll-owner','data-body-position-managed']});
 root.addEventListener('scroll',scroll,true);root.addEventListener('wheel',intent,true);root.addEventListener('pointerdown',intent,true);root.addEventListener('keydown',intent,true);window.addEventListener('pagehide',persist);
 scan();
 return()=>{disposed=true;if(frame!==undefined)cancelAnimationFrame(frame);mutation.disconnect();resize?.disconnect();root.removeEventListener('scroll',scroll,true);root.removeEventListener('wheel',intent,true);root.removeEventListener('pointerdown',intent,true);root.removeEventListener('keydown',intent,true);window.removeEventListener('pagehide',persist);if(cache===positions)persist();};
}
export function useScrollMemory(scope:string):void {
 useLayoutEffect(()=>{const root=document.getElementById('root');return root?attachScrollMemory(root,scope):undefined;},[scope]);
}
