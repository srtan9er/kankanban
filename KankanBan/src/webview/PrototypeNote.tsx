import {usePressEdit} from './usePressEdit.ts';
import {AddIcon} from './AddIcon.tsx';
import {useContext} from 'react';
import {EditMode} from './edit-mode.ts';
import {useWindowResize} from './useWindowResize.ts';
import {CardBodyEditor,type CardBodyEditorHandle} from './CardBodyEditor.tsx';
import type {BodyEditPoint} from './body-edit-position.ts';
import {onScrollbar} from './drag-geometry.ts';
import {bodyTextHit} from './body-text-hit.ts';
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

export function PrototypeNote({ card, viewId=card.id, send, close, children, breadcrumb, startDrag, extension = false, hideBody = false, waterfall = false, canvas = false, vertical = false, ordinary = true, childSize, add, dragBindings = canvasBindings({}) }: {
  extension?:boolean; dragBindings?: CanvasDragBindings; waterfall?: boolean; canvas?: boolean; hideBody?: boolean; vertical?: boolean; ordinary?: boolean; childSize?: ChildArea | undefined; add: () => void;
  viewId?:string|undefined; card: CardFields; send: (request: Request) => Promise<{ createdId?: string }>;
  close?: (() => void) | undefined; children: ReactNode; breadcrumb: ReactNode;
  startDrag?: ((id: string, event: ReactPointerEvent, mode?: CanvasDragAction) => void) | undefined;
}) {
  const [editingField, setEditingField] = useState<'title' | 'content' | null>(null);
  const {editable,busy:modeBusy,toggle}=useContext(EditMode);
  useEffect(()=>{if(!editable)setEditingField(null);},[editable]);
  const preview = editingField === null;
  const [finishing, setFinishing] = useState(false);
  const finishStarted=useRef(false);
  const pendingField=useRef<'title'|'content'|null|undefined>(undefined);
  const titleInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLDivElement>(null);
  const bodyEditor=useRef<CardBodyEditorHandle>(null);
  useEffect(() => { if(editingField && !finishing){if(editingField==='title')titleInput.current?.focus();else bodyEditor.current?.focus();} }, [editingField, finishing]);
  const enterEdit = (field: 'title' | 'content',point?:BodyEditPoint): void => {
    if(!editable || modeBusy || editingField === field) return;
    if(field==='content')bodyEditor.current?.captureEntry(point);
    if(finishing || finishStarted.current){pendingField.current=field;return;}
    if(preview) {setEditingField(field); return;}
    finishEdit(field);
  };
  const [collapsed, setCollapsed] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState('');
  const [title, setTitle] = useState(card.title), [content, setContent] = useState(card.content);
  const drafts = useRef(new Drafts((field, value,before) => send({ before,kind: 'edit', id: card.id, field, value })));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushAsync = (): Promise<unknown> => {
    if (timer.current) clearTimeout(timer.current);
    return drafts.current.flush().then(result => { setError(''); return result; }).catch(e => { setError(String(e)); throw e; });
  };
  const finishEdit = (next: 'title' | 'content' | null = null): void => {
    if(finishing || finishStarted.current) return;
    if(editingField==='content')bodyEditor.current?.captureExit();
    finishStarted.current=true;setFinishing(true);
    void flushAsync().then(()=>{setEditingField(pendingField.current===undefined?next:pendingField.current);pendingField.current=undefined;}).catch(()=>{pendingField.current=undefined;}).finally(()=>{finishStarted.current=false;setFinishing(false);});
  };
  useEffect(() => {
    if(preview) return;
    const outside = (event: MouseEvent): void => {
      if(event.button===2){
        const note=titleInput.current?.closest('.proto-note');
        if(note?.querySelector('.image-placement[data-selected=true],.doodle-layer[data-active=true],[data-doodle-active=true]'))return;
        event.preventDefault();pendingField.current=null;finishEdit();return;
      }
      if(event.button!==0)return;
      const target = event.target as Node;
      const editor = editingField === 'title' ? titleInput.current : bodyInput.current;
      if(editor?.contains(target)) return;
      const pane=editingField==='content'?editor?.closest<HTMLElement>('.card-body-editor'):null;
      if(pane?.contains(target) && onScrollbar(pane,event.clientX,event.clientY))return;
      if(target instanceof Element && target.closest('.viewport-ink-toolbar'))return;
      const note = titleInput.current?.closest('.proto-note');
      // These controls already save/exit or switch fields through the same transition.
      if(target instanceof Element && note?.contains(target)){
        if(target.closest('.toggle'))return;
      }
      finishEdit();
    };
    const leaveWindow = (): void => {if(!document.documentElement.dataset.bodyFileDialog)finishEdit();};
    document.addEventListener('pointerdown', outside, true);document.addEventListener('mousedown', outside, true); window.addEventListener('blur', leaveWindow);
    return () => {document.removeEventListener('pointerdown', outside, true);document.removeEventListener('mousedown', outside, true); window.removeEventListener('blur', leaveWindow);};
  });
  const flush = (): void => { void flushAsync().catch(() => undefined); };
  const change = (field: 'title' | 'content', value: string): void => {
    (field === 'title' ? setTitle : setContent)(value); drafts.current.set(field, value,field==='title'?title:content);
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
    void listen<{label:string}>('kkb:window-activated',event=>{if(event.payload.label===getCurrentWindow().label){setCollapsed(false);}}).then(stop=>{if(disposed)stop();else unlisten=stop;}).catch(e=>{if(!disposed)setError(String(e));});
    return()=>{disposed=true;unlisten?.();};
  }, []);
  const mode = (key: 'collapsed' | 'pinned', value: boolean): void => {
    if (!isTauri()) { (key === 'collapsed' ? setCollapsed : setPinned)(value); return; }
    void invoke('set_note_mode', { [key]: value }).then(() => {(key === 'collapsed' ? setCollapsed : setPinned)(value);document.dispatchEvent(new CustomEvent('kkb:window-operation',{detail:{operation:'mode',key,value}}));}).catch(e => setError(String(e)));
  };
  const fixedCanvasDrag=useFixedCanvasDrag(canvas && !!startDrag,dragBindings,(e,mode)=>{flush();startDrag?.(card.id,e,mode);});
  const rightPointer=useRef<number|null>(null);
  useEffect(()=>{const reset=()=>{rightPointer.current=null;};window.addEventListener('blur',reset);return()=>window.removeEventListener('blur',reset);},[]);
  const rightWindowDrag=(event:ReactPointerEvent):void=>{
    if(canvas || event.button!==2 && !(event.buttons&2) || rightPointer.current===event.pointerId)return;
    rightPointer.current=event.pointerId;event.preventDefault();event.stopPropagation();flush();startDrag?.(card.id,event,'window-desktop');
  };
  const moveWindow = (event: ReactPointerEvent): void => {
    if (event.button !== (canvas && dragBindings.left==='pan' ? 2 : 0)) return;
    // Navigation changes the displayed card, not the native window identity.
    // The title/body gesture always moves this window; only the grip reparents.
    flush(); startDrag?.(card.id, event, 'window-desktop');
  };
  const resize=useWindowResize(setError);
  const editPress=usePressEdit('note',enterEdit);
  const documentBody=<div className="body"><CardBodyEditor ref={bodyEditor} id={card.id} content={content} images={card.images ?? []} doodle={card.doodle} editing={editingField==='content'} editorRef={bodyInput} disabled={finishing} onChange={value=>change('content',value)} onBlur={flush} onRequestEdit={()=>enterEdit('content')} flush={flushAsync} prepare={async()=>{bodyEditor.current?.captureExit();await flushAsync();setEditingField(null);}} send={send}/></div>;
  return <div {...editPress} data-scroll-owner={`card:${card.id}`} className={`proto-note ${extension ? "extension-note" : ""} ${canvas ? "canvas-note" : waterfall ? "waterfall-note" : hideBody ? "board-note" : ""}`} data-drop-parent={editable && !extension?card.id:undefined} onKeyDown={e=>{if(!preview && !e.nativeEvent.isComposing && (e.key==='Escape' || ((e.ctrlKey || e.metaKey) && e.key==='Enter'))){e.preventDefault(); e.stopPropagation(); finishEdit();}}}><div {...fixedCanvasDrag} onPointerDownCapture={e=>{if(canvas)fixedCanvasDrag.onPointerDownCapture(e);else rightWindowDrag(e);}} onPointerMoveCapture={e=>{if(canvas)fixedCanvasDrag.onPointerMoveCapture(e);else if(e.buttons&2)rightWindowDrag(e);}} onPointerUpCapture={e=>{fixedCanvasDrag.onPointerUpCapture();if(!(e.buttons&2))rightPointer.current=null;}} onPointerCancelCapture={()=>{fixedCanvasDrag.onPointerCancelCapture();rightPointer.current=null;}} onPointerDown={e => { if (!bodyTextHit(e.target as Element) && !(e.target as HTMLElement).closest("button,[data-card-id],[role=separator],[data-drawing-surface]")) moveWindow(e); }} className={`card ${card.isPrefab ? 'prefab' : card.prefabRef ? 'instance' : ''} ${preview ? 'viewing-mode' : `editing-mode editing-${editingField}`} ${error ? 'error' : ''} `}>
    <div className="note-title-row">{!extension && <button className="reparent-grip" aria-label={uiText("webview/PrototypeNote.text002")} title={uiText("webview/PrototypeNote.text002")} onPointerDown={e=>{if(!editable || e.button!==0)return;flush();startDrag?.(card.id,e);}} onClick={e=>e.stopPropagation()} />}<input ref={titleInput} readOnly={editingField!=="title"} disabled={finishing} onPointerDown={e=>{if(editingField==="title"&&e.button===0)e.stopPropagation();else if(e.button===0)e.preventDefault();}} className="title" aria-label={uiText("webview/PrototypeNote.text003")} value={title} onChange={e => change('title', e.target.value)} onBlur={flush} />
      <button className="collapse" title={collapsed ? uiText("webview/PrototypeNote.text004") : uiText("webview/PrototypeNote.text005")} onClick={() => mode('collapsed', !collapsed)}>{collapsed ? '▴' : '▾'}</button>
      <button className={`pin ${pinned ? '' : 'off'}`} title={pinned ? uiText("webview/PrototypeNote.text006") : uiText("webview/PrototypeNote.text007")} onClick={() => mode('pinned', !pinned)}>●</button>
      {!extension && <button className="toggle" aria-label={uiText(editable?'webview/PrototypeNote.browseMode':'webview/PrototypeNote.editMode')} title={uiText(editable?'webview/PrototypeNote.browseMode':'webview/PrototypeNote.editMode')} aria-pressed={editable} disabled={finishing || modeBusy} onClick={()=>{if(editingField==='content')bodyEditor.current?.captureExit();toggle?.();}}>{editable ? '✎' : '◉'}</button>}
      <button className="close" title={uiText("webview/PrototypeNote.text013")} onClick={() => { flush(); close?.(); }}>×</button>
    </div>
    {!collapsed && <><div className="note-breadcrumb">{card.isPrefab && <span className="prefab-badge">{uiText("webview/PrototypeNote.text014")}</span>}{breadcrumb}{!extension && <button className="share-card-button" title={uiText("share.export")} aria-label={uiText("share.export")} onClick={()=>void flushAsync().then(()=>send({kind:"share-export",id:card.id})).catch(error=>setError(String(error)))}>↗</button>}<PrefabSyncButtons card={card} send={send}/></div>
      {error && <div className="note-error" role="alert">{error}<button onClick={() => { setError(''); flush(); }}>{uiText("webview/PrototypeNote.text015")}</button></div>}
      {!hideBody && ordinary ? <CardRegions vertical={vertical} saved={childSize} save={area=>{void send({kind:'view',id:viewId,cardId:card.id,layout:vertical?'ordered':'plain',childArea:area}).catch(e=>setError(String(e)));}} add={add} body={documentBody}>{children}</CardRegions> : <>{!hideBody && documentBody}<div className="note-children">{children}</div>{!canvas && (!hideBody || waterfall) && <button className="floating-add-card" aria-label={uiText("webview/PrototypeNote.text019")} title={uiText("webview/PrototypeNote.text019")} onClick={add}><AddIcon/></button>}</>}
      <button className="resize window-resize-handle" title={uiText("webview/PrototypeNote.text020")} onPointerDown={resize} /></>}
  </div></div>;
}

