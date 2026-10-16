import {themeRuntime} from '../themes/runtime.ts';
import {ThemeSettings} from './ThemeSettings.tsx';
import {usePressEdit} from './usePressEdit.ts';
import {McpSettings} from './McpSettings.tsx';
import {ExtensionManager} from './ExtensionManager.tsx';
import {ExtensionWindow} from './ExtensionWindow.tsx';
import {extensionId} from '../extensions/registry.ts';
import {newExpansionId,windowAnchor} from '../core/window-identity.ts';
import {ChildPreview} from './ChildPreview.tsx';
import {EditMode} from './edit-mode.ts';
import {WorkspaceHistoryButton} from './WorkspaceHistoryButton.tsx';
import {navigationTarget} from './navigation.ts';
import {AddIcon} from './AddIcon.tsx';
import {orderedDrop,showOrderedMarker} from './ordered-drop.ts';
import {useScrollMemory} from './scroll-memory.ts';
import {useManagerDrag} from './useManagerDrag.ts';
import {useWindowResize} from './useWindowResize.ts';
import {CardBodyEditor,type CardBodyEditorHandle} from './CardBodyEditor.tsx';
import type {BodyEditPoint} from './body-edit-position.ts';
import {MarkdownEditor} from './MarkdownEditor.tsx';
import {ImageGallery,ImageWorkspace} from './ImageGallery.tsx';
import {useImageInput,type ImageInsertion} from './useImageInput.ts';
import {cardImagePreview,type ImageImportInput} from './image-input.ts';
import {emptyInk,discardLegacyInk} from '../core/drawing.ts';
import {MasonryGrid} from './MasonryGrid.tsx';
import {uiText} from '../i18n/text.ts';
import {BreadcrumbTrail} from './BreadcrumbTrail.tsx';
import {PrefabSyncButtons} from './PrefabSyncButtons.tsx';
import {canvasBindings,canvasDragOptions,type CanvasDragAction} from '../core/canvas-drag.ts';
import {useFixedCanvasDrag} from './useFixedCanvasDrag.ts';
import {DEFAULT_CARD_RADIUS,MAX_CARD_RADIUS} from '../core/view-state.ts';
import {CanvasViewport} from './CanvasViewport.tsx';
import {dropPosition,onScrollbar} from './drag-geometry.ts';
import {layoutVariables} from '../core/layout-metrics.ts';
import {savedChildArea} from '../core/layout-sizes.ts';
import { CardList } from './CardList.tsx';
import { CardRegions } from './CardRegions.tsx';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri-backend.ts';
import { dropIndex } from './drop-index.ts';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import type { Layout, CardFields } from '../core/types.ts';
import { parentIndexOf, isInSubtree } from '../core/indexes.ts';
import { desktopCards } from '../core/windows.ts';
import { rendererOf } from '../core/renderer.ts';
import { isBuiltin } from '../core/builtins.ts';
import { subtreeSize } from '../core/workspace.ts';
import { WorkspaceController, type Request } from './controller.ts';
import { PrototypeNote } from './PrototypeNote.tsx';
import { registerEditor, prepareEditors } from './drafts.ts';

const layouts: [Layout, string][] = [['plain', uiText("webview/WorkspaceApp.text001")], ['ordered', uiText("webview/WorkspaceApp.text002")], ['grid', uiText("webview/WorkspaceApp.text003")], ['plane', uiText("webview/WorkspaceApp.text004")], ['columns', uiText("webview/WorkspaceApp.text005")]];
const names: Record<string, string> = { manager: uiText("webview/WorkspaceApp.text006"), '001': uiText("webview/WorkspaceApp.text007"), '002': uiText("webview/WorkspaceApp.text008"), '003': uiText("webview/WorkspaceApp.text009") };
export type DragTarget = { parent: string | null; index: number; x?: number; y?: number };
type EditorTarget={id:string;field:'title'|'content';point?:BodyEditPoint|undefined;entryCaptured?:boolean};
export type WorkspaceAppProps = {
  controller: WorkspaceController;
  cardId?: string;
  windowId?: string;
  request?: (request: Request) => Promise<{ createdId?: string }>;
  startDrag?: (id: string, event: ReactPointerEvent, mode?: CanvasDragAction) => void;
  close?: () => void;
  switchWorkspace?: (path: string | null) => Promise<void>;
};

export function WorkspaceApp({ controller: c, cardId, windowId=cardId, request, startDrag, close, switchWorkspace }: WorkspaceAppProps) {
  useSyncExternalStore(c.subscribe, c.getRevision, c.getRevision);
  useScrollMemory(JSON.stringify([c.session.root,windowId ?? "main"]));
  const storedFocus=cardId?c.view.windows[windowId!]?.focusId ?? cardId:'manager';
  const allowedFocus=navigationTarget(c.session.state,storedFocus,storedFocus);
  const [location, setLocation] = useState(allowedFocus);
  useEffect(()=>{if(cardId)setLocation(allowedFocus);},[cardId,storedFocus,allowedFocus]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; field: 'title' | 'content'; title: string; content: string; originalTitle: string; originalContent: string } | null>(null);
  const editingRef=useRef(editing);editingRef.current=editing;
  const editorFlight=useRef<Promise<void>|null>(null),editorTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const editorFinish=useRef<Promise<void>|null>(null),pendingEditor=useRef<EditorTarget|null>(null);
  const bodyEditor=useRef<CardBodyEditorHandle>(null),bodyInput=useRef<HTMLDivElement>(null);
  const [savingEditor, setSavingEditor] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [presentation, setPresentation] = useState<string | null>(null);
  const [presentationSource, setPresentationSource] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [editable,setEditable]=useState(true),[modeBusy,setModeBusy]=useState(false);
  const toggleEditMode=()=>{if(modeBusy)return;setModeBusy(true);void (async()=>{await prepareEditors();await commitAsync();await c.flush();setEditable(value=>!value);})().catch(error=>setError(String(error))).finally(()=>setModeBusy(false));};
  const resizeWindow=useWindowResize(setError);
  const dragManager=useManagerDrag(!cardId,setError);
  const [workspaceBusy,setWorkspaceBusy]=useState(false);
  const switchRecentWorkspace=async(path:string):Promise<void>=>{if(workspaceBusy || !switchWorkspace || path===c.session.root)return;setWorkspaceBusy(true);try{await switchWorkspace(path);}catch(error){setError(String(error));}finally{setWorkspaceBusy(false);}};
  const chooseWorkspace=async():Promise<void>=>{if(workspaceBusy)return;setWorkspaceBusy(true);try{const path=await invoke<string|null>('choose_workspace_folder');if(path!==null && switchWorkspace)await switchWorkspace(path);}catch(error){setError(String(error));}finally{setWorkspaceBusy(false);}};
  const clearWorkspace=async():Promise<void>=>{if(workspaceBusy || !switchWorkspace)return;setWorkspaceBusy(true);try{await switchWorkspace(null);}catch(error){setError(String(error));}finally{setWorkspaceBusy(false);}};

  const [signature,setSignature]=useState(c.view.userSignature ?? '');
  const [panel, setPanel] = useState<'cards' | 'settings' | 'extensions'>('cards');
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState('');
  const htmlSortMarker=useRef<HTMLElement|null>(null);
  const clearSortMarker=()=>{htmlSortMarker.current?.remove();htmlSortMarker.current=null;};
  useEffect(()=>{document.addEventListener('dragend',clearSortMarker);return()=>{document.removeEventListener('dragend',clearSortMarker);clearSortMarker();};},[]);
  const theme=c.view.skin ?? 'light';
  const dragBindings=canvasBindings(c.view);
  const cardRadius=c.view.cardRadius ?? DEFAULT_CARD_RADIUS;
  const state = c.session.state;
  const roots = ['001','002','003',...desktopCards(state).filter(id => !isBuiltin(id))].filter(id=>state.cards.has(id) && !state.cards.get(id)?.deleted);
  const card = state.cards.get(location);
  const alive = card && !card.deleted ? card : undefined;
  const storedLayout = alive ? rendererOf(state, alive.id) : 'plain';
  const currentLayout = storedLayout === 'tabs' ? 'plain' : storedLayout === 'library' ? 'grid' : storedLayout;
  const ordinary = ['plain','ordered','tabs'].includes(currentLayout);
  const inlineEditing=!!(!cardId && ordinary && alive && editing?.id===alive.id && editing.field==='content');
  useEffect(()=>{
    const draft=editingRef.current;if(!alive || draft?.id!==alive.id)return;
    // Import/MCP updates can land while the inline editor stays mounted. Only
    // acknowledged, clean fields may adopt their new value and save baseline.
    const next={...draft,...(draft.title===draft.originalTitle?{title:alive.title,originalTitle:alive.title}:{}),...(draft.content===draft.originalContent?{content:alive.content,originalContent:alive.content}:{})};
    if(next.title!==draft.title || next.originalTitle!==draft.originalTitle || next.content!==draft.content || next.originalContent!==draft.originalContent){editingRef.current=next;setEditing(next);}
  },[alive?.id,alive?.title,alive?.content]);
  const canvasView = currentLayout === 'plane' && panel === 'cards';
  const boardView = currentLayout === 'columns' && panel === 'cards';
  useEffect(() => {
    if (isTauri()) void invoke('set_board_view', { board: boardView }).catch(e => setError(String(e)));
  }, [boardView]);
  const parents = parentIndexOf(state);
  const titleOf = (id: string): string => names[id] ?? state.cards.get(id)?.title ?? uiText("webview/WorkspaceApp.text010");
  const send = async (action: Request): Promise<{ createdId?: string }> => {
    setError('');
    try {const command=action.kind==='window' && action.open?{...action,id:newExpansionId(navigationTarget(state,location,windowAnchor(action.id)))}:action;return await (request ? request(command) : c.execute(command)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); throw e; }
  };
  const fire = (action: Request): void => { void send(action).catch(() => undefined); };
  const acceptImages=async(inputs:ImageImportInput[],position?:ImageInsertion):Promise<void>=>{
    await prepareEditors();
    let id=editing?.id ?? alive?.id ?? (selected && !isBuiltin(selected)?selected:null);
    if(!id){const made=await send({kind:'create',parent:null});id=made.createdId ?? null;if(id)setSelected(id);}
    if(id)await send({kind:'images-import',id,inputs,...position});
  };
  const imageOver=useImageInput(editable && panel==='cards' && (!alive || ordinary),acceptImages,setError);
  const openCard = (id:string):void => { setSelected(id); fire({kind:'window',id,open:true}); };
  const activateCard = (id:string):void => { if(cardId)navigate(id); else openCard(id); };
  const navigate = (id: string): void => {
    id=navigationTarget(state,location,id);
    void prepareEditors().then(() => {
      // A standalone column window cannot adopt its ancestor as its anchor.
      // Reuse/open that board's desktop view instead of having focus reconciled back.
      if(cardId && !isInSubtree(state,cardId,id)){openCard(id);return;}
      editingRef.current=null;setEditing(null);
      setLocation(id); setPanel('cards'); setSelected(null); setMenu(null);
      if (cardId) fire({ kind: 'view', id: windowId!, focus: id });
    }).catch(e => setError(String(e)));
  };
  const openEditor=(target:EditorTarget):void=>{
    const card=c.session.state.cards.get(target.id);if(!card || card.deleted)return;
    if(!target.entryCaptured && !cardId && ordinary && target.id===alive?.id && target.field==='content')bodyEditor.current?.captureEntry(target.point);
    const next={id:target.id,field:target.field,title:card.title,content:card.content,originalTitle:card.title,originalContent:card.content};editingRef.current=next;setEditing(next);
  };
  const beginEdit = (id: string, field: 'title' | 'content',point?:BodyEditPoint): void => {
    if(!editable || modeBusy)return;
    if(editingRef.current?.id===id && editingRef.current.field===field)return;
    const target:EditorTarget={id,field,point};
    if(!cardId && ordinary && id===alive?.id && field==='content'){bodyEditor.current?.captureEntry(point);target.entryCaptured=true;}
    if(editorFinish.current){pendingEditor.current=target;return;}
    if(editingRef.current){pendingEditor.current=target;void commitAsync().catch(()=>undefined);return;}
    openEditor(target);
  };
  const editPress=usePressEdit('manager',(field,point)=>{if(!cardId && alive && !isBuiltin(location))beginEdit(location,field,point);});
  const saveEditorAsync=():Promise<void>=>{
    if(editorTimer.current){clearTimeout(editorTimer.current);editorTimer.current=null;}
    if(editorFlight.current)return editorFlight.current;
    const run=async()=>{for(;;){
      const draft=editingRef.current;if(!draft)return;
      const changed=draft.field==='title'?draft.title!==draft.originalTitle:draft.content!==draft.originalContent;if(!changed)return;
      await send({kind:'edit',id:draft.id,field:draft.field,value:draft.field==='title'?draft.title:draft.content,before:draft.field==='title'?draft.originalTitle:draft.originalContent});
      const current=editingRef.current;if(!current || current.id!==draft.id || current.field!==draft.field)return;
      const next={...current,...(draft.field==='title'?{originalTitle:draft.title}:{originalContent:draft.content})};editingRef.current=next;setEditing(next);
    }};
    const flight=run().finally(()=>{if(editorFlight.current===flight)editorFlight.current=null;});editorFlight.current=flight;return flight;
  };
  const commitAsync = (exit=true): Promise<void> => {
    if(!exit)return saveEditorAsync();
    if(editorFinish.current)return editorFinish.current;
    const draft=editingRef.current;if(!draft)return Promise.resolve();
    if(inlineEditing)bodyEditor.current?.captureExit();setSavingEditor(true);
    const finish=async()=>{
      try{
        await saveEditorAsync();
        if(editingRef.current?.id===draft.id && editingRef.current.field===draft.field){editingRef.current=null;setEditing(null);}
        const next=pendingEditor.current;pendingEditor.current=null;if(next)openEditor(next);
      }catch(error){pendingEditor.current=null;throw error;}
      finally{setSavingEditor(false);if(editorFinish.current===flight)editorFinish.current=null;}
    };
    const flight=finish();editorFinish.current=flight;return flight;
  };
  const commit = (): void => { void commitAsync().catch(() => undefined); };
  const changeInlineContent=(content:string)=>{
    const draft=editingRef.current;if(!draft || draft.field!=='content')return;
    const next={...draft,content};editingRef.current=next;setEditing(next);
    if(editorTimer.current)clearTimeout(editorTimer.current);editorTimer.current=setTimeout(()=>{void saveEditorAsync().catch(()=>undefined);},200);
  };
  useEffect(()=>{if(inlineEditing)bodyEditor.current?.focus();},[inlineEditing]);
  useEffect(()=>()=>{if(editorTimer.current)clearTimeout(editorTimer.current);},[]);
  useEffect(()=>{
    if(!editing)return;
    const outside=(event:MouseEvent)=>{
      if(event.button===2){
        if(document.querySelector('.image-placement[data-selected=true],.doodle-layer[data-active=true],[data-doodle-active=true]'))return;
        event.preventDefault();pendingEditor.current=null;if(!savingEditor)commit();return;
      }
      if(!inlineEditing || event.button!==0 || savingEditor)return;
      const target=event.target as Node,pane=bodyInput.current?.closest<HTMLElement>('.card-body-editor');if(bodyInput.current?.contains(target) || target instanceof Element && target.closest('.viewport-ink-toolbar') || pane?.contains(target) && onScrollbar(pane,event.clientX,event.clientY))return;commit();
    };
    const leave=()=>{if(inlineEditing&&!document.documentElement.dataset.bodyFileDialog)commit();};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('mousedown',outside,true);window.addEventListener('blur',leave);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('mousedown',outside,true);window.removeEventListener('blur',leave);};
  });
  const create = (parent: string | null, layout?: Layout, point?: {x:number;y:number}): void => {
    if(!editable)return;
    void send({ kind: 'create', parent, ...(layout ? { layout } : {}), ...point })
      .then(result => { if (result.createdId) setSelected(result.createdId); }).catch(() => undefined);
  };
  useEffect(()=>{
    document.documentElement.dataset.windowKind=cardId ? 'card' : 'manager';
    return()=>{delete document.documentElement.dataset.windowKind;};
  },[cardId]);
  useLayoutEffect(() => {
    if(!themeRuntime)document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('kkb-theme', theme); } catch { /* optional local preference */ }
  }, [theme]);
  useEffect(() => {
    if (cardId && (!alive || (location !== cardId && !isInSubtree(state, cardId, location)))) setLocation(cardId);
  }, [c.getRevision(), cardId, location]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement;
      if (event.key === 'Escape') { setMenu(null); setPresentation(null); setDeleting(null); if(editing && !savingEditor) commit(); setDragged(null); setDropHint(''); return; }
      if (target.closest('input,textarea,[data-markdown-editor],[contenteditable]') || target.closest('button')) return;
      if (editable && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); fire({ kind: 'undo' }); }
      if (event.key === 'F2' && selected) { event.preventDefault(); beginEdit(selected, 'title'); }
      if (event.key === 'Enter' && selected) { event.preventDefault(); activateCard(selected); }
      if (editable && event.key === 'Delete' && selected && !isBuiltin(selected)) setDeleting(selected);
    };
    const prepare = (event: Event): void => {if(inlineEditing)bodyEditor.current?.captureExit();registerEditor(event, commitAsync(!inlineEditing));};
    document.addEventListener('keydown', onKey);
    document.addEventListener('kkb:prepare-close', prepare);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('kkb:prepare-close', prepare); };
  });

  const drop = (id: string, target: DragTarget): void => {
    if(!editable)return;
    clearSortMarker();setDragged(null); setDropHint('');
    if (target.parent === null) { fire({kind:'float',id}); return; }
    fire({ kind: 'move', id, ...target, index: dropIndex(state, id, target.parent, target.index) });
  };
  const dropProps = (parent: string | null, index: number) => ({
    'data-drop-parent': editable?(parent ?? ''):undefined, 'data-drop-index': editable?index:undefined,
    onDragOver: (e: React.DragEvent<HTMLElement>) => { e.preventDefault(); e.stopPropagation();clearSortMarker();const sorting=orderedDrop(e.target as Element,e.clientX,e.clientY);if(sorting){htmlSortMarker.current=showOrderedMarker(sorting);setDropHint(uiText('webview/WorkspaceApp.siblingDrop'));}else setDropHint(parent ? uiText("webview/WorkspaceApp.text012", {arg0: (titleOf(parent))}) : uiText("webview/WorkspaceApp.text013")); },
    onDragLeave: (e:React.DragEvent<HTMLElement>)=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))clearSortMarker();},
    onDrop: (e: React.DragEvent<HTMLElement>) => { e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData('application/x-kkb-card') || dragged;
      if (id) { const sorting=orderedDrop(e.target as Element,e.clientX,e.clientY,false);drop(id, {parent:sorting?.element.dataset.dropParent ?? parent,index:sorting?.gap ?? index,...dropPosition(e.currentTarget,e.clientX,e.clientY)}); } },
  });
  const compact = (id: string, parent: string | null, index: number, fullPreview = false) => {
    const child = state.cards.get(id); if (!child || child.deleted) return null;
    const count = state.children.get(id)?.length ?? 0;
    const preview=cardImagePreview({...child,content:discardLegacyInk(child.content)});
    const deleteButton=editable && !isBuiltin(id) && <button className="child-delete" title={uiText("webview/WorkspaceApp.deleteSubtree")} aria-label={uiText("webview/WorkspaceApp.deleteSubtree")} onPointerDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();setDeleting(id);}}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg></button>;
    return <div className="card-slot" key={id}>
      <div className="insertion-zone" {...dropProps(parent, index)} />
      <article tabIndex={0} className={`task-card ${preview.imageOnly?'image-card':''} ${selected === id ? 'selected' : ''} ${child.isPrefab ? 'prefab' : child.prefabRef ? 'instance' : ''}`}
        data-card-id={id} {...dropProps(id, count)} draggable={editable && !startDrag && !isBuiltin(id)}
        onDragStart={e=>{if(!editable || isBuiltin(id)){e.preventDefault();return;}e.dataTransfer.setData('application/x-kkb-card',id); e.stopPropagation();}}
        onPointerDown={e=>{if(editable && !isBuiltin(id) && !(e.target as HTMLElement).closest('button')) startDrag?.(id,e);}} onClick={() => setSelected(id)} onDoubleClick={() => activateCard(id)}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}>

        <div className="child-card-content">
        <div className="child-title-row">{editable && !isBuiltin(id) && <button className="reparent-grip child-reparent-grip" aria-label={uiText("webview/PrototypeNote.text002")} title={uiText("webview/PrototypeNote.text002")} onPointerDown={event=>{if(event.button!==0)return;event.stopPropagation();startDrag?.(id,event);}} onClick={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}/>}<h3>{child.title || uiText("webview/WorkspaceApp.text010")}</h3></div>
        {preview.imageOnly?<ImageGallery images={preview.images} names={preview.names} compact removeControl={deleteButton}/>:<ChildPreview text={preview.text.replace(/<(?:image|table)_\d+>|[#*`>]/g,part=>part.startsWith('<')?part:'')} full={fullPreview} deleteButton={deleteButton}/>}
        </div>

      </article>
    </div>;
  };
  const collection = (parent: string, layout: Layout): React.ReactNode => {
    const entries = state.children.get(parent) ?? [];
    const visible = entries.filter(e => !filter || `${state.cards.get(e.id)?.title} ${state.cards.get(e.id)?.content}`.toLowerCase().includes(filter.toLowerCase()));
    if (layout === 'columns') return <div className="kanban-columns">{entries.map(entry => {
      const column = state.cards.get(entry.id)!; const children = state.children.get(entry.id) ?? [];
      return <section className={`kanban-column ${column.isPrefab ? 'prefab' : column.prefabRef ? 'instance' : ''}`} key={entry.id} {...dropProps(entry.id, children.length)}>
        <header className="column-heading"><span className="column-dot" /><button onDoubleClick={() => activateCard(entry.id)} onClick={() => setSelected(entry.id)}>{column.title}</button>{column.isPrefab && <span className="prefab-badge">{uiText("webview/WorkspaceApp.text014")}</span>}<span className="count">{children.length}</span></header>
        <div className="column-cards" {...dropProps(entry.id,children.length)}>{children.filter(e => !filter || state.cards.get(e.id)?.title.toLowerCase().includes(filter.toLowerCase())).map((e, i) => compact(e.id, entry.id, children.findIndex(child => child.id === e.id)))}</div>
        <button className="add-card floating-add-card" aria-label={uiText("webview/WorkspaceApp.text021")} title={uiText("webview/WorkspaceApp.text021")} onClick={() => create(entry.id)}><AddIcon/></button>
      </section>;
    })}</div>;
    if (layout === 'plane') return <CanvasViewport drawing={state.cards.get(parent)!.doodle ?? emptyInk('doodle')} onDrawing={(document,before)=>send({kind:'doodle-update',id:parent,document,before})} dragBindings={dragBindings} key={parent} parent={parent} nativeDrag={!!startDrag}
      entries={entries.map((entry,i)=>'x' in entry ? entry : {id:entry.id,x:i*244,y:32,w:220,h:120,z:i})}
      visibleIds={new Set(visible.map(entry=>entry.id))}
      renderCard={id=>compact(id,parent,Math.max(0,entries.findIndex(entry=>entry.id===id)))}
      onRebase={(offset,period,viewport)=>send({kind:'canvas-rebase',parent,offset,period,viewport})}
      onCreate={(x,y)=>create(parent,undefined,{x,y})}
      onCommit={(id,x,y,w,h,period)=>send({kind:'canvas-drop',id,parent,x,y,w,h,period})}/>;
    if(layout==='grid' || layout==='library')return <MasonryGrid className="card-collection grid-layout masonry-grid" {...dropProps(parent,entries.length)}>{visible.map(entry=>compact(entry.id,parent,entries.findIndex(child=>child.id===entry.id),true))}</MasonryGrid>;
    return <CardList horizontal={layout === 'plain' || layout === 'tabs'} className={`card-collection ${layout === 'ordered' ? 'vertical-card-list' : layout === 'plain' || layout === 'tabs' ? 'horizontal-card-list' : 'grid-layout'}`} {...dropProps(parent, entries.length)}>
      {visible.map((e, i) => compact(e.id, parent, entries.findIndex(child => child.id === e.id)))}

    </CardList>;
  };
  const trail: string[] = [];
  let cursor: string | undefined = location;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) { seen.add(cursor); trail.unshift(cursor); cursor = parents.get(cursor); }
  const target = menu ? state.cards.get(menu.id) : undefined;

  const fixedCanvasDrag=useFixedCanvasDrag(!cardId && panel==='cards' && canvasView && !!startDrag,dragBindings,(e,mode)=>startDrag?.(location,e,mode));
  return <EditMode.Provider value={{editable,busy:modeBusy,toggle:toggleEditMode}}><ImageWorkspace.Provider value={c.session.root}><div {...(!cardId?editPress:{})} onPointerDownCapture={event=>{if(!cardId)editPress.onPointerDownCapture(event);if(!canvasView&&event.button===2)dragManager(event);}} onPointerMoveCapture={event=>{if(!canvasView&&event.buttons&2)dragManager(event);}} data-browse={!editable} onPointerDown={event=>{if(event.button===0)dragManager(event);}} style={{...layoutVariables,'--card-radius':`${cardRadius}px`} as React.CSSProperties} className={`workspace-app ${cardId ? 'floating-app' : 'manager-shell'} ${boardView ? 'board-workspace' : ''} ${canvasView ? 'canvas-workspace' : ''}`}>
    <main data-scroll-owner={`${panel}:${location}`} {...fixedCanvasDrag} data-drop-parent={editable && !cardId && alive ? alive.id : undefined} className={`workspace-main proto-manager ${!cardId && alive ? "card-detail" : ""} ${alive?.isPrefab ? "prefab" : alive?.prefabRef ? "instance" : ""}`}>
      {!cardId && <div className="manager-navigation"><strong>{uiText("webview/WorkspaceApp.text006")}</strong><button className="manager-close" aria-label={uiText("webview/PrototypeNote.text013")} title={uiText("webview/PrototypeNote.text013")} onClick={close}>×</button><div className="manager-tabs">{[['manager',uiText("webview/WorkspaceApp.text017")]].map(([id,title]) => <button key={id} className={location===id && panel==='cards'?'active':''} onClick={() => navigate(id!)}>{title}</button>)}<button className={panel==='extensions'?'active':''} onClick={()=>setPanel('extensions')}>{uiText("extensions.tab")}</button><button onClick={()=>setPanel('settings')}>{uiText("webview/WorkspaceApp.text024")}</button></div></div>}
      <header className="topbar"><div className="breadcrumb-bar">{!cardId ? <WorkspaceHistoryButton current={c.session.root} busy={workspaceBusy || !switchWorkspace} switchTo={switchRecentWorkspace}/> : <span className="muted">{uiText("webview/WorkspaceApp.text025")}</span>}{panel === 'cards' && <BreadcrumbTrail ids={trail} titleOf={titleOf} navigate={navigate}/>}{panel==='cards' && alive && !isBuiltin(alive.id) && <button className="share-card-button" aria-label={uiText("share.export")} title={uiText("share.export")} onClick={()=>fire({kind:"share-export",id:alive.id})}>↗</button>}<div className="window-drag-space" />{panel==='cards' && alive && <PrefabSyncButtons card={alive} send={send}/>}</div>
        {cardId && <button className="icon-button" aria-label={uiText("webview/WorkspaceApp.text026")} onClick={close}>×</button>}
        {!cardId && <div className="workspace-location"><button className="workspace-path" disabled={workspaceBusy || !switchWorkspace} title={c.session.root} onClick={()=>void chooseWorkspace()}>{c.session.root}</button><button className="workspace-reset" disabled={workspaceBusy || !switchWorkspace} aria-label={uiText("webview/WorkspaceApp.resetWorkspace")} title={uiText("webview/WorkspaceApp.resetWorkspace")} onClick={()=>void clearWorkspace()}>×</button></div>}</header>
      {(error || c.error) && <div className="error-banner" role="alert"><span>{error || c.error}</span><button onClick={() => { void c.retry().then(() => setError('')).catch(e => setError(String(e))); }}>{uiText("webview/WorkspaceApp.text028")}</button><button aria-label={uiText("webview/WorkspaceApp.text029")} onClick={() => setError('')}>×</button></div>}
      {cardId && extensionId(cardId) ? <ExtensionWindow controller={c} windowId={windowId!} send={send} close={close} startDrag={startDrag}/> : cardId && alive ? <PrototypeNote viewId={windowId} dragBindings={dragBindings} ordinary={ordinary} vertical={currentLayout === 'ordered'} childSize={savedChildArea(alive,currentLayout,c.view.windows[windowId!]?.childArea)} add={()=>create(location)} canvas={canvasView} waterfall={currentLayout==='grid'} hideBody={currentLayout === 'columns' || currentLayout==='grid' || canvasView} key={alive.id} card={alive} send={send} close={close} startDrag={startDrag} breadcrumb={<BreadcrumbTrail ids={trail} titleOf={titleOf} navigate={navigate}/>}><div className="note-children-heading"><span>{uiText("webview/WorkspaceApp.childCount",{arg0:state.children.get(location)?.length ?? 0})}</span><button onClick={e => setMenu({id:location,x:Math.min(e.clientX,window.innerWidth-230),y:Math.max(8,e.clientY-240)})}>···</button></div>{collection(location,currentLayout)}</PrototypeNote>
      : panel === 'cards' && location === 'manager' ? <section className="manager-home" {...dropProps(null, roots.length)}><div className="actions"><button className="primary" onClick={()=>create(null)}>{uiText("webview/WorkspaceApp.text031")}</button><button onClick={()=>create(null,'columns')}>{uiText("webview/WorkspaceApp.text032")}</button><button onClick={()=>fire({kind:"share-import",parent:null})}>{uiText("share.import")}</button>{selected && !isBuiltin(selected) && <button onClick={()=>fire({kind:"share-export",id:selected})}>{uiText("share.export")}</button>}<button onClick={()=>{fire({kind:'close-all'});}}>{uiText("webview/WorkspaceApp.text033")}</button></div><h2 className="section">{uiText("webview/WorkspaceApp.text034")}<span>{roots.length}</span></h2><MasonryGrid className="card-collection grid-layout masonry-grid">{roots.map((id,index)=>compact(id,null,index,true))}</MasonryGrid>{!roots.length&&<p className="empty">{uiText("webview/WorkspaceApp.text038")}</p>}<p className="hint">{uiText("webview/WorkspaceApp.managerHint")}</p></section>
      : panel === 'settings' ? <section className="settings-page"><div className="eyebrow">{uiText("webview/WorkspaceApp.text040")}</div><h1>{uiText("webview/WorkspaceApp.text024")}</h1><ThemeSettings controller={c} send={send}/><McpSettings/><form className="settings-card" onSubmit={e=>{e.preventDefault();void send({kind:"signature",name:signature}).catch(error=>setError(String(error)));}}><label>{uiText("collaboration.signature")}<input maxLength={80} value={signature} placeholder={uiText("collaboration.signaturePlaceholder")} onChange={e=>setSignature(e.target.value)}/></label><button type="submit" disabled={c.busy || !signature.trim()}>{uiText("collaboration.saveSignature")}</button><p>{uiText("collaboration.signatureHelp")}</p></form><div className="settings-card"><button disabled={c.busy} onClick={()=>void send({kind:"tutorial"}).then(result=>{if(result.createdId){setSelected(result.createdId);if(!request)navigate(result.createdId);}}).catch(error=>setError(String(error)))}>{uiText("webview/WorkspaceApp.reviewTutorial")}</button><p>{uiText("webview/WorkspaceApp.tutorialDescription")}</p></div><div className="settings-card"><h3>{uiText("webview/WorkspaceApp.text041")}</h3><label className="radius-setting">{uiText("webview/WorkspaceApp.text042")}<output>{cardRadius}{uiText("webview/WorkspaceApp.text043")}</output><input aria-label={uiText("webview/WorkspaceApp.text044")} type="range" min={0} max={MAX_CARD_RADIUS} step={1} value={cardRadius} onChange={e=>fire({kind:'appearance',cardRadius:Number(e.target.value)})}/></label><p>{uiText("webview/WorkspaceApp.text045")}</p><p>{uiText("webview/WorkspaceApp.text046")}</p><div className="segmented">{[['light', uiText("webview/WorkspaceApp.text047")], ['dark', uiText("webview/WorkspaceApp.text048")]].map(([value, label]) => <button key={value} className={theme === value ? 'active' : ''} onClick={() => fire({kind:'skin',skin:value==='dark'?'dark':'light'})}>{label}</button>)}</div></div><div className="settings-card"><h3>{uiText("webview/WorkspaceApp.text049")}</h3>{([['left',uiText("webview/WorkspaceApp.text050")],['right',uiText("webview/WorkspaceApp.text051")],['combined',uiText("webview/WorkspaceApp.text052")]] as const).map(([key,label])=><label className="canvas-drag-setting" key={key}>{label}<select aria-label={label} value={dragBindings[key]} onChange={e=>fire({kind:'interaction',canvasDragBindings:{...dragBindings,[key]:e.target.value as CanvasDragAction}})}>{canvasDragOptions.map(([value,title])=><option key={value} value={value}>{title}</option>)}</select></label>)}<p>{uiText("webview/WorkspaceApp.text053")}</p><h3>{uiText("webview/WorkspaceApp.text054")}</h3><p>{uiText("webview/WorkspaceApp.text055")}</p><p>{uiText("webview/WorkspaceApp.text056")}</p><p className="muted">{uiText("webview/WorkspaceApp.text057")}{c.session.root}</p></div></section>
      : panel === 'extensions' ? <ExtensionManager controller={c} send={send} open={openCard}/>
      : alive ? <><section className="page-heading"><div><div className="eyebrow">{location === '003' ? '' : currentLayout === 'columns' ? '' : currentLayout === 'plane' ? '' : ''}</div><h1><span className="editable-title" tabIndex={0} onKeyDown={e=>{if(e.key==="Enter") beginEdit(location,"title");}}>{titleOf(location)}</span>{alive.isPrefab && <span className="prefab-badge">{uiText("webview/WorkspaceApp.text014")}</span>}{alive.prefabRef && <span className="identity-badge">{uiText("webview/WorkspaceApp.text015")}</span>}</h1><p>{location === '001' ? uiText("webview/WorkspaceApp.text070") : location === '002' ? uiText("webview/WorkspaceApp.text071") : location === '003' ? uiText("webview/WorkspaceApp.text072") : uiText("webview/WorkspaceApp.text073", {arg0: (state.children.get(location)?.length ?? 0), arg1: (layouts.find(([v]) => v === currentLayout)?.[1])})}</p></div><div className="heading-actions">{alive.isPrefab && <button className="secondary-button" title={uiText("webview/WorkspaceApp.text074")} onClick={()=>fire({kind:"window",id:alive.id,open:true})}>↗</button>}{!isBuiltin(location) && <button className="secondary-button" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ id: location, x: Math.min(r.left, window.innerWidth - 230), y: r.bottom }); }}>{uiText("webview/WorkspaceApp.text075")}</button>}</div></section>
      <div className="view-toolbar"><div className="view-label">{currentLayout === 'columns' ? uiText("webview/WorkspaceApp.text076") : currentLayout === 'plane' ? uiText("webview/WorkspaceApp.text077") : currentLayout==='grid'?uiText("webview/WorkspaceApp.text003"):uiText("webview/WorkspaceApp.text078")}<span className="count">{state.children.get(location)?.length ?? 0}</span></div><label className="search-field"><span>⌕</span><input aria-label={uiText("webview/WorkspaceApp.text079")} placeholder={uiText("webview/WorkspaceApp.text080")} value={filter} onChange={e => setFilter(e.target.value)} /></label></div>
      {ordinary ? <CardRegions key={location} vertical={currentLayout==='ordered'} saved={savedChildArea(alive,currentLayout,c.view.windows[location]?.childArea)} save={area=>fire({kind:'view',id:location,cardId:location,layout:currentLayout,childArea:area})} add={()=>create(location)} body={<section className="ordinary-document" style={{height:'100%',minHeight:0,display:'flex',flexDirection:'column'}}><div className="document-tools"><span>{uiText("webview/WorkspaceApp.text081")}</span><button className="text-button" disabled={modeBusy} aria-pressed={editable} onClick={toggleEditMode}>{uiText(editable?'webview/PrototypeNote.browseMode':'webview/PrototypeNote.editMode')}</button></div><div className="ordinary-content" style={{flex:1,minHeight:0,overflow:'hidden'}}><CardBodyEditor key={alive.id} ref={bodyEditor} doodle={alive.doodle ?? null} id={alive.id} content={inlineEditing?editing!.content:alive.content} images={alive.images ?? []} editing={inlineEditing} editorRef={bodyInput} disabled={savingEditor || modeBusy} onChange={changeInlineContent} onBlur={()=>{void commitAsync(false).catch(()=>undefined);}} onRequestEdit={()=>beginEdit(alive.id,'content')} flush={()=>commitAsync(false)} prepare={async()=>{bodyEditor.current?.captureExit();await commitAsync();}} send={send}/></div></section>}>{collection(location,currentLayout)}</CardRegions> : <div className="collection-region">{collection(location,currentLayout)}{currentLayout!=="columns" && currentLayout!=="plane" && <button className="floating-add-card" aria-label={uiText("webview/WorkspaceApp.text084")} title={uiText("webview/WorkspaceApp.text084")} onClick={()=>create(location)}><AddIcon/></button>}</div>}</> : <Empty text={uiText("webview/WorkspaceApp.text085")} action={() => navigate(cardId ?? '001')} />}
      <footer className="workspace-footer"><span><i className={c.error ? 'status-dot error' : 'status-dot'} />{dropHint || (c.busy ? uiText("webview/WorkspaceApp.text086") : c.status)}</span><span>{cardId ? uiText("webview/WorkspaceApp.text087") : uiText("webview/WorkspaceApp.managerKeyboardHint")}<button disabled={!c.undoCount} onClick={() => fire({ kind: 'undo' })}>{uiText("webview/WorkspaceApp.text089")}</button></span></footer>
    </main>
    {!cardId && <button className="window-resize-handle" aria-label={uiText('webview/PrototypeNote.text020')} title={uiText('webview/PrototypeNote.text020')} onPointerDown={resizeWindow}/>}
    {menu && target && !isBuiltin(menu.id) && <><div className="menu-backdrop" onClick={() => setMenu(null)} /><div data-scroll-owner={`menu:${menu.id}`} className="action-menu" style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }} role="menu">
      <details className="layout-menu"><summary>{uiText("webview/WorkspaceApp.text090")}</summary><div className="layout-choices">{layouts.map(([value, label]) => <button key={value} className={(rendererOf(state, menu.id) === 'tabs' ? 'plain' : rendererOf(state, menu.id)) === value ? 'active' : ''} onClick={() => { fire({kind:'layout',id:menu.id,layout:value}); setMenu(null); }}>{label}</button>)}</div></details>
      <button className="danger" onClick={() => { setDeleting(menu.id); setMenu(null); }}>{uiText("webview/WorkspaceApp.text091")}</button>
    </div></>}
    {presentation && <div className="modal-backdrop"><form className="edit-dialog" onSubmit={e => { e.preventDefault(); void send({kind:'presentation',id:presentation,source:presentationSource}).then(()=>setPresentation(null)).catch(()=>undefined); }}><h2>{uiText("webview/WorkspaceApp.text092")}</h2><p>{uiText("webview/WorkspaceApp.text093")}</p><select aria-label={uiText("webview/WorkspaceApp.text094")} value={presentationSource} onChange={e=>setPresentationSource(e.target.value)}><option value="">{uiText("webview/WorkspaceApp.text095")}</option>{[...state.cards.values()].filter(card=>!card.deleted&&card.type===null&&card.id!==presentation&&!isBuiltin(card.id)).map(card=><option key={card.id} value={card.id}>{card.title} · {layouts.find(([layout])=>layout===card.layout)?.[1] ?? uiText("webview/WorkspaceApp.text001")}</option>)}</select><div className="dialog-actions"><button type="button" onClick={()=>setPresentation(null)}>{uiText("webview/WorkspaceApp.text096")}</button><button type="submit" disabled={!presentationSource}>{uiText("webview/WorkspaceApp.text097")}</button></div></form></div>}
    {editing && !inlineEditing && <div className="modal-backdrop" onPointerDown={e=>{if(e.button===0 && e.target===e.currentTarget && !savingEditor) commit();}}><form onPointerDown={e=>{if(e.button===0 && !(e.target as HTMLElement).closest("input,textarea,button,label") && !savingEditor) commit();}} data-scroll-owner={`edit:${editing.id}`} className="edit-dialog wide" onSubmit={e=>{e.preventDefault(); if(!savingEditor) commit();}} onKeyDown={e=>{if(!e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey) && e.key==='Enter'){e.preventDefault(); if(!savingEditor) commit();}}}>
      <div className="dialog-heading"><h2>{editing.field==='title'?uiText("webview/WorkspaceApp.text098"):uiText("webview/WorkspaceApp.text099")}</h2><button type="button" aria-label={uiText("webview/WorkspaceApp.text100")} disabled={savingEditor} onClick={commit}>✓</button></div>
      {editing.field==='title' ? <label>{uiText("webview/WorkspaceApp.text101")}<input autoFocus={editing.field==='title'} disabled={savingEditor} aria-label={uiText("webview/WorkspaceApp.text102")} value={editing.title} onChange={e=>setEditing({...editing,title:e.target.value})}/></label> :
      <label>{uiText("webview/WorkspaceApp.text081")}<MarkdownEditor autoFocus={editing.field==='content'} disabled={savingEditor} aria-label={uiText("webview/WorkspaceApp.text103")} placeholder={uiText("webview/WorkspaceApp.text083")} value={editing.content} onPointerDown={event=>event.stopPropagation()} onChange={value=>setEditing({...editing,content:value})}/></label>}
      <div className="dialog-actions"><span className="muted">{uiText("webview/WorkspaceApp.text104")}</span><button type="button" disabled={savingEditor} onClick={()=>setEditing(null)}>{uiText("webview/WorkspaceApp.text105")}</button><button className="primary-button" disabled={savingEditor} type="submit">{savingEditor?uiText("webview/WorkspaceApp.text086"):uiText("webview/WorkspaceApp.text100")}</button></div></form></div>}
    {deleting && <div className="modal-backdrop"><div className="edit-dialog" role="alertdialog"><h2>{uiText("webview/WorkspaceApp.deleteHeading",{arg0:titleOf(deleting)})}</h2><p>{uiText("webview/WorkspaceApp.deleteSummary",{arg0:subtreeSize(c.session,deleting)})}</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setDeleting(null)}>{uiText("webview/WorkspaceApp.text096")}</button><button className="danger-button" onClick={() => { fire({ kind: 'delete', id: deleting }); setDeleting(null); }}>{uiText("webview/WorkspaceApp.deleteConfirm",{arg0:subtreeSize(c.session,deleting)})}</button></div></div></div>}
    {imageOver && <div className="image-drop-hint">{uiText('images.drop')}</div>}
  </div></ImageWorkspace.Provider></EditMode.Provider>;
}

function Empty({ text, action }: { text: string; action: () => void }) { return <div className="empty-state"><span>▱</span><h3>{text}</h3><button className="secondary-button" onClick={action}>{uiText("webview/WorkspaceApp.text111")}</button></div>; }


