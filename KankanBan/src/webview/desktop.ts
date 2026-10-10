import {uiText} from '../i18n/text.ts';
import {watchDragRelease} from './drag-release.ts';
import {canvasBindings,canvasGesture,type CanvasDragAction} from '../core/canvas-drag.ts';
import {canvasPick,dispatchCanvasDrag,CANVAS_WINDOW_SHIFT,type CanvasPick} from './canvas-events.ts';
import { insideMergeArea, onScrollbar, dropPosition } from './drag-geometry.ts';
import { isBoard } from '../core/renderer.ts';
import { isInSubtree, parentIndexOf } from '../core/indexes.ts';
import { dropIndex } from './drop-index.ts';
import { emit, listen, type Event as TauriEvent } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { cursorPosition, getCurrentWindow } from '@tauri-apps/api/window';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { WorkspaceController, type Request, type Snapshot } from './controller.ts';
import { syncCardWindows } from './tauri-backend.ts';
import { windowCards } from '../core/windows.ts';
import { prepareEditors } from './drafts.ts';

type Reply = { token: string; to: string; snapshot?: Snapshot; result?: { createdId?: string }; error?: string };
type Wire = { token: string; from: string; request: Request | null };
type Drag = { id: string; source: string; target: string | null; x: number; y: number; screenX: number; screenY: number; phase: 'move' | 'drop' | 'cancel' | 'probe'; token?: string; pick?: CanvasPick; reparent?: boolean };
const CHANNEL = 'kkb:v1';

export async function connectDesktop(c: WorkspaceController, label: string) {
  const main = label === 'main';
  const pending = new Map<string, { resolve: (result: { createdId?: string }) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  const w = getCurrentWindow();
  let remoteRevision = -1;
  let closing = false;
  let errorHandler = (message: string): void => { c.error = message; c.accept(c.snapshot()); };
  const request = async (action: Request | null): Promise<{ createdId?: string }> => {
    if (main) {
      if (action && (action.kind === 'close-all' || action.kind === 'float' || action.kind === 'move' || action.kind === 'canvas-drop' || action.kind === 'delete' || action.kind === 'prefab-sync' || action.kind === 'undo' || action.kind === 'window')) await prepareWindows();
      if (action === null) await c.flush();
      const result = action === null ? {} : await c.execute(action);
      await emit(`${CHANNEL}:snapshot`, c.snapshot());
      const roots = new Set(windowCards(c.session.state));
      const errors = await syncCardWindows(c.view.openWindows.filter(id => id !== '000' && roots.has(id)));
      if (errors.length) errorHandler(errors.join('；'));
      if(action?.kind==='window' && action.open)await invoke('open_card_window',{cardId:action.id});
      return result;
    }
    const token = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(token); reject(new Error(uiText("webview/desktop.text001"))); }, 12000);
      pending.set(token, { resolve, reject, timeout });
      void emit(`${CHANNEL}:request`, { token, from: label, request: action } satisfies Wire).catch(error => {
        clearTimeout(timeout); pending.delete(token); reject(error);
      });
    });
  };
  const unlisteners: (() => void)[] = [];
  let lastWindowPosition = await w.outerPosition();
  let windowScale = await w.scaleFactor();
  let fixedCanvasDrag=false;
  let dragGeneration=0;
  let stopActiveDrag:(()=>Promise<void>)|null=null;
  unlisteners.push(await w.onScaleChanged((event:TauriEvent<{scaleFactor:number}>) => {windowScale=event.payload.scaleFactor;}));
  unlisteners.push(await w.onMoved((event:TauriEvent<{x:number;y:number}>) => {
    const position=event.payload;
    const delta={x:(position.x-lastWindowPosition.x)/windowScale,y:(position.y-lastWindowPosition.y)/windowScale};
    lastWindowPosition=position;
    if(!fixedCanvasDrag)document.dispatchEvent(new CustomEvent(CANVAS_WINDOW_SHIFT,{detail:delta}));
  }));
  const clearCanvasDrag = (phase: 'cancel'|'leave'): void => {
    for(const canvas of document.querySelectorAll<HTMLElement>('.canvas-viewport')) dispatchCanvasDrag(canvas,{id:'',x:0,y:0,phase});
  };
  unlisteners.push(await listen(`${CHANNEL}:canvas-end`,()=>clearCanvasDrag('cancel')));

  if (main) unlisteners.push(await listen<Wire>(`${CHANNEL}:request`, event => {
    const message = event.payload;
    void request(message.request).then(result => emit(`${CHANNEL}:reply`, { token: message.token, to: message.from, result, snapshot: c.snapshot() } satisfies Reply))
      .catch(error => emit(`${CHANNEL}:reply`, { token: message.token, to: message.from, error: String(error) } satisfies Reply));
  }));
  else {
    const accept = (snapshot: Snapshot): void => { if (snapshot.revision >= remoteRevision) { remoteRevision = snapshot.revision; c.accept(snapshot); } };
    unlisteners.push(await listen<Snapshot>(`${CHANNEL}:snapshot`, e => accept(e.payload)));
    unlisteners.push(await listen<Reply>(`${CHANNEL}:reply`, e => {
      const reply = e.payload; if (reply.to !== label) return;
      const waiting = pending.get(reply.token); if (!waiting) return;
      pending.delete(reply.token); clearTimeout(waiting.timeout);
      if (reply.snapshot) accept(reply.snapshot);
      if (reply.error) waiting.reject(new Error(reply.error)); else waiting.resolve(reply.result ?? {});
    }));
    await request(null);
  }

  const flushEditor = async (): Promise<void> => {
    await prepareEditors();
    if (main) await c.flush();
  };
  const acknowledgements = new Map<string, Set<string>>();
  unlisteners.push(await listen<{ token: string }>(`${CHANNEL}:prepare`, e => {
    if (main) return;
    void flushEditor().then(() => emit(`${CHANNEL}:prepared`, { token: e.payload.token, label }))
      .catch(error => errorHandler(String(error)));
  }));
  if (main) unlisteners.push(await listen<{ token: string; label: string }>(`${CHANNEL}:prepared`, e => acknowledgements.get(e.payload.token)?.delete(e.payload.label)));

  const prepareWindows = async (): Promise<void> => {
    await flushEditor();
    const token = crypto.randomUUID();
    const waiting = new Set(await invoke<string[]>('card_window_labels'));
    acknowledgements.set(token, waiting);
    try {
      await emit(`${CHANNEL}:prepare`, { token });
      const deadline = Date.now() + 8000;
      while (waiting.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
      if (waiting.size) throw new Error(uiText("webview/desktop.text002"));
    } finally { acknowledgements.delete(token); }
  };

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await flushEditor();
      if (main) {
        await prepareWindows();
        await c.flush();
        await invoke('finish_exit');
      } else {
        await request({ kind: 'window', id: label.slice(5), open: false });
      }
    } catch (error) { closing = false; errorHandler(String(error)); }
  };
  unlisteners.push(await w.onCloseRequested(event => { event.preventDefault(); void close(); }));

  let highlighted: Element | null = null;
  const probes = new Map<string, (valid: boolean) => void>();
  unlisteners.push(await listen<{ token: string; valid: boolean; to: string }>(`${CHANNEL}:hit`, e => {
    if (e.payload.to === label) probes.get(e.payload.token)?.(e.payload.valid);
  }));
  const clearHighlight = (): void => { highlighted?.classList.remove('native-drop-target'); highlighted = null; };
  const dropElement = (drag: Drag): HTMLElement | null => {
    if(drag.reparent && drag.source===label)return null;
    const hit = document.elementFromPoint(drag.x, drag.y);
    if (hit?.closest('button')) return null;
    const canvas=hit?.closest<HTMLElement>('.canvas-viewport');
    const oldParent = parentIndexOf(c.session.state).get(drag.id) ?? null;
    const element = canvas && canvas.dataset.dropParent===oldParent ? canvas : hit?.closest<HTMLElement>('[data-drop-parent]');
    if (!element) return null;
    if (!element.classList.contains('canvas-viewport') && !element.classList.contains('insertion-zone') && !insideMergeArea(element.getBoundingClientRect(), drag.x, drag.y)) return null;
    const parent = element.dataset.dropParent || null;
    if(drag.reparent && parent===null && !c.session.state.cards.get(drag.id)?.isPrefab)return null;
    if (parent && (parent === drag.id || isInSubtree(c.session.state, drag.id, parent))) return null;
    if (parent && isBoard(c.session.state, parent) && parent !== oldParent) return null;
    if (oldParent && isBoard(c.session.state, oldParent) && oldParent !== parent) return null;
    if (parent === null && drag.source === `card-${drag.id}` && !c.session.state.cards.get(drag.id)?.isPrefab) return null;
    return element;
  };
  unlisteners.push(await listen<Drag>(`${CHANNEL}:drag`, e => {
    const drag = e.payload; clearHighlight();
    if(drag.phase==='cancel') clearCanvasDrag('cancel');
    else if(drag.phase!=='probe') clearCanvasDrag('leave');
    if (drag.phase !== "probe") document.documentElement.classList.toggle("card-dragging", drag.phase === "move");
    if (drag.phase === 'cancel' || drag.target !== label) return;
    const element = dropElement(drag);
    if (drag.phase === 'probe') {
      void emit(`${CHANNEL}:hit`, { token: drag.token, valid: !!element, to: drag.source }); return;
    }
    if (!element) return;
    if(element.classList.contains('canvas-viewport') && (drag.phase==='move' || drag.phase==='drop')) {
      if(dispatchCanvasDrag(element,{id:drag.id,x:drag.x,y:drag.y,phase:drag.phase,...(drag.pick?{pick:drag.pick}:{})})) return;
    }
    highlighted = element; element.classList.add('native-drop-target');
    if (drag.phase !== 'drop') return;
    clearHighlight();
    const parent = element.dataset.dropParent || null;
    const index = dropIndex(c.session.state, drag.id, parent, Number(element.dataset.dropIndex ?? (parent ? c.session.state.children.get(parent)?.length ?? 0 : 0)));
    const position = dropPosition(element, drag.x, drag.y);
    const action: Request = parent === null ? { kind: 'float', id: drag.id } : { kind: 'move', id: drag.id, parent, index, ...position };
    void request(action).catch(error => errorHandler(String(error)));
  }));

  const startDrag = (id: string, event: ReactPointerEvent, mode?: CanvasDragAction): void => {
    if(document.documentElement.dataset.doodleExiting)return;
    const fixed=mode==='window-fixed';
    const combinedGesture=mode!==undefined && canvasGesture(event.button,event.buttons)==='combined';
    const targetElement=event.target as HTMLElement;
    const relationHandle=!!targetElement.closest('.reparent-grip');
    const inCanvas=!!targetElement.closest('.canvas-note,.canvas-viewport');
    const configured=canvasBindings(c.view)[canvasGesture(event.button,event.buttons)];
    if(mode==='pan'){const previous=stopActiveDrag?.() ?? Promise.resolve();const generation=++dragGeneration;void previous.then(()=>{if(generation===dragGeneration)fixedCanvasDrag=false;});clearCanvasDrag('cancel');event.stopPropagation();return;}
    const allowed=mode!==undefined || (inCanvas && !relationHandle ? configured!=='pan' : event.button===0);
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
    const sourceWindow = label === `card-${id}`;
    const reparent = !!(event.target as HTMLElement).closest('.reparent-grip');
    const movingWindow = mode==='window-desktop' || fixed || (sourceWindow && !reparent);
    // Capture the new press immediately; only the window origin waits for old writes.
    const pressCursor=movingWindow?cursorPosition():null;
    const origin = movingWindow ? previous.then(()=>{if(current())fixedCanvasDrag=fixed;return Promise.all([pressCursor!, w.outerPosition()]);}) : null;
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
          const initial=await origin!;
          const cursor=await cursorPosition();
          if(motionStopped)return;
          const point={x:initial[1].x+cursor.x-initial[0].x,y:initial[1].y+cursor.y-initial[0].y};
          if(lastMotionPoint?.x===point.x && lastMotionPoint.y===point.y)return;
          fixedCanvasDrag=fixed;
          latestHints=await invoke('move_note',{...point,finish:false});
          lastMotionPoint=point;
          if(movingWindow){clearHints();for(const side of ['left','right','top','bottom'])if(latestHints[side])note?.classList.add(`snap-${side}`);}
        })().catch(error=>{motionStopped=true;errorHandler(String(error));}).finally(()=>{if(!motionStopped)scheduleMotion();});
      });
    };
    const send = async (phase: 'move' | 'drop' | 'cancel'): Promise<void> => {
      if(cancelled && phase!=='cancel')return;
      const cursor = await cursorPosition();
      const initial = origin ? await origin : null;
      if(phase!=='cancel' && (cancelled || !current()))return;
      const position = initial ? { x: initial[1].x + cursor.x - initial[0].x, y: initial[1].y + cursor.y - initial[0].y } : null;
      clearHints();
      if (phase === 'cancel') {
        if (initial) await invoke('move_note', { x: initial[1].x, y: initial[1].y, finish: false });
        await emit(`${CHANNEL}:drag`, { id, source: label, target: null, x:0,y:0,screenX:cursor.x,screenY:cursor.y,phase } satisfies Drag); return;
      }
      if(movingWindow) {
        if(position && phase==='drop')await invoke('move_note',{...position,finish:true});
        return;
      }
      const hints = latestHints;
      if (position && phase === 'drop') await invoke('move_note', { ...position, finish: false });
      const target = await invoke<{ label: string; x: number; y: number } | null>('window_at_point', { x: cursor.x, y: cursor.y, ignoreLabel: sourceWindow ? label : null });
      const wire: Drag = { id, source: label, target: target?.label ?? null, x: target?.x ?? 0, y: target?.y ?? 0, screenX: cursor.x, screenY: cursor.y, phase, ...(pick ? {pick} : {}), reparent };
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
        else if (!valid && !movingWindow && ((!target && !reparent) || (reparent && !target && c.session.state.cards.get(id)?.isPrefab))) {
          const result = await request({ kind: 'float', id });
          await invoke('position_card_window', { cardId: result.createdId ?? id, x: cursor.x, y: cursor.y });
        }
      }
      await emit(`${CHANNEL}:drag`, { ...wire, target: valid ? wire.target : null });
    };
    let framePending = false, startedMotion=false;
    const move = (e: PointerEvent): void => {
      if(e.pointerId!==pointerId)return;
      if(combinedGesture && !(e.buttons&4) && (e.buttons&3)!==3){up();return;}
      if (!started && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
      if (!started) captureTarget.setPointerCapture?.(pointerId);
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
      if(fixed)void w.outerPosition().then(position=>{if(current())lastWindowPosition=position;}).finally(()=>{if(current())fixedCanvasDrag=false;}).catch(error=>errorHandler(String(error)));
      document.documentElement.classList.remove('card-dragging');void emit(`${CHANNEL}:canvas-end`,{});
    };
    const up = (): void => { if(ended)return;cleanup(); if (started) { const swallow = (e: MouseEvent): void => { e.preventDefault(); e.stopPropagation(); }; document.addEventListener('click', swallow, {capture:true,once:true}); setTimeout(()=>document.removeEventListener('click',swallow,true),0); } if (started && !cancelled) ending=Promise.all([chain,motion]).then(() => send('drop')).catch(error => errorHandler(String(error))).finally(finish); };
    const cancel = (): void => { if(ended)return;cancelled = true; cleanup(); if (started) ending=Promise.all([chain,motion]).then(() => send('cancel')).catch(error => errorHandler(String(error))).finally(finish); };
    stopActiveDrag=()=>{cancelled=true;cleanup();return Promise.all([chain,motion,ending]).then(()=>{if(current())fixedCanvasDrag=false;});};
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') cancel(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel); document.addEventListener('keydown', key);
    stopReleaseWatch=watchDragRelease(captureTarget,pointerId,event.buttons,up);
  };
  const switchWorkspace = async (path: string | null): Promise<void> => {
    if (!main) throw new Error(uiText("webview/desktop.text003"));
    await prepareWindows(); await c.flush();
    await invoke('select_workspace', { path });
    try {await invoke('reload_workspace');}
    catch(error){await request(null);throw error;}
    unlisteners.forEach(dispose=>dispose());
    window.location.reload();
  };
  return { switchWorkspace, request: (action: Request) => request(action), startDrag, close: () => { void close(); },
    restore: () => request(null), dispose: () => unlisteners.forEach(fn => fn()) };
}
