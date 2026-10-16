import {passedDragThreshold,swallowDragClick} from './pointer-gesture.ts';
import {cardIdFromLabel,newExpansionId} from '../core/window-identity.ts';
import {windowDragIntent,extractOnDesktop} from './window-drag-intent.ts';
import {createWindowDragSession} from './window-drag-session.ts';
import {orderedDrop,listNestingTarget,showOrderedMarker,type OrderedDrop} from './ordered-drop.ts';
import {uiText} from '../i18n/text.ts';
import {watchDragRelease} from './drag-release.ts';
import {canvasBindings,canvasGesture,type CanvasDragAction} from '../core/canvas-drag.ts';
import {canvasPick,dispatchCanvasDrag,type CanvasPick} from './canvas-events.ts';
import {insideMergeArea,onScrollbar,dropPosition} from './drag-geometry.ts';
import {isBoard} from '../core/renderer.ts';
import {isInSubtree,parentIndexOf} from '../core/indexes.ts';
import {dropIndex} from './drop-index.ts';
import {emit,listen} from '@tauri-apps/api/event';
import {invoke} from '@tauri-apps/api/core';
import {cursorPosition,type Window} from '@tauri-apps/api/window';
import type {PointerEvent as ReactPointerEvent} from 'react';
import type {WorkspaceController,Request} from './controller.ts';
import {DESKTOP_CHANNEL as CHANNEL} from './desktop-mirror.ts';
import type {cardWindowService} from './card-window-service.ts';
import type {connectWindowPositions} from './window-position-sync.ts';
type Drag = { id: string; source: string; target: string | null; x: number; y: number; screenX: number; screenY: number; phase: 'move' | 'drop' | 'cancel' | 'probe'; token?: string; pick?: CanvasPick; reparent?: boolean; positionOnly?:boolean };
/** Native motion and cross-window drops; identity and intent are resolved by shared helpers. */
export async function connectDesktopDrag({controller:c,label,window:w,windows,request,positionSync,dragState,clearCanvasDrag,errorHandler}:{
 controller:WorkspaceController;label:string;window:Window;windows:ReturnType<typeof cardWindowService>;
 request:(action:Request|null)=>Promise<{createdId?:string;createdWindowId?:string}>;positionSync:Awaited<ReturnType<typeof connectWindowPositions>>;
 dragState:{fixed:boolean};clearCanvasDrag:(phase:'cancel'|'leave')=>void;errorHandler:(message:string)=>void;
}){
 const unlisteners:(()=>void)[]=[];
 let dragGeneration=0,stopActiveDrag:(()=>Promise<void>)|null=null;
  let highlighted: Element | null = null;
  let sortMarker:HTMLElement|null=null;
  const probes = new Map<string, (valid: boolean) => void>();
  unlisteners.push(await listen<{ token: string; valid: boolean; to: string }>(`${CHANNEL}:hit`, e => {
    if (e.payload.to === label) probes.get(e.payload.token)?.(e.payload.valid);
  }));
  const clearHighlight = (): void => { highlighted?.classList.remove('native-drop-target'); highlighted = null;sortMarker?.remove();sortMarker=null; };
  const dropElement = (drag: Drag): {element:HTMLElement;parent:string|null;gap:number;sort:OrderedDrop|null} | null => {
    if(drag.id.startsWith('ext-'))return null;
    if(drag.reparent && drag.source===label && cardIdFromLabel(drag.source)===drag.id)return null;
    const hit = document.elementFromPoint(drag.x, drag.y);
    const sorting=orderedDrop(hit,drag.x,drag.y,!!drag.reparent);
    if (!sorting && hit?.closest('button')) return null;
    const canvas=hit?.closest<HTMLElement>('.canvas-viewport');
    const oldParent = parentIndexOf(c.session.state).get(drag.id) ?? null;
    const element = sorting?.element ?? (canvas && canvas.dataset.dropParent===oldParent ? canvas : hit?.closest<HTMLElement>('[data-drop-parent]'));
    if (!element) return null;
    if (!sorting && !element.classList.contains('canvas-viewport') && !element.classList.contains('insertion-zone') && listNestingTarget(hit,drag.x,drag.y)!==element && !insideMergeArea(element.getBoundingClientRect(), drag.x, drag.y)) return null;
    const parent = element.dataset.dropParent || null;
    if(drag.positionOnly && (drag.source!==label || parent===null))return null;
    if (parent && (parent === drag.id || isInSubtree(c.session.state, drag.id, parent))) return null;
    if (parent && isBoard(c.session.state, parent) && parent !== oldParent) return null;
    if (oldParent && isBoard(c.session.state, oldParent) && oldParent !== parent) return null;
    if (parent === null && !drag.reparent && cardIdFromLabel(drag.source)===drag.id && !c.session.state.cards.get(drag.id)?.isPrefab) return null;
    return {element,parent,gap:sorting?.gap ?? Number(element.dataset.dropIndex ?? (parent?c.session.state.children.get(parent)?.length ?? 0:0)),sort:sorting};
  };
  unlisteners.push(await listen<Drag>(`${CHANNEL}:drag`, e => {
    const drag = e.payload; clearHighlight();
    if(drag.phase==='cancel') clearCanvasDrag('cancel');
    else if(drag.phase!=='probe') clearCanvasDrag('leave');
    if (drag.phase !== "probe") document.documentElement.classList.toggle("card-dragging", drag.phase === "move");
    if (drag.phase === 'cancel' || drag.target !== label) return;
    const destination = dropElement(drag);
    if (drag.phase === 'probe') {
      void emit(`${CHANNEL}:hit`, { token: drag.token, valid: !!destination, to: drag.source }); return;
    }
    if (!destination) return;
    const {element,parent}=destination;
    if(element.classList.contains('canvas-viewport') && (drag.phase==='move' || drag.phase==='drop')) {
      if(dispatchCanvasDrag(element,{id:drag.id,x:drag.x,y:drag.y,phase:drag.phase,...(drag.pick?{pick:drag.pick}:{})})) return;
    }
    if(destination.sort)sortMarker=showOrderedMarker(destination.sort);
    else {highlighted = element; element.classList.add('native-drop-target');}
    if (drag.phase !== 'drop') return;
    clearHighlight();
    const index = dropIndex(c.session.state, drag.id, parent, destination.gap);
    const position = dropPosition(element, drag.x, drag.y);
    const action: Request = parent === null ? { kind: 'float', id: drag.id } : { kind: 'move', id: drag.id, parent, index, ...position };
    void request(action).catch(error => errorHandler(String(error)));
  }));

  const startDrag = (id: string, event: ReactPointerEvent, mode?: CanvasDragAction): void => {
    if(document.documentElement.dataset.doodleExiting)return;
    const fixed=mode==='window-fixed';
    const targetElement=event.target as HTMLElement;
    const relationHandle=!!targetElement.closest('.reparent-grip');
    const inCanvas=!!targetElement.closest('.canvas-note,.canvas-viewport');
    const combinedGesture=inCanvas && mode!==undefined && canvasGesture(event.button,event.buttons)==='combined';
    const configured=canvasBindings(c.view)[canvasGesture(event.button,event.buttons)];
    if(mode==='pan'){const previous=stopActiveDrag?.() ?? Promise.resolve();const generation=++dragGeneration;void previous.then(()=>{if(generation===dragGeneration)dragState.fixed=false;});clearCanvasDrag('cancel');event.stopPropagation();return;}
    const childBody=!!targetElement.closest('[data-card-id]') && !relationHandle;
    const allowed=childBody && mode===undefined ? event.button===0 : mode!==undefined || (inCanvas && !relationHandle ? configured!=='pan' : event.button===0);
    if(!allowed || onScrollbar(event.target as HTMLElement,event.clientX,event.clientY))return;
    event.stopPropagation();
    const previous=stopActiveDrag?.() ?? Promise.resolve();
    const generation=++dragGeneration;
    const current=()=>generation===dragGeneration;
    if(mode)clearCanvasDrag('cancel');
    const startX = event.clientX, startY = event.clientY;
    const pick = canvasPick(event.target as HTMLElement,event.clientX,event.clientY);
    const captureTarget = event.currentTarget, pointerId = event.pointerId;
    let started = false, cancelled = false, ended=false;
    let stopReleaseWatch=()=>{};
    let ending:Promise<void>=Promise.resolve();
    const {sourceWindow,reparent,positionOnly,movingWindow}=windowDragIntent({label,cardId:id,childBody,relationHandle,mode});
    const windowDrag=movingWindow && label.startsWith('card-')?createWindowDragSession((command,args)=>invoke(command,args),fixed):null;
    const sourceBounds=positionOnly?Promise.all([w.innerPosition(),w.innerSize()]):null;
    // Begin only after the threshold. Native begin freezes any old follow motion;
    // sampling before it would use an origin that can drift while this press waits.
    let origin:Promise<[{x:number;y:number},{x:number;y:number}]>|null=null;
    const motionOrigin=()=>origin??=previous.then(async()=>{
      await windowDrag?.begin();
      return Promise.all([cursorPosition(),w.outerPosition()]);
    });
    const note = document.querySelector('.proto-note > .card');
    const clearHints = (): void => { note?.classList.remove('snap-left','snap-right','snap-top','snap-bottom','merge-ready'); };
    let chain = Promise.resolve();
    let moveFrame:number|null=null, motionStopped=false;
    let motion:Promise<void>=Promise.resolve();
    let latestHints:Record<string,boolean>={};
    let lastMotionPoint:{x:number;y:number}|null=null;
    const scheduleMotion=():void=>{
      if(!movingWindow || motionStopped || moveFrame!==null)return;
      moveFrame=requestAnimationFrame(()=>{
        moveFrame=null;
        motion=(async()=>{
          const initial=await motionOrigin();
          const cursor=await cursorPosition();
          if(motionStopped)return;
          const point={x:initial[1].x+cursor.x-initial[0].x,y:initial[1].y+cursor.y-initial[0].y};
          if(lastMotionPoint?.x===point.x && lastMotionPoint.y===point.y)return;
          dragState.fixed=fixed;
          latestHints=windowDrag?await windowDrag.move(point):await invoke('move_note',{...point,finish:false});
          lastMotionPoint=point;
          if(movingWindow){clearHints();for(const side of ['left','right','top','bottom'])if(latestHints[side])note?.classList.add(`snap-${side}`);}
        })().catch(error=>{motionStopped=true;errorHandler(String(error));void windowDrag?.cancel().catch(error=>errorHandler(String(error)));}).finally(()=>{if(!motionStopped)scheduleMotion();});
      });
    };
    const send = async (phase: 'move' | 'drop' | 'cancel'): Promise<void> => {
      if(cancelled && phase!=='cancel')return;
      const initial = movingWindow && phase!=='cancel' ? await motionOrigin() : origin ? await origin : null;
      const cursor = await cursorPosition();
      if(phase!=='cancel' && (cancelled || !current()))return;
      const position = initial ? { x: initial[1].x + cursor.x - initial[0].x, y: initial[1].y + cursor.y - initial[0].y } : null;
      clearHints();
      if (phase === 'cancel') {
        if(windowDrag)await windowDrag.cancel();
        else if (initial) await invoke('move_note', { x: initial[1].x, y: initial[1].y, finish: false });
        await emit(`${CHANNEL}:drag`, { id, source: label, target: null, x:0,y:0,screenX:cursor.x,screenY:cursor.y,phase } satisfies Drag); return;
      }
      if(movingWindow) {
        if(position && phase==='drop'){if(windowDrag)await windowDrag.move(position,true);else await invoke('move_note',{...position,finish:true});await request({kind:'window-state',windowLabel:label,changes:{operation:'move',position:await w.outerPosition()}});}
        return;
      }
      const hints = latestHints;
      if (position && phase === 'drop') await invoke('move_note', { ...position, finish: false });
      if(positionOnly && sourceBounds){
        const [origin,size]=await sourceBounds;
        const outside=cursor.x<origin.x || cursor.y<origin.y || cursor.x>=origin.x+size.width || cursor.y>=origin.y+size.height;
        if(outside){
          if(phase==='drop'){
            clearCanvasDrag('cancel');
            try{
              const expansionId=newExpansionId(id);
              await request({kind:'window',id:expansionId,open:true});
              await windows.position(expansionId,cursor.x,cursor.y);
            }finally{
              await emit(`${CHANNEL}:drag`,{id,source:label,target:null,x:0,y:0,screenX:cursor.x,screenY:cursor.y,phase:'cancel'} satisfies Drag);
            }
          }
          return;
        }
      }
      const target = await invoke<{ label: string; x: number; y: number } | null>('window_at_point', { x: cursor.x, y: cursor.y, ignoreLabel: sourceWindow && !reparent ? label : null });
      const wire: Drag = { id, source: label, target: target?.label ?? null, x: target?.x ?? 0, y: target?.y ?? 0, screenX: cursor.x, screenY: cursor.y, phase, ...(pick ? {pick} : {}), reparent,positionOnly };
      let valid = false;
      if (target) {
        const token = crypto.randomUUID();
        valid = await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => { probes.delete(token); resolve(false); }, 350);
          probes.set(token, hit => { clearTimeout(timer); probes.delete(token); resolve(hit); });
          void emit(`${CHANNEL}:drag`, { ...wire, phase:'probe', token }).catch(() => { clearTimeout(timer); probes.delete(token); resolve(false); });
        });
      }
      if(cancelled)return;
      if (valid) note?.classList.add('merge-ready');
      else if (phase === 'move') for (const side of ['left','right','top','bottom']) if (hints[side]) note?.classList.add(`snap-${side}`);
      if (phase === 'drop') {
        clearHints();
        if (!valid && position) await invoke('move_note', { ...position, finish: true });
        else if (extractOnDesktop({valid,target,movingWindow})) {
          const result = await request({ kind: 'float', id });
          await windows.position(result.createdWindowId ?? result.createdId ?? id,cursor.x,cursor.y);
        }
      }
      await emit(`${CHANNEL}:drag`, { ...wire, target: valid ? wire.target : null });
    };
    let framePending = false, startedMotion=false;
    const move = (e: PointerEvent): void => {
      if(e.pointerId!==pointerId)return;
      if(combinedGesture && !(e.buttons&4) && (e.buttons&3)!==3){up();return;}
      if (!started && !passedDragThreshold({clientX:startX,clientY:startY},e)) return;
      if (!started) {captureTarget.setPointerCapture?.(pointerId);if(movingWindow)dragState.fixed=fixed;}
      started = true;
      if(movingWindow && !startedMotion){startedMotion=true;scheduleMotion();}
      e.preventDefault();
      document.documentElement.classList.add("card-dragging");
      if (movingWindow || framePending) return;
      framePending = true;
      chain = chain.then(() => send('move')).catch(error => errorHandler(String(error))).finally(() => { framePending = false; });
    };
    const cleanup = (): void => { if(ended)return;ended=true;stopReleaseWatch();motionStopped=true;if(moveFrame!==null){cancelAnimationFrame(moveFrame);moveFrame=null;} document.documentElement.classList.remove("card-dragging"); if (captureTarget.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel); document.removeEventListener('keydown', key); };
    const finish=():void=>{
      if(!current())return;
      if(fixed)void w.outerPosition().then(position=>{if(current())positionSync.resetOrigin(position);}).finally(()=>{if(current())dragState.fixed=false;}).catch(error=>errorHandler(String(error)));
      document.documentElement.classList.remove('card-dragging');void emit(`${CHANNEL}:canvas-end`,{});
    };
    const up = (): void => { if(ended)return;cleanup(); if (started) swallowDragClick(); if (started && !cancelled) ending=Promise.all([chain,motion]).then(() => send('drop')).catch(async error => {errorHandler(String(error));await windowDrag?.cancel().catch(reason=>errorHandler(String(reason)));}).finally(finish); };
    const cancel = (): void => { if(ended)return;cancelled = true; cleanup(); if (started) ending=Promise.all([chain,motion]).then(() => send('cancel')).catch(error => errorHandler(String(error))).finally(finish); };
    stopActiveDrag=()=>{cancelled=true;cleanup();return Promise.all([chain,motion,ending]).then(async()=>{await windowDrag?.cancel();if(current())dragState.fixed=false;});};
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') cancel(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel); document.addEventListener('keydown', key);
    stopReleaseWatch=watchDragRelease(captureTarget,pointerId,!inCanvas && mode!==undefined && event.buttons&2?2:event.buttons,up);
  };
 return {startDrag,dispose:()=>{++dragGeneration;void stopActiveDrag?.().catch(error=>errorHandler(String(error)));unlisteners.forEach(stop=>stop());}};
}
