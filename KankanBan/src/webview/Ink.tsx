import {watchDragRelease} from './drag-release.ts';
import {registerEditor} from './drafts.ts';
import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent,type RefObject} from 'react';
import {uiText} from '../i18n/text.ts';
import {emptyInk,hitInk,mergeInk,PENCIL_COLOR,PENCIL_WIDTH,type InkDocument,type InkStroke} from '../core/drawing.ts';

export function InkPicture({document,width=document.width,height=document.height}:{document:InkDocument;width?:number;height?:number}) {
 return <svg className="ink-picture" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
  {document.strokes.map(s=><polyline key={s.id} points={s.points.map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke={`var(--palette-${s.color})`} strokeWidth={s.width} strokeLinecap="round" strokeLinejoin="round"/>)}
 </svg>;
}
type InkSnapshot={read:()=>InkDocument};
const snapshot=(document:InkDocument):InkSnapshot=>({read:()=>document});
const deferredInk=(previous:InkSnapshot,map:(document:InkDocument)=>InkDocument):InkSnapshot=>{
 let cached:InkDocument|undefined;return {read:()=>cached ??=map(previous.read())};
};
export function useInk(initial:InkDocument,onCommit?:((next:InkDocument,before:InkDocument)=>Promise<unknown>)) {
 const [document,setDocument]=useState(initial),[tool,setTool]=useState<'pen'|'eraser'>('pen'),[error,setError]=useState('');
 const acknowledged=useRef(initial);
 const current=useRef(initial),active=useRef<{id:number;before:InkDocument;stroke:InkStroke;tool:'pen'|'eraser';target:Element;stop?:()=>void;onActive?:((value:boolean)=>void)|undefined}|null>(null);
 const past=useRef<InkSnapshot[]>([]),future=useRef<InkSnapshot[]>([]),writes=useRef<Promise<unknown>>(Promise.resolve()),pending=useRef(0);
 const [revision,setRevision]=useState(0);
 const incoming=JSON.stringify(initial),seenIncoming=useRef(incoming);
 useEffect(()=>{
  if(incoming===seenIncoming.current || active.current || pending.current || error)return;
  seenIncoming.current=incoming;
  if(JSON.stringify(current.current)!==incoming){const previous=current.current;past.current=past.current.map(doc=>deferredInk(doc,value=>mergeInk(value,previous,initial)));future.current=future.current.map(doc=>deferredInk(doc,value=>mergeInk(value,previous,initial)));current.current=initial;setDocument(initial);}
  acknowledged.current=initial;
 },[incoming,revision,error]);
 const show=(value:InkDocument)=>{current.current=value;setDocument(value);};
 const save=(next:InkDocument,before:InkDocument)=>{
  if(!onCommit)return;pending.current++;
  writes.current=writes.current.catch(()=>undefined).then(()=>onCommit(next,acknowledged.current)).then(()=>{acknowledged.current=next;setError('');}).catch(e=>{setError(String(e));throw e;}).finally(()=>{pending.current--;setRevision(v=>v+1);});
  void writes.current.catch(()=>undefined);
 };
 const change=(next:InkDocument,before=current.current)=>{past.current.push(snapshot(before));if(past.current.length>40)past.current.shift();future.current=[];show(next);setRevision(v=>v+1);save(next,before);};
 const undo=()=>{if(active.current)return;const previous=past.current.pop()?.read();if(!previous)return;const before=current.current;future.current.push(snapshot(before));show(previous);setRevision(v=>v+1);save(previous,before);};
 const redo=()=>{if(active.current)return;const next=future.current.pop()?.read();if(!next)return;const before=current.current;past.current.push(snapshot(before));show(next);setRevision(v=>v+1);save(next,before);};
 const finish=()=>{
  const a=active.current;if(!a)return;active.current=null;a.stop?.();
  if(a.target.hasPointerCapture(a.id))a.target.releasePointerCapture(a.id);
  if(JSON.stringify(a.before)!==JSON.stringify(current.current))change(current.current,a.before);
  a.onActive?.(false);
 };
 useEffect(()=>()=>{const a=active.current;active.current=null;a?.stop?.();if(a?.target.hasPointerCapture(a.id))a.target.releasePointerCapture(a.id);},[]);
 const handlers=(point:(e:ReactPointerEvent)=>{x:number;y:number},onActive:((value:boolean)=>void)|undefined=undefined,button=0)=>({
  onPointerDown:(e:ReactPointerEvent)=>{
   if(e.button!==button)return;e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);
   const at=point(e),p={x:Math.round(at.x*100)/100,y:Math.round(at.y*100)/100},before=current.current,stroke:InkStroke={id:crypto.randomUUID(),color:PENCIL_COLOR,width:PENCIL_WIDTH,points:[p,{x:p.x+.01,y:p.y+.01}]};
   active.current={id:e.pointerId,before,stroke,tool,target:e.currentTarget,onActive};
   active.current.stop=watchDragRelease(e.currentTarget,e.pointerId,e.buttons,finish);onActive?.(true);
   show(tool==='pen'?{...before,strokes:[...before.strokes,stroke]}:{...before,strokes:before.strokes.filter(s=>!hitInk(s,p,10))});
  },
  onPointerMove:(e:ReactPointerEvent)=>{
   const a=active.current;if(!a || e.pointerId!==a.id)return;e.preventDefault();e.stopPropagation();const at=point(e),p={x:Math.round(at.x*100)/100,y:Math.round(at.y*100)/100};
   if(a.tool==='pen'){
    const last=a.stroke.points.at(-1)!;if(Math.hypot(p.x-last.x,p.y-last.y)<.6 || a.stroke.points.length>=20000)return;
    a.stroke={...a.stroke,points:[...a.stroke.points,p]};show({...current.current,strokes:current.current.strokes.map(s=>s.id===a.stroke.id?a.stroke:s)});
   }else show({...current.current,strokes:current.current.strokes.filter(s=>!hitInk(s,p,10))});
  },
  onPointerUp:(e:ReactPointerEvent)=>{if(active.current?.id!==e.pointerId)return;e.stopPropagation();finish();},
  onPointerCancel:(e:ReactPointerEvent)=>{const a=active.current;if(a && e.pointerId===a.id){active.current=null;a.stop?.();if(a.target.hasPointerCapture(a.id))a.target.releasePointerCapture(a.id);show(a.before);a.onActive?.(false);}},
  onLostPointerCapture:finish,
 });
 const rebase=(map:(doc:InkDocument)=>InkDocument)=>{const before=current.current,oldPast=past.current,oldFuture=future.current,oldAcknowledged=acknowledged.current;acknowledged.current=map(acknowledged.current);show(map(before));past.current=past.current.map(doc=>deferredInk(doc,map));future.current=future.current.map(doc=>deferredInk(doc,map));return()=>{show(before);past.current=oldPast;future.current=oldFuture;acknowledged.current=oldAcknowledged;};};
 return {getDocument:()=>current.current,retry:()=>save(current.current,acknowledged.current),document,tool,setTool,undo,redo,canUndo:past.current.length>0,canRedo:future.current.length>0,handlers,rebase,error,flush:()=>{finish();return writes.current;},isBusy:()=>!!active.current || pending.current>0,revision};
}
export type InkController=ReturnType<typeof useInk>;
export type DoodleTool='pen'|'eraser'|null;
export function InkPill({mode,toggle}:{mode:DoodleTool;toggle:(tool:'pen'|'eraser')=>void}) {
 return <div className="ink-pill" onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}>
  <button type="button" aria-pressed={mode==='pen'} aria-label={uiText('drawing.pen')} title={uiText('drawing.pencilHint')} onClick={()=>toggle('pen')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 13 13 4l3 3-9 9-4 1zM11 6l3 3"/></svg></button>
  <button type="button" aria-pressed={mode==='eraser'} aria-label={uiText('drawing.eraser')} title={uiText('drawing.eraserHint')} onClick={()=>toggle('eraser')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 12 7-8 6 5-7 8H7zM8 8l6 5M10 17h7"/></svg></button>
 </div>;
}
/** Consume the exit click before card drag/title/body handlers can run. */
export function useDoodleMode(host:RefObject<HTMLElement|null>,ink:InkController,prepare?:()=>Promise<unknown>,entered?:()=>void,exited?:()=>void) {
 const [mode,setMode]=useState<DoodleTool>(null),[error,setError]=useState('');
 const active=useRef<DoodleTool>(null),activation=useRef(0);
 const leave=()=>{activation.current++;active.current=null;setMode(null);exited?.();void ink.flush().catch(e=>setError(String(e)));};
 const toggle=(tool:'pen'|'eraser')=>{
  if(active.current===tool){leave();return;}
  const token=++activation.current;
  void (prepare?.() ?? Promise.resolve()).then(()=>{if(token!==activation.current)return;ink.setTool(tool);active.current=tool;setMode(tool);setError('');entered?.();}).catch(e=>setError(String(e)));
 };
 useEffect(()=>{
  if(!mode)return;
  const exitClick=(event:MouseEvent)=>{
   if(event.button!==0 || !active.current || !(event.target instanceof Element) || event.target.closest('.ink-pill'))return;
   const card=host.current?.closest('.proto-note > .card,.workspace-main');
   if(!(card ?? host.current)?.contains(event.target))return;
   event.preventDefault();event.stopImmediatePropagation();leave();
   document.documentElement.dataset.doodleExiting='true';
   const swallow=(click:MouseEvent)=>{click.preventDefault();click.stopImmediatePropagation();};
   const reset=()=>{delete document.documentElement.dataset.doodleExiting;document.removeEventListener('click',swallow,true);document.removeEventListener('mouseup',up,true);document.removeEventListener('pointerdown',reset,true);window.removeEventListener('blur',reset);};
   const up=(release:MouseEvent)=>{if(!release.buttons)setTimeout(reset,0);};
   document.addEventListener('click',swallow,{capture:true,once:true});document.addEventListener('mouseup',up,true);document.addEventListener('pointerdown',reset,{capture:true,once:true});window.addEventListener('blur',reset,{once:true});
  };
  const keys=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();leave();}
   else if((event.ctrlKey || event.metaKey) && ['z','y'].includes(event.key.toLowerCase())){event.preventDefault();event.stopPropagation();if(event.shiftKey || event.key.toLowerCase()==='y')ink.redo();else ink.undo();}
  };
  document.addEventListener('pointerdown',exitClick,true);document.addEventListener('mousedown',exitClick,true);document.addEventListener('keydown',keys,true);
  return()=>{document.removeEventListener('pointerdown',exitClick,true);document.removeEventListener('mousedown',exitClick,true);document.removeEventListener('keydown',keys,true);};
 },[mode]);
 return {mode,toggle,error};
}
