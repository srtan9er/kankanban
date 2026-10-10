import {viewportPlane,type Point,type PlaneSize} from './plane-geometry.ts';
import {CARD_MIN_WIDTH,CARD_MIN_HEIGHT} from './layout-metrics.ts';
import type {PlaneEntry} from './types.ts';
export type InkColor='text'|'accent'|'danger'|'handle';
export type InkStroke={id:string;color:InkColor;width:number;points:Point[]};
export type InkGroup={strokes:string[];cards:string[]};
export type InkDocument={version:1;id:string;width:number;height:number;strokes:InkStroke[];groups?:InkGroup[]};
export const emptyInk=(id:string,width=640,height=360):InkDocument=>({version:1,id,width,height,strokes:[]});
export function validInk(value:unknown):value is InkDocument {
 if(!value || typeof value!=='object')return false;
 const doc=value as InkDocument;
 return doc.version===1 && typeof doc.id==='string' && doc.id.length<=100 && Number.isFinite(doc.width) && doc.width>0 && doc.width<=1e7 && Number.isFinite(doc.height) && doc.height>0 && doc.height<=1e7 && Array.isArray(doc.strokes) && doc.strokes.length<=2000 && new Set(doc.strokes.map(s=>s?.id)).size===doc.strokes.length && doc.strokes.every(s=>s && typeof s.id==='string' && s.id.length<=100 && ['text','accent','danger','handle'].includes(s.color) && Number.isFinite(s.width) && s.width>=.5 && s.width<=24 && Array.isArray(s.points) && s.points.length>0 && s.points.length<=20000 && s.points.every(p=>p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x)<=1e7 && Math.abs(p.y)<=1e7)) && doc.strokes.reduce((n,s)=>n+s.points.length,0)<=100000 && validInkGroups(doc.groups);
}
function validInkGroups(groups:unknown):boolean {
 if(groups===undefined)return true;
 if(!Array.isArray(groups) || groups.length>2000)return false;
 if(!groups.every(g=>g && Array.isArray(g.strokes) && g.strokes.length>0 && Array.isArray(g.cards) && [...g.strokes,...g.cards].every(id=>typeof id==='string' && id.length>0 && id.length<=100)))return false;
 const strokes=groups.flatMap(g=>g.strokes),cards=groups.flatMap(g=>g.cards);
 return strokes.length<=2000 && cards.length<=10000 && new Set(strokes).size===strokes.length && new Set(cards).size===cards.length;
}
export function parseInk(source:string):InkDocument|null {try{const value:unknown=JSON.parse(source);return validInk(value)?value:null;}catch{return null;}}
const strokeBounds=new WeakMap<InkStroke,PlaneEntry>();
export function inkEntries(doc:InkDocument):PlaneEntry[] {
 return doc.strokes.map(stroke=>{
  const cached=strokeBounds.get(stroke);if(cached)return cached;
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const point of stroke.points){left=Math.min(left,point.x);top=Math.min(top,point.y);right=Math.max(right,point.x);bottom=Math.max(bottom,point.y);}
  const entry={id:'ink-'+stroke.id,x:left-stroke.width/2,y:top-stroke.width/2,w:right-left+stroke.width,h:bottom-top+stroke.width,z:0};
  strokeBounds.set(stroke,entry);return entry;
 });
}
export function rebaseInk(doc:InkDocument,offset:Point,period:PlaneSize,viewport:PlaneSize):InkDocument {
 const entries=inkEntries(doc),next=viewportPlane(entries,offset,1,period,viewport,{width:0,height:0});
 return {...doc,width:period.width,height:period.height,strokes:doc.strokes.map((s,i)=>({...s,points:s.points.map(p=>({x:p.x+next[i]!.x-entries[i]!.x,y:p.y+next[i]!.y-entries[i]!.y}))}))};
}
export function mergeInk(current:InkDocument,before:InkDocument,next:InkDocument):InkDocument {
 const strokes=new Map(current.strokes.map(s=>[s.id,s])),after=new Map(next.strokes.map(s=>[s.id,s]));
 for(const s of before.strokes)if(!after.has(s.id))strokes.delete(s.id);
 const previous=new Map(before.strokes.map(s=>[s.id,s]));
 for(const s of next.strokes)if(JSON.stringify(s)!==JSON.stringify(previous.get(s.id)))strokes.set(s.id,s);
 return {...next,strokes:[...strokes.values()]};
}
export function hitInk(stroke:InkStroke,point:Point,radius:number):boolean {
 const tolerance=radius+stroke.width/2;
 return stroke.points.some((p,i)=>{
  const q=stroke.points[Math.max(0,i-1)]!,dx=p.x-q.x,dy=p.y-q.y;
  const t=Math.max(0,Math.min(1,((point.x-q.x)*dx+(point.y-q.y)*dy)/(dx*dx+dy*dy || 1)));
  return Math.hypot(point.x-q.x-t*dx,point.y-q.y-t*dy)<=tolerance;
 });
}

/** Discard only the obsolete drawing fences; ordinary text/code remains intact. */
export function discardLegacyInk(content:string):string {
 return content.replace(/^```(?:kkb-drawing|kkb-canvas)\r?\n[\s\S]*?\r?\n```[ \t]*(?:\r?\n|$)/gm,'');
}

/** Bounding rectangles include the visible stroke thickness. */
export function rectIntersects(a:PlaneEntry,b:PlaneEntry):boolean {return a.x<=b.x+b.w && b.x<=a.x+a.w && a.y<=b.y+b.h && b.y<=a.y+a.h;}
const inkBounds=(entries:readonly PlaneEntry[]):PlaneEntry=>{
 const x=Math.min(...entries.map(e=>e.x)),y=Math.min(...entries.map(e=>e.y));
 return {id:'ink-group',x,y,w:Math.max(...entries.map(e=>e.x+e.w))-x,h:Math.max(...entries.map(e=>e.y+e.h))-y,z:0};
};
const cardRects=(entries:readonly PlaneEntry[])=>entries.map(e=>({...e,w:Math.max(CARD_MIN_WIDTH,e.w),h:Math.max(CARD_MIN_HEIGHT,e.h)}));
/** Run after real drawing/card edits, never as the normal viewport-rebase step. */
export function linkCanvasInk(entries:readonly PlaneEntry[],document:InkDocument,period?:PlaneSize):{entries:PlaneEntry[];document:InkDocument} {
 const strokes=inkEntries(document),cards=cardRects(entries),rects=[...strokes,...cards];
 const parent=rects.map((_,i)=>i),shifts=rects.map(()=>({x:0,y:0}));
 const find=(i:number):{root:number;shift:Point}=>{
  if(parent[i]===i)return {root:i,shift:shifts[i]!};
  const next=find(parent[i]!);shifts[i]={x:shifts[i]!.x+next.shift.x,y:shifts[i]!.y+next.shift.y};parent[i]=next.root;return {root:next.root,shift:shifts[i]!};
 };
 const intersectShift=(a:PlaneEntry,b:PlaneEntry):Point|null=>{
  if(rectIntersects(a,b))return {x:0,y:0};if(!period)return null;
  const kx=Math.round((a.x+a.w/2-b.x-b.w/2)/period.width),ky=Math.round((a.y+a.h/2-b.y-b.h/2)/period.height);
  let best:Point|null=null,distance=Infinity;
  for(const dx of [-1,0,1])for(const dy of [-1,0,1]){const x=kx+dx,y=ky+dy;
   const shift={x:x*period.width,y:y*period.height},candidate={...b,x:b.x+shift.x,y:b.y+shift.y};
   if(rectIntersects(a,candidate)){const d=(candidate.x+candidate.w/2-a.x-a.w/2)**2+(candidate.y+candidate.h/2-a.y-a.h/2)**2;if(d<distance){best=shift;distance=d;}}
  }
  return best;
 };
 for(let a=0;a<strokes.length;a++)for(let b=a+1;b<rects.length;b++){
  const delta=intersectShift(rects[a]!,rects[b]!);if(!delta)continue;
  const left=find(a),right=find(b);if(left.root===right.root)continue;
  parent[right.root]=left.root;shifts[right.root]={x:left.shift.x+delta.x-right.shift.x,y:left.shift.y+delta.y-right.shift.y};
 }
 const grouped=new Map<number,InkGroup>();
 const strokeShifts=document.strokes.map((stroke,i)=>{const located=find(i),group=grouped.get(located.root) ?? {strokes:[],cards:[]};group.strokes.push(stroke.id);grouped.set(located.root,group);return located.shift;});
 const nextEntries=entries.map((entry,i)=>{const located=find(strokes.length+i),group=grouped.get(located.root);if(!group)return {...entry};group.cards.push(entry.id);return {...entry,x:entry.x+located.shift.x,y:entry.y+located.shift.y};});
 return {entries:nextEntries,document:{...document,groups:[...grouped.values()],strokes:document.strokes.map((stroke,i)=>({...stroke,points:stroke.points.map(p=>({x:p.x+strokeShifts[i]!.x,y:p.y+strokeShifts[i]!.y}))}))}};
}
/** Connected members use one shift; isolated strokes/cards retain the old wrap behavior. */
export function projectInkCanvas(entries:readonly PlaneEntry[],document:InkDocument,offset:Point,period:PlaneSize,viewport:PlaneSize,includeInk=true):{entries:PlaneEntry[];document:InkDocument} {
 const source=document.groups===undefined?linkCanvasInk(entries,document,period):{entries:[...entries],document};
 const nextEntries=viewportPlane(source.entries,offset,1,period,viewport);
 const oldBoxes=inkEntries(source.document),mappedBoxes=includeInk?viewportPlane(oldBoxes,offset,1,period,viewport,{width:0,height:0}):oldBoxes;
 const deltas=mappedBoxes.map((box,i)=>({x:box.x-oldBoxes[i]!.x,y:box.y-oldBoxes[i]!.y}));
 const oldStrokes=inkEntries(source.document),cardIndex=new Map(source.entries.map((e,i)=>[e.id,i])),strokeIndex=new Map(source.document.strokes.map((s,i)=>[s.id,i]));
 for(const group of source.document.groups ?? []){
  const si=group.strokes.map(id=>strokeIndex.get(id)).filter((i):i is number=>i!==undefined),ci=group.cards.map(id=>cardIndex.get(id)).filter((i):i is number=>i!==undefined);
  if(!si.length)continue;
  const bounds=inkBounds([...si.map(i=>oldStrokes[i]!),...ci.map(i=>cardRects([source.entries[i]!])[0]!)]);
  const mapped=viewportPlane([bounds],offset,1,period,viewport,{width:0,height:0})[0]!;
  const shift={x:mapped.x-bounds.x,y:mapped.y-bounds.y};
  for(const i of ci)nextEntries[i]={...source.entries[i]!,x:source.entries[i]!.x+shift.x,y:source.entries[i]!.y+shift.y};
  if(includeInk)for(const i of si)deltas[i]=shift;
 }
 const nextInk=includeInk?{...source.document,width:period.width,height:period.height,strokes:source.document.strokes.map((stroke,i)=>{
  const delta=deltas[i]!;return delta.x || delta.y?{...stroke,points:stroke.points.map(p=>({x:p.x+delta.x,y:p.y+delta.y}))}:stroke;
 })}:source.document;
 return {entries:nextEntries,document:nextInk};
}
/** Period padding covers complete groups, so one group cannot show twice in the viewport. */
export function inkPeriodEntries(entries:readonly PlaneEntry[],document:InkDocument):PlaneEntry[] {
 const strokes=inkEntries(document),byStroke=new Map(document.strokes.map((s,i)=>[s.id,strokes[i]!])),byCard=new Map(cardRects(entries).map(e=>[e.id,e]));
 const groups=(document.groups ?? []).flatMap(group=>{
  const members=[...group.strokes.map(id=>byStroke.get(id)),...group.cards.map(id=>byCard.get(id))].filter((entry):entry is PlaneEntry=>!!entry);
  return members.length?[inkBounds(members)]:[];
 });
 return [...strokes,...groups];
}
export function remapInkCards(document:InkDocument,ids:ReadonlyMap<string,string>):InkDocument {
 return document.groups===undefined?document:{...document,groups:document.groups.map(group=>({...group,cards:group.cards.flatMap(id=>{const mapped=ids.get(id);return mapped?[mapped]:[];})}))};
}
