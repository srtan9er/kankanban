import {AddIcon} from './AddIcon.tsx';
import {uiText} from '../i18n/text.ts';
import {CARD_MIN_HEIGHT, CHILD_MIN_WIDTH, CHILD_MIN_HEIGHT} from '../core/layout-metrics.ts';
import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';

export type ChildArea = { width: number; height: number };
export const COLLAPSE_AT = 48;
function resizedAxis(value: number, minimum: number): number {
  if (!Number.isFinite(value)) throw new Error(uiText("webview/CardRegions.text001"));
  return value < minimum / 2 ? 0 : Math.max(minimum, value);
}
export const CHILD_CARD_MIN_HEIGHT = CARD_MIN_HEIGHT;
export const CHILD_BAR_MIN_WIDTH = CHILD_MIN_WIDTH;
// Header, separator spacing, collection padding and native scrollbar clearance.
export const CHILD_BAR_MIN_HEIGHT = CHILD_MIN_HEIGHT;
export function verticalChildArea(width: number): ChildArea {
  const next = resizedAxis(width, CHILD_BAR_MIN_WIDTH);
  return next === 0 ? {width:0,height:0} : {width:next,height:9999};
}
export function horizontalChildArea(height: number): ChildArea {
  const next = resizedAxis(height, CHILD_BAR_MIN_HEIGHT);
  return next === 0 ? {width:0,height:0} : {width:9999,height:next};
}
export function childArea(width: number, height: number): ChildArea {
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(uiText("webview/CardRegions.text001"));
  const w = resizedAxis(width, COLLAPSE_AT), h = resizedAxis(height, COLLAPSE_AT);
  return w === 0 || h === 0 ? {width:0,height:0} : {width:w,height:h};
}

export function CardRegions({ vertical, saved, save, body, children, add }: {
  vertical: boolean; saved?: ChildArea | undefined; save: (area: ChildArea) => void;
  body: ReactNode; children: ReactNode; add: () => void;
}) {
  const defaults = () => ({ width: vertical ? CHILD_BAR_MIN_WIDTH : 9999, height: vertical ? 9999 : CHILD_BAR_MIN_HEIGHT });
  const [size, setSize] = useState<ChildArea>(saved ?? defaults);
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const cleanupResize = useRef<(() => void) | null>(null);
  const currentSize = useRef(size);
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTransition = (): void => {
    if(transitionTimer.current) clearTimeout(transitionTimer.current);
    transitionTimer.current = null;
    if(panel.current) {panel.current.style.transition='';panel.current.classList.remove('child-region-transition');}
  };
  const updateSize = (next: ChildArea): void => {
    const axis = vertical ? 'width' : 'height';
    const before = currentSize.current[axis], after = next[axis];
    if((before === 0) !== (after === 0) && panel.current) {
      stopTransition();
      panel.current.style.transition = `${axis} 140ms ease`;
      panel.current.classList.add('child-region-transition');
      transitionTimer.current = setTimeout(stopTransition,160);
    } else if(before !== after) stopTransition();
    currentSize.current = next;
    setSize(next);
  };
  useEffect(() => () => {cleanupResize.current?.();stopTransition();}, []);
  useEffect(() => { updateSize(saved ?? defaults()); }, [saved?.width, saved?.height, vertical]);
  const hidden = (vertical ? size.width : size.height) === 0;
  const height = hidden ? 0 : Math.max(CHILD_BAR_MIN_HEIGHT, size.height);
  const resize = (event: ReactPointerEvent): void => {
    if (event.button !== 0 || !panel.current || !host.current) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture?.(event.pointerId);
    cleanupResize.current?.();
    const cursorClass = vertical ? "resizing-child-vertical" : "resizing-child-horizontal";
    document.documentElement.classList.add(cursorClass);
    let next = size;
    const move = (e: PointerEvent): void => {
      const available = host.current?.getBoundingClientRect();
      if(!available) return;
      // Use the pointer's actual position, including while the panel is clamped or collapsed.
      const extent = vertical ? available.right - e.clientX : available.bottom - e.clientY;
      const bounded = Math.max(0, Math.min((vertical ? available.width : available.height) - 40, extent));
      next = vertical ? verticalChildArea(bounded) : horizontalChildArea(bounded);
      updateSize(next);
    };
    const clean = (): void => { document.documentElement.classList.remove(cursorClass); cleanupResize.current = null; document.removeEventListener("keydown", key); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel); };
    const up = (): void => { clean(); save(next); };
    const cancel = (): void => { clean(); updateSize(size); };
    const key = (e: KeyboardEvent): void => { if(e.key === "Escape") cancel(); };
    cleanupResize.current = clean; document.addEventListener("keydown", key);
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel);
  };
  return <div ref={host} style={{"--child-card-min-height": `${CHILD_CARD_MIN_HEIGHT}px`} as import("react").CSSProperties} className={`card-regions ${vertical ? 'vertical-regions' : 'horizontal-regions'}`}>
    <div className="card-body-region">{body}</div>
    <div ref={panel} className={`child-region ${hidden ? "child-region-collapsed" : ""}`} style={{ width: vertical ? `min(${hidden ? 0 : Math.max(CHILD_BAR_MIN_WIDTH, size.width)}px, 100%)` : "100%", height: vertical ? "100%" : `min(${height}px, 100%)` }}>
      <button className="child-region-resizer" title={hidden ? (vertical ? uiText("webview/CardRegions.text002") : uiText("webview/CardRegions.text003")) : vertical ? uiText("webview/CardRegions.text004", {arg0: (CHILD_BAR_MIN_WIDTH / 2)}) : uiText("webview/CardRegions.text005", {arg0: (CHILD_BAR_MIN_HEIGHT / 2)})} aria-label={uiText("webview/CardRegions.text006")} onPointerDown={resize}><span aria-hidden="true" className="resize-rails" /></button>
      {children}
    </div>
    <button className="floating-add-card" aria-label={uiText("webview/CardRegions.text007")} title={uiText("webview/CardRegions.text007")} onClick={()=>{if(hidden){const next=defaults();updateSize(next);save(next);}add();}}><AddIcon/></button>
  </div>;
}
