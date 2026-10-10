import {useWindowResize} from './useWindowResize.ts';
import {DrawingBody} from './DrawingBody.tsx';
import {listen,type UnlistenFn} from '@tauri-apps/api/event';
import {uiText} from '../i18n/text.ts';
import {PrefabSyncButtons} from './PrefabSyncButtons.tsx';
import {canvasBindings,type CanvasDragAction,type CanvasDragBindings} from '../core/canvas-drag.ts';
import {useFixedCanvasDrag} from './useFixedCanvasDrag.ts';
import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { CardFields } from '../core/types.ts';
import type { Request } from './controller.ts';
import { isTauri } from './tauri-backend.ts';
import { Drafts, registerEditor } from './drafts.ts';
import { CardRegions, type ChildArea } from './CardRegions.tsx';

export function PrototypeNote({ card, send, close, children, breadcrumb, startDrag, hideBody = false, waterfall = false, canvas = false, vertical = false, ordinary = true, childSize, add, dragBindings = canvasBindings({}) }: {
  dragBindings?: CanvasDragBindings; waterfall?: boolean; canvas?: boolean; hideBody?: boolean; vertical?: boolean; ordinary?: boolean; childSize?: ChildArea | undefined; add: () => void;
  card: CardFields; send: (request: Request) => Promise<{ createdId?: string }>;
  close?: (() => void) | undefined; children: ReactNode; breadcrumb: ReactNode;
  startDrag?: ((id: string, event: ReactPointerEvent, mode?: CanvasDragAction) => void) | undefined;
}) {
  const [editingField, setEditingField] = useState<'title' | 'content' | null>(null);
  const preview = editingField === null;
  const [finishing, setFinishing] = useState(false);
  const finishStarted=useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if(editingField && !finishing) (editingField === 'title' ? titleInput.current : bodyInput.current)?.focus(); }, [editingField, finishing]);
  const enterEdit = (field: 'title' | 'content'): void => {
    if(finishing || editingField === field) return;
    if(preview) {setEditingField(field); return;}
    finishEdit(field);
  };
  const [collapsed, setCollapsed] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [error, setError] = useState('');
  const [title, setTitle] = useState(card.title), [content, setContent] = useState(card.content);
  const drafts = useRef(new Drafts((field, value) => send({ kind: 'edit', id: card.id, field, value })));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushAsync = (): Promise<unknown> => {
    if (timer.current) clearTimeout(timer.current);
    return drafts.current.flush().then(result => { setError(''); return result; }).catch(e => { setError(String(e)); throw e; });
  };
  const finishEdit = (next: 'title' | 'content' | null = null): void => {
    if(finishing || finishStarted.current) return;
    finishStarted.current=true;setFinishing(true);
    void flushAsync().then(()=>setEditingField(next)).catch(()=>undefined).finally(()=>{finishStarted.current=false;setFinishing(false);});
  };
  useEffect(() => {
    if(preview) return;
    const outside = (event: MouseEvent): void => {
      if(event.button!==0)return;
      const target = event.target as Node;
      const editor = editingField === 'title' ? titleInput.current : bodyInput.current;
      if(editor?.contains(target)) return;
      const note = titleInput.current?.closest('.proto-note');
      // These controls already save/exit or switch fields through the same transition.
      if(target instanceof Element && note?.contains(target)){
        if(target.closest('.toggle'))return;
        if(!target.closest('button,[data-drawing-surface]')){
          if(target.closest('.title')){finishEdit('title');return;}
          if(target.closest('.preview')){finishEdit('content');return;}
        }
      }
      finishEdit();
    };
    const leaveWindow = (): void => finishEdit();
    document.addEventListener('pointerdown', outside, true);document.addEventListener('mousedown', outside, true); window.addEventListener('blur', leaveWindow);
    return () => {document.removeEventListener('pointerdown', outside, true);document.removeEventListener('mousedown', outside, true); window.removeEventListener('blur', leaveWindow);};
  });
  const flush = (): void => { void flushAsync().catch(() => undefined); };
  const change = (field: 'title' | 'content', value: string): void => {
    (field === 'title' ? setTitle : setContent)(value); drafts.current.set(field, value);
    if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(flush, 200);
  };
  useEffect(() => { if (!drafts.current.has('title')) setTitle(card.title); if (!drafts.current.has('content')) setContent(card.content); }, [card.title, card.content]);
  useEffect(() => {
    const prepare = (event: Event): void => registerEditor(event, flushAsync());
    document.addEventListener('kkb:prepare-close', prepare);
    return () => { document.removeEventListener('kkb:prepare-close', prepare); flush(); };
  }, [card.id]);
  useEffect(() => {
    if(!isTauri())return;
    let disposed=false,unlisten:UnlistenFn|undefined;
    void invoke<{collapsed:boolean;pinned:boolean}|null>('window_preferences').then(p=>{if(p && !disposed){setCollapsed(p.collapsed);setPinned(p.pinned);}}).catch(e=>{if(!disposed)setError(String(e));});
    void listen<{label:string}>('kkb:window-activated',event=>{if(event.payload.label===getCurrentWindow().label){setCollapsed(false);setPinned(true);}}).then(stop=>{if(disposed)stop();else unlisten=stop;}).catch(e=>{if(!disposed)setError(String(e));});
    return()=>{disposed=true;unlisten?.();};
  }, []);
  const mode = (key: 'collapsed' | 'pinned', value: boolean): void => {
    if (!isTauri()) { (key === 'collapsed' ? setCollapsed : setPinned)(value); return; }
    void invoke('set_note_mode', { [key]: value }).then(() => (key === 'collapsed' ? setCollapsed : setPinned)(value)).catch(e => setError(String(e)));
  };
  const fixedCanvasDrag=useFixedCanvasDrag(canvas && !!startDrag,dragBindings,(e,mode)=>{flush();startDrag?.(card.id,e,mode);});
  const moveWindow = (event: ReactPointerEvent): void => {
    if (event.button !== (canvas && dragBindings.left==='pan' ? 2 : 0)) return;
    // Navigation changes the displayed card, not the native window identity.
    // The title/body gesture always moves this window; only the grip reparents.
    flush(); startDrag?.(card.id, event, 'window-desktop');
  };
  const resize=useWindowResize(setError);
  return <div className={`proto-note ${canvas ? "canvas-note" : waterfall ? "waterfall-note" : hideBody ? "board-note" : ""}`} data-drop-parent={card.id} onKeyDown={e=>{if(!preview && !e.nativeEvent.isComposing && (e.key==='Escape' || ((e.ctrlKey || e.metaKey) && e.key==='Enter'))){e.preventDefault(); e.stopPropagation(); finishEdit();}}}><div {...fixedCanvasDrag} onPointerDown={e => { if (!(e.target as HTMLElement).closest("button,[data-card-id],[role=separator],[data-drawing-surface]")) moveWindow(e); }} className={`card ${card.isPrefab ? 'prefab' : card.prefabRef ? 'instance' : ''} ${preview ? 'viewing-mode' : `editing-mode editing-${editingField}`} ${error ? 'error' : ''} `}>
    <div className="note-title-row"><button className="reparent-grip" aria-label={uiText("webview/PrototypeNote.text002")} title={uiText("webview/PrototypeNote.text002")} onPointerDown={e=>{if(e.button!==0)return;flush();startDrag?.(card.id,e);}} onClick={e=>e.stopPropagation()} /><input ref={titleInput} readOnly={editingField!=="title"} disabled={finishing} onClick={()=>enterEdit("title")} onPointerDown={e=>{if(editingField==="title")e.stopPropagation();}} className="title" aria-label={uiText("webview/PrototypeNote.text003")} value={title} onChange={e => change('title', e.target.value)} onBlur={flush} />
      <button className="collapse" title={collapsed ? uiText("webview/PrototypeNote.text004") : uiText("webview/PrototypeNote.text005")} onClick={() => mode('collapsed', !collapsed)}>{collapsed ? '▴' : '▾'}</button>
      <button className={`pin ${pinned ? '' : 'off'}`} title={pinned ? uiText("webview/PrototypeNote.text006") : uiText("webview/PrototypeNote.text007")} onClick={() => mode('pinned', !pinned)}>●</button>
      <button className="toggle" aria-label={preview ? uiText("webview/PrototypeNote.text008") : uiText("webview/PrototypeNote.text009")} title={preview ? (hideBody ? uiText("webview/PrototypeNote.text010") : uiText("webview/PrototypeNote.text011")) : uiText("webview/PrototypeNote.text012")} disabled={finishing} onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();preview ? enterEdit(hideBody ? 'title' : 'content') : finishEdit();}} onClick={event=>{if(event.detail===0)preview ? enterEdit(hideBody ? 'title' : 'content') : finishEdit();}}>{preview ? '✎' : '✓'}</button>
      <button className="close" title={uiText("webview/PrototypeNote.text013")} onClick={() => { flush(); close?.(); }}>×</button>
    </div>
    {!collapsed && <><div className="note-breadcrumb">{card.isPrefab && <span className="prefab-badge">{uiText("webview/PrototypeNote.text014")}</span>}{breadcrumb}<PrefabSyncButtons card={card} send={send}/></div>
      {error && <div className="note-error" role="alert">{error}<button onClick={() => { setError(''); flush(); }}>{uiText("webview/PrototypeNote.text015")}</button></div>}
      {!hideBody && ordinary ? <CardRegions vertical={vertical} saved={childSize} save={area=>{void send({kind:'view',id:card.id,childArea:area}).catch(e=>setError(String(e)));}} add={add} body={<div className="body">{editingField !== "content" ? <div className="preview" title={uiText("webview/PrototypeNote.text016")} onClick={e=>{if(!(e.target as HTMLElement).closest("a")) enterEdit("content");}}><DrawingBody key={card.id} doodle={card.doodle ?? null} id={card.id} content={content} placeholder={uiText("webview/PrototypeNote.text017")} send={send} prepare={()=>flushAsync().then(()=>setEditingField(null))}/></div> : <textarea ref={bodyInput} disabled={finishing} onPointerDown={e=>e.stopPropagation()} className="content" aria-label={uiText("webview/PrototypeNote.text018")} placeholder={uiText("webview/PrototypeNote.text017")} value={content} onChange={e => change('content', e.target.value)} onBlur={flush} />}</div>}>{children}</CardRegions> : <>{!hideBody && <div className="body">{editingField !== "content" ? <div className="preview" title={uiText("webview/PrototypeNote.text016")} onClick={e=>{if(!(e.target as HTMLElement).closest("a")) enterEdit("content");}}><DrawingBody key={card.id} doodle={card.doodle ?? null} id={card.id} content={content} placeholder={uiText("webview/PrototypeNote.text017")} send={send} prepare={()=>flushAsync().then(()=>setEditingField(null))}/></div> : <textarea ref={bodyInput} disabled={finishing} onPointerDown={e=>e.stopPropagation()} className="content" aria-label={uiText("webview/PrototypeNote.text018")} placeholder={uiText("webview/PrototypeNote.text017")} value={content} onChange={e => change('content', e.target.value)} onBlur={flush} />}</div>}<div className="note-children">{children}</div>{!canvas && (!hideBody || waterfall) && <button className="floating-add-card" aria-label={uiText("webview/PrototypeNote.text019")} title={uiText("webview/PrototypeNote.text019")} onClick={add}>＋</button>}</>}
      <button className="resize window-resize-handle" title={uiText("webview/PrototypeNote.text020")} onPointerDown={resize} /></>}
  </div></div>;
}

