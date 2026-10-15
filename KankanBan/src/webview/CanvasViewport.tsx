import {useContext} from 'react';
import {EditMode} from './edit-mode.ts';
import {ViewportInkToolbar} from './ViewportInkToolbar.tsx';
import {AddIcon} from './AddIcon.tsx';
import {inkPeriodEntries,projectInkCanvas,type InkDocument} from '../core/drawing.ts';
import {useInk,useDoodleMode,InkPill,InkPicture} from './Ink.tsx';
import {uiText} from '../i18n/text.ts';
import {watchDragRelease} from './drag-release.ts';
import {CANVAS_PAN_START} from './useFixedCanvasDrag.ts';
import {canvasGesture,type CanvasDragBindings} from '../core/canvas-drag.ts';
import {registerEditor} from './drafts.ts';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode,type PointerEvent as ReactPointerEvent} from 'react';
import type {PlaneEntry} from '../core/types.ts';
import {CARD_MIN_WIDTH,CARD_MIN_HEIGHT} from '../core/layout-metrics.ts';
import {planePeriod,positiveModulo,rebasePlane,type Point,type PlaneSize} from '../core/plane-geometry.ts';
import {CANVAS_DRAG_EVENT,CANVAS_WINDOW_SHIFT,canvasPick,type CanvasDrag,type CanvasPick} from './canvas-events.ts';

type Preview={id:string;point:Point;entries:PlaneEntry[];period:PlaneSize;offset:Point;inkShift:Point};
type LocalDrag={id:string;pick:CanvasPick;start:Point;moved:boolean};
export function CanvasViewport({parent,entries,visibleIds,renderCard,onCommit,onCreate,onRebase,nativeDrag,dragBindings,drawing,onDrawing}: {
 drawing:InkDocument;onDrawing:(next:InkDocument,before:InkDocument)=>Promise<unknown>;
 dragBindings:CanvasDragBindings;
 onCreate:(x:number,y:number)=>void;
 onRebase:(offset:Point,period:PlaneSize,viewport:PlaneSize)=>Promise<unknown>;
 parent:string;entries:PlaneEntry[];visibleIds:Set<string>;renderCard:(id:string)=>ReactNode;
 onCommit:(id:string,x:number,y:number,w:number,h:number,period:PlaneSize)=>Promise<unknown>;nativeDrag:boolean;
}) {
 const {editable}=useContext(EditMode);
 const ink=useInk(drawing,(next,before)=>onDrawing({...next,width:latest.current.period.width,height:latest.current.period.height},before));
 const paintOrigin=useRef({x:0,y:0});
 const viewport=useRef<HTMLDivElement>(null);
 const mode=useDoodleMode(viewport,ink,undefined,()=>{settleView();frozenPeriod.current=latest.current.period;},()=>{void ink.flush().then(()=>scheduleNormalize(0)).catch(reason=>setError(String(reason)));});
 const drawingMode=editable && mode.mode!==null;
 useEffect(()=>{if(!editable && mode.mode)mode.toggle(mode.mode);},[editable,mode.mode]);
 const [,setOffset]=useState<Point>({x:0,y:0});
 const offsetRef=useRef<Point>({x:0,y:0});
 const surface=useRef<HTMLDivElement>(null);
 const [zoom,setZoom]=useState(1);
 const [rebasing,setRebasing]=useState<PlaneEntry[]|null>(null);
 const rebaseFlight=useRef<Promise<unknown>|null>(null);
 const rebaseTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const wheelInput=useRef<{scale:number;x:number;y:number}|null>(null);
 const wheelFrame=useRef<number|null>(null);
 const processWheelRef=useRef<()=>void>(()=>{});
 const frozenPeriod=useRef<PlaneSize|null>(null);
 const liveCoordinates=useRef<PlaneEntry[]>([]);
 const normalizeRef=useRef<(force?:boolean)=>Promise<unknown>>(()=>Promise.resolve());
 const zoomRef=useRef(1);
 const viewFrame=useRef<number|null>(null);
 const renderedCell=useRef({x:0,y:0});
 const previewRef=useRef<Preview|null>(null);
 const [extent,setExtent]=useState<PlaneSize>({width:1,height:1});
 const [preview,setPreview]=useState<Preview|null>(null);
 const local=useRef<LocalDrag|null>(null);
 const cleanup=useRef<(()=>void)|null>(null);
 const inkDocument=useRef(ink.document);inkDocument.current=ink.document;
 const [error,setError]=useState('');
 const pending=useRef(false);
 const logicalExtent={width:extent.width/zoom,height:extent.height/zoom};
 const baseEntries=rebasing ?? entries;
 const period=frozenPeriod.current ?? planePeriod([...baseEntries,...inkPeriodEntries(baseEntries,ink.document)],logicalExtent);
 const latest=useRef({entries:baseEntries,extent,period,onCommit,onRebase});
 latest.current={entries:baseEntries,extent,period,onCommit,onRebase};
 const updateCoordinates=():void=>{
  liveCoordinates.current=projectInkCanvas(latest.current.entries,inkDocument.current,{x:offsetRef.current.x/zoomRef.current,y:offsetRef.current.y/zoomRef.current},latest.current.period,{width:latest.current.extent.width/zoomRef.current,height:latest.current.extent.height/zoomRef.current},false).entries;
 };
 const scheduleNormalize=(delay=240):void=>{
  if(rebaseTimer.current)clearTimeout(rebaseTimer.current);
  rebaseTimer.current=setTimeout(()=>{rebaseTimer.current=null;void normalizeRef.current().catch(reason=>setError(String(reason)));},delay);
 };
 normalizeRef.current=async(force=false)=>{
  if((drawingMode && !force) || ink.isBusy())return;
  if(rebaseFlight.current)return rebaseFlight.current;
  if(pending.current || local.current || cleanup.current)return;
  const before=latest.current.entries,at={...offsetRef.current};
  const oldPeriod=latest.current.period;
  const projected=projectInkCanvas(before,ink.document,{x:at.x/zoomRef.current,y:at.y/zoomRef.current},oldPeriod,logicalExtent);
  const next=projected.entries,projectedInk=projected.document;liveCoordinates.current=next;
  const inkMoved=JSON.stringify(projectedInk.strokes)!==JSON.stringify(ink.document.strokes) || JSON.stringify(projectedInk.groups)!==JSON.stringify(ink.document.groups);
  frozenPeriod.current=null;
  if(!inkMoved && (!before.length || next.every((e,i)=>Math.abs(e.x-before[i]!.x)<1e-7 && Math.abs(e.y-before[i]!.y)<1e-7))){
   viewport.current?.classList.remove('canvas-easing');
   offsetRef.current={x:0,y:0};setOffset({x:0,y:0});return;
  }
  viewport.current?.classList.remove('canvas-easing');
  offsetRef.current={x:0,y:0};setRebasing(next);
  const restoreInk=ink.rebase(doc=>projectInkCanvas(before,doc,{x:at.x/zoomRef.current,y:at.y/zoomRef.current},oldPeriod,logicalExtent).document);
  let failed=false;
  const task=latest.current.onRebase({x:at.x/zoomRef.current,y:at.y/zoomRef.current},oldPeriod,{width:latest.current.extent.width/zoomRef.current,height:latest.current.extent.height/zoomRef.current}).then(()=>{setError('');setRebasing(null);}).catch(reason=>{
   failed=true;restoreInk();
   offsetRef.current={x:offsetRef.current.x+at.x,y:offsetRef.current.y+at.y};setRebasing(null);throw reason;
  }).finally(()=>{rebaseFlight.current=null;if(!failed && (offsetRef.current.x || offsetRef.current.y))scheduleNormalize();});
  rebaseFlight.current=task;return task;
 };
 const paintView=():void=>{
  const value=previewRef.current?.offset ?? offsetRef.current;
  if(surface.current)surface.current.style.transform=`translate3d(${value.x}px,${value.y}px,0) scale(${zoomRef.current})`;
  if(viewport.current){viewport.current.dataset.canvasPanX=String(value.x);viewport.current.dataset.canvasPanY=String(value.y);viewport.current.dataset.canvasZoom=String(zoomRef.current);}
 };
 const show=(value:Preview|null):void=>{previewRef.current=value;setPreview(value);};
 const moveView=(value:Point,ease=false):void=>{
  viewport.current?.classList.toggle('canvas-easing',ease);
  offsetRef.current=value;
  if(viewFrame.current!==null)return;
  viewFrame.current=requestAnimationFrame(()=>{
   viewFrame.current=null;paintView();updateCoordinates();scheduleNormalize();
   const p=latest.current.period,at=offsetRef.current;
   const cell={x:Math.floor(-at.x/(p.width*zoomRef.current)),y:Math.floor(-at.y/(p.height*zoomRef.current))};
   if(cell.x!==renderedCell.current.x || cell.y!==renderedCell.current.y)setOffset({...at});
  });
 };
 // Freeze an in-flight CSS transition at its visible pose before direct manipulation.
 const settleView=():void=>{
  if(!surface.current || !viewport.current?.classList.contains('canvas-easing'))return;
  const matrix=new DOMMatrixReadOnly(getComputedStyle(surface.current).transform);
  offsetRef.current={x:matrix.m41,y:matrix.m42};zoomRef.current=matrix.a;
  viewport.current.classList.remove('canvas-easing');setZoom(matrix.a);paintView();updateCoordinates();scheduleNormalize();
 };
 const scheduleWheel=():void=>{
  if(wheelFrame.current!==null)return;
  wheelFrame.current=requestAnimationFrame(()=>{wheelFrame.current=null;processWheelRef.current();});
 };
 processWheelRef.current=()=>{
  const input=wheelInput.current;wheelInput.current=null;
  const element=viewport.current;if(!input || !element || !surface.current)return;
  const rect=element.getBoundingClientRect(),pointer={x:input.x-rect.left,y:input.y-rect.top};
  const matrix=new DOMMatrixReadOnly(getComputedStyle(surface.current).transform);
  const scale=matrix.a || 1;
  const world={x:(pointer.x-matrix.m41)/scale,y:(pointer.y-matrix.m42)/scale};
  frozenPeriod.current=null;
  zoomRef.current=input.scale;
  moveView({x:pointer.x-world.x*input.scale,y:pointer.y-world.y*input.scale},true);
  setZoom(input.scale);
 };
 useEffect(()=>{
  const element=viewport.current;if(!element)return;
  const wheel=(event:WheelEvent):void=>{
   if((event.target as Element).closest('button,input,select,.ink-tools'))return;
   event.preventDefault();event.stopPropagation();
   if(pending.current || local.current || cleanup.current || previewRef.current)return;
   const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?element.clientHeight:1);
   if(!delta)return;
   const previous=wheelInput.current?.scale ?? zoomRef.current;
   const next=Math.max(.25,Math.min(3,previous*Math.exp(-Math.max(-240,Math.min(240,delta))*.002)));
   if(next===previous)return;
   wheelInput.current={scale:next,x:event.clientX,y:event.clientY};scheduleWheel();
  };
  element.addEventListener('wheel',wheel,{passive:false});
  return()=>element.removeEventListener('wheel',wheel);
 });
 useLayoutEffect(()=>{paintView();updateCoordinates();});
 useEffect(()=>{
  const prepare=(event:Event):void=>{registerEditor(event,ink.flush().then(()=>normalizeRef.current(true)));};
  document.addEventListener('kkb:prepare-close',prepare);
  return()=>document.removeEventListener('kkb:prepare-close',prepare);
 },[]);
 useEffect(()=>{scheduleNormalize();},[extent.width,extent.height]);
 useEffect(()=>{
  const element=viewport.current;if(!element)return;
  const measure=()=>{
   const next={width:Math.max(1,element.clientWidth),height:Math.max(1,element.clientHeight)};
   const previous=latest.current.extent;
   if(next.width===previous.width && next.height===previous.height)return;
   if(previous.width>1 && previous.height>1 && !frozenPeriod.current)frozenPeriod.current=latest.current.period;
   setExtent(next);
  };
  measure();const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(measure):null;
  observer?.observe(element);window.addEventListener('resize',measure);
  return()=>{observer?.disconnect();window.removeEventListener('resize',measure);cleanup.current?.();wheelInput.current=null;if(wheelFrame.current!==null)cancelAnimationFrame(wheelFrame.current);if(rebaseTimer.current)clearTimeout(rebaseTimer.current);if(viewFrame.current!==null)cancelAnimationFrame(viewFrame.current);};
 },[]);
 const calculate=(drag:CanvasDrag):Preview|null=>{
  const element=viewport.current;if(!element)return null;
  const rect=element.getBoundingClientRect(), base=offsetRef.current, data=latest.current;
  const scale=zoomRef.current;
  const world={x:(drag.x-rect.left-base.x)/scale,y:(drag.y-rect.top-base.y)/scale};
  const own=local.current?.id===drag.id?local.current:null;
  const pick=own?.pick ?? drag.pick;
  const tileX=own?own.pick.tileX:Math.floor(world.x/data.period.width);
  const tileY=own?own.pick.tileY:Math.floor(world.y/data.period.height);
  const oldPeriod=own?{width:own.pick.periodWidth,height:own.pick.periodHeight}:data.period;
  const point={x:(own?world.x-tileX*oldPeriod.width:positiveModulo(world.x,oldPeriod.width))-(pick?.grabX ?? 0),
   y:(own?world.y-tileY*oldPeriod.height:positiveModulo(world.y,oldPeriod.height))-(pick?.grabY ?? 0)};
  const rebased=rebasePlane(data.entries,drag.id,point,{width:pick?.width ?? 220,height:pick?.height ?? 120});
  const nextPeriod=planePeriod([...rebased.entries,...inkPeriodEntries(rebased.entries,{...ink.document,strokes:ink.document.strokes.map(stroke=>({...stroke,points:stroke.points.map(p=>({x:p.x+rebased.shift.x,y:p.y+rebased.shift.y}))}))})],{width:data.extent.width/scale,height:data.extent.height/scale});
  return {id:drag.id,point,entries:rebased.entries,period:nextPeriod,inkShift:rebased.shift,
   offset:{x:base.x+scale*(-rebased.shift.x+tileX*(oldPeriod.width-nextPeriod.width)),
    y:base.y+scale*(-rebased.shift.y+tileY*(oldPeriod.height-nextPeriod.height))}};
 };
 const commit=(drag:CanvasDrag):void=>{
  if(pending.current)return;
  const next=calculate(drag);if(!next)return;
  pending.current=true;show(next);setError('');
  const moved=next.entries.find(entry=>entry.id===drag.id)!;
  void latest.current.onCommit(drag.id,next.point.x,next.point.y,moved.w,moved.h,latest.current.period).then(()=>{
   moveView(next.offset);show(null);local.current=null;
  }).catch(reason=>{show(null);local.current=null;setError(String(reason));}).finally(()=>{pending.current=false;});
 };
 useEffect(()=>{
  const element=viewport.current;if(!element)return;
  const receive=(event:Event):void=>{
   if(!editable)return;
   const drag=(event as CustomEvent<CanvasDrag>).detail;
   event.preventDefault();
   if(drag.phase==='leave'){if(!local.current && !pending.current)show(null);return;}
   if(drag.phase==='cancel'){settleView();cleanup.current?.();if(!pending.current){show(null);local.current=null;}return;}
   if(drag.phase==='move' || drag.phase==='drop')settleView();
   if(drag.phase==='drop'){commit(drag);return;}
   if(!local.current && !pending.current)show(calculate(drag));
  };
  const shifted=(event:Event):void=>{
   const delta=(event as CustomEvent<Point>).detail;
   moveView({x:offsetRef.current.x-delta.x,y:offsetRef.current.y-delta.y},true);
  };
  element.addEventListener(CANVAS_DRAG_EVENT,receive);
  document.addEventListener(CANVAS_WINDOW_SHIFT,shifted);
  return()=>{element.removeEventListener(CANVAS_DRAG_EVENT,receive);document.removeEventListener(CANVAS_WINDOW_SHIFT,shifted);};
 });
 const begin=(event:ReactPointerEvent<HTMLDivElement>):boolean=>{
  if(drawingMode || (event.target as Element).closest('[data-drawing-surface]'))return false;
  if(pending.current)return false;
  wheelInput.current=null;
  settleView();
  const target=event.target as HTMLElement, card=target.closest<HTMLElement>('.canvas-card');
  if(target.closest('button'))return false;
  const pan=(!card || event.button!==0) && dragBindings[canvasGesture(event.button,event.buttons)]==='pan';
  if(!editable && !pan)return false;
  if(!pan && rebaseFlight.current)return false;
  if(pan && rebaseTimer.current){clearTimeout(rebaseTimer.current);rebaseTimer.current=null;}
  if(!pan && (event.button!==0 && event.button!==2 || !card || target.closest('button')))return false;
  const pick=canvasPick(target,event.clientX,event.clientY), id=card?.dataset.canvasCard;
  if(!pan && (!pick || !id))return false;
  if(pan || !nativeDrag){event.preventDefault();event.stopPropagation();}
  cleanup.current?.();
  const handle=viewport.current!,pointerId=event.pointerId,start={x:event.clientX,y:event.clientY},origin=offsetRef.current;
  let moved=false,ended=false;
  let panPointer={...start};
  let stopReleaseWatch=()=>{};
  let lastPointer=event.nativeEvent;
  if(!pan)local.current={id:id!,pick:pick!,start,moved:false};
  const move=(e:PointerEvent):void=>{
   if(e.pointerId!==pointerId)return;
   lastPointer=e;
   const dx=e.clientX-start.x,dy=e.clientY-start.y;
   if(!moved && Math.hypot(dx,dy)<(pan?3:6))return;
   if(!moved && (pan || !nativeDrag))handle.setPointerCapture?.(pointerId);
   moved=true;e.preventDefault();
   if(!nativeDrag && !pan)document.documentElement.classList.add('card-dragging');
   if(pan){document.documentElement.classList.add('canvas-panning');moveView({x:offsetRef.current.x+e.clientX-panPointer.x,y:offsetRef.current.y+e.clientY-panPointer.y});panPointer={x:e.clientX,y:e.clientY};return;}
   if(local.current)local.current.moved=true;
   const rect=handle.getBoundingClientRect();
   if(e.clientX<rect.left || e.clientX>rect.right || e.clientY<rect.top || e.clientY>rect.bottom){show(null);return;}
   show(calculate({id:id!,x:e.clientX,y:e.clientY,pick:pick!,phase:'move'}));
  };
  const clean=():void=>{
   ended=true;stopReleaseWatch();
   document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);
   document.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',key);
   if((pan || !nativeDrag) && handle.hasPointerCapture?.(pointerId))handle.releasePointerCapture(pointerId);
   document.documentElement.classList.remove('canvas-panning');
   if(!nativeDrag)document.documentElement.classList.remove('card-dragging');cleanup.current=null;
  };
  const up=(e:PointerEvent):void=>{
   if(ended || e.pointerId!==pointerId)return;clean();
   if(pan)scheduleNormalize(240);
   if(!pan && moved && !nativeDrag)commit({id:id!,x:e.clientX,y:e.clientY,pick:pick!,phase:'drop'});
   else if(!pan && !moved)local.current=null;
   if(moved && (pan || !nativeDrag)){
    const swallow=(click:MouseEvent)=>{click.preventDefault();click.stopPropagation();};
    document.addEventListener('click',swallow,{capture:true,once:true});setTimeout(()=>document.removeEventListener('click',swallow,true),0);
   }
  };
  const cancel=():void=>{if(ended)return;clean();if(pan)moveView({x:offsetRef.current.x-panPointer.x+start.x,y:offsetRef.current.y-panPointer.y+start.y});else {local.current=null;show(null);}};
  const key=(e:KeyboardEvent):void=>{if(e.key==='Escape')cancel();};
  cleanup.current=clean;document.addEventListener('pointermove',move,{passive:false});document.addEventListener('pointerup',up);
  document.addEventListener('pointercancel',cancel);document.addEventListener('keydown',key);
  if(pan || !nativeDrag)stopReleaseWatch=watchDragRelease(handle,pointerId,event.buttons,()=>up(lastPointer));
  return true;
 };
 useEffect(()=>{
  const element=viewport.current;if(!element)return;
  const pan=(event:Event)=>{if(begin((event as CustomEvent<ReactPointerEvent<HTMLDivElement>>).detail))event.preventDefault();};
  element.addEventListener(CANVAS_PAN_START,pan);
  return()=>element.removeEventListener(CANVAS_PAN_START,pan);
 });
 const shown=preview?.entries ?? baseEntries, tile=preview?.period ?? period, view=preview?.offset ?? offsetRef.current;
 renderedCell.current={x:Math.floor(-view.x/(tile.width*zoom)),y:Math.floor(-view.y/(tile.height*zoom))};
 const shownInk=preview?{...ink.document,strokes:ink.document.strokes.map(s=>({...s,points:s.points.map(p=>({x:p.x+preview.inkShift.x,y:p.y+preview.inkShift.y}))}))}:ink.document;
 const tiles:ReactNode[]=[];
 const firstX=Math.floor(-view.x/(tile.width*zoom))-1,lastX=Math.floor((extent.width-view.x)/(tile.width*zoom))+1;
 const firstY=Math.floor(-view.y/(tile.height*zoom))-1,lastY=Math.floor((extent.height-view.y)/(tile.height*zoom))+1;
 for(let y=firstY;y<=lastY;y++)for(let x=firstX;x<=lastX;x++) {
  tiles.push(<div className="canvas-tile" key={`${x}:${y}`} style={{left:x*tile.width,top:y*tile.height,width:tile.width,height:tile.height}}>
   <div className="canvas-ink"><InkPicture document={shownInk} width={tile.width} height={tile.height}/></div>
   {shown.filter(e=>visibleIds.has(e.id)||e.id===preview?.id).map(e=><div className={`canvas-card ${preview?.id===e.id?'canvas-moving-card':''}`}
    key={e.id} data-canvas-card={e.id} data-tile-x={x} data-tile-y={y}
    style={{left:e.x,top:e.y,width:Math.max(CARD_MIN_WIDTH,e.w),height:Math.max(CARD_MIN_HEIGHT,e.h),zIndex:e.z}}>{renderCard(e.id)}</div>)}
  </div>);
 }
 return <div ref={viewport} className="canvas-viewport" data-doodle-active={drawingMode} data-drop-parent={editable?parent:undefined} data-drop-index={editable?entries.length:undefined}
  data-canvas-zoom={zoom} data-canvas-pan-x={view.x} data-canvas-pan-y={view.y} data-canvas-period-width={tile.width} data-canvas-period-height={tile.height}
  onPointerDownCapture={begin} onDragStartCapture={e=>{if(!nativeDrag && local.current)e.preventDefault();}}
  onContextMenuCapture={e=>{e.preventDefault();e.stopPropagation();}} onAuxClick={e=>{e.preventDefault();e.stopPropagation();}}
  onDragOver={e=>{e.preventDefault();e.stopPropagation();}}
  onDrop={e=>{e.preventDefault();e.stopPropagation();const id=e.dataTransfer.getData('application/x-kkb-card');if(id)commit({id,x:e.clientX,y:e.clientY,phase:'drop'});}}>
  <div ref={surface} className="canvas-surface" style={{transform:`translate3d(${view.x}px,${view.y}px,0) scale(${zoom})`}}>{tiles}</div>
  {drawingMode && <div className="canvas-ink-input" data-drawing-surface="true" {...ink.handlers(event=>{
   const rect=viewport.current!.getBoundingClientRect(),matrix=new DOMMatrixReadOnly(getComputedStyle(surface.current!).transform);
   const world=new DOMPoint(event.clientX-rect.left,event.clientY-rect.top).matrixTransform(matrix.inverse());
   if(event.type==='pointerdown')paintOrigin.current={x:Math.floor(world.x/tile.width)*tile.width,y:Math.floor(world.y/tile.height)*tile.height};
   return {x:world.x-paintOrigin.current.x,y:world.y-paintOrigin.current.y};
  },undefined,2)}/> }
  {editable && <ViewportInkToolbar anchor={viewport}><InkPill mode={mode.mode} toggle={mode.toggle}/></ViewportInkToolbar>}
  {!entries.length && !ink.document.strokes.length && !drawingMode && !preview && <div className="canvas-empty">{uiText("webview/CanvasViewport.text002")}</div>}
  <button disabled={drawingMode} className="floating-add-card" aria-label={uiText("webview/CanvasViewport.text003")} title={uiText("webview/CanvasViewport.text003")} onClick={()=>onCreate(positiveModulo((extent.width/2-offsetRef.current.x)/zoomRef.current,period.width),positiveModulo((extent.height/2-offsetRef.current.y)/zoomRef.current,period.height))}><AddIcon/></button>
  {(error || ink.error) && <div className="canvas-error" role="alert">{error || ink.error}</div>}
 </div>;
}
