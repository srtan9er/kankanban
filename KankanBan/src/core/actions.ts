import {validInk,mergeInk,linkCanvasInk,projectInkCanvas,remapInkCards,type InkDocument} from './drawing.ts';
import {uiText} from '../i18n/text.ts';
import {rememberPrefabBases,savePrefabBase,syncPrefab} from './prefab-sync.ts';
import {rebasePlane,viewportPlane,type Point,type PlaneSize} from './plane-geometry.ts';
import type {PlaneEntry} from './types.ts';
import { createCard, setField, setLayout, moveCard, deleteCard, undoLast, transact, type Session, type PlanePlacement } from './workspace.ts';
import type { Layout } from './types.ts';
import { isInSubtree, locateEntry } from './indexes.ts';
import { isBuiltin } from './builtins.ts';
import { collectSubtree } from './subtree.ts';
import { isBoard } from './renderer.ts';
export type Action =
  | { kind: 'create'; parent: string | null; title?: string; layout?: Layout; prefab?: boolean; x?: number; y?: number }
  | {kind:'doodle-update';id:string;document:InkDocument;before?:InkDocument}
  | { kind: 'edit'; id: string; field: 'title' | 'content'; value: string }
  | { kind: 'layout'; id: string; layout: Layout }
  | { kind: 'presentation'; id: string; source: string | null }
  | { kind: 'canvas-rebase'; parent: string; offset: Point; period: PlaneSize; viewport: PlaneSize }
  | { kind: 'canvas-drop'; id: string; parent: string; x: number; y: number; w?: number; h?: number;period?:PlaneSize }
  | { kind: 'move'; id: string; parent: string | null; index: number; x?: number; y?: number }
  | { kind: 'instantiate'; id: string; parent: string | null; x?: number; y?: number }
  | { kind: 'prefab-sync'; id: string; target: 'prefab' | 'all' }
  | { kind: 'detach'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'undo' };
export function executeAction(session: Session, action: Action): { createdId?: string } {
  if (action.kind === 'undo') { undoLast(session); return {}; }
  return transact(session, s => {
    rememberPrefabBases(s);
    const parents=new Set<string>();
    if(action.kind==='create' || action.kind==='instantiate'){if(action.parent)parents.add(action.parent);}
    if(action.kind==='move' || action.kind==='canvas-drop' || action.kind==='delete'){
      const parent=locateEntry(s.state,action.id)?.parentId;if(parent)parents.add(parent);
      if(action.kind!=='delete' && action.parent)parents.add(action.parent);
    }
    if(action.kind==='doodle-update' || action.kind==='layout' || action.kind==='presentation')parents.add(action.id);
    const firstEvent=s.events.length;
    const result=apply(s, action);
    if(action.kind==='prefab-sync')for(const event of s.events.slice(firstEvent)){
      if('cardId' in event)parents.add(event.cardId);
      if(event.type==='card_move'){if(event.toParent)parents.add(event.toParent);if(event.fromParent)parents.add(event.fromParent);}
      if('parentId' in event && event.parentId)parents.add(event.parentId);
    }
    // Only genuine edits refresh intersection ownership. Camera rebasing never does.
    for(const parent of parents){
      const card=s.state.cards.get(parent);if(!card?.doodle || card.deleted || card.layout!=='plane')continue;
      const period=action.kind==='canvas-drop' && action.parent===parent && action.period?action.period:{width:card.doodle.width,height:card.doodle.height};
      if(!Number.isFinite(period.width) || !Number.isFinite(period.height) || period.width<1 || period.height<1)throw new Error(uiText('core/actions.text011'));
      const entries=(s.state.children.get(parent) ?? []) as PlaneEntry[];
      const linked=linkCanvasInk(entries,card.doodle,period);setField(s,parent,'/doodle',linked.document);
      for(const [index,entry] of linked.entries.entries())if(entry.x!==entries[index]!.x || entry.y!==entries[index]!.y)moveCard(s,entry.id,parent,index,entry);
    }
    return result;
  });
}

function placement(s: Session, parent: string | null, x?: number, y?: number): PlanePlacement | undefined {
  if (parent === null || s.state.cards.get(parent)?.layout !== 'plane') return undefined;
  const count = s.state.children.get(parent)?.length ?? 0;
  return { x: x ?? 32 + (count % 4) * 244, y: y ?? 32 + Math.floor(count / 4) * 144, w: 220, h: 120, z: count };
}

/** An instance keeps its identity even when nested inside the prefab library. */
function inPrefabContext(s:Session,parent:string|null):boolean {
 const seen=new Set<string>();
 while(parent!==null && !seen.has(parent)){
  seen.add(parent);const card=s.state.cards.get(parent);
  if(card?.prefabRef)return false;
  if(parent==='003' || card?.isPrefab)return true;
  parent=locateEntry(s.state,parent)?.parentId ?? null;
 }
 return false;
}
function markPrefabTree(s:Session,id:string):void {
 const card=s.state.cards.get(id)!;
 if(card.prefabRef){if(card.isPrefab)setField(s,id,'/isPrefab',false);return;}
 setField(s,id,'/isPrefab',true);
 for(const child of s.state.children.get(id) ?? [])markPrefabTree(s,child.id);
}

function apply(s: Session, action: Exclude<Action, { kind: 'undo' }>): { createdId?: string } {
  switch (action.kind) {
    case 'create': {
      if (action.parent !== null && isBoard(s.state, action.parent)) throw new Error(uiText("core/actions.text001"));
      const inLibrary = inPrefabContext(s,action.parent);
      const id = createCard(s, { parentId: action.parent, title: action.title?.trim() || undefined, content: '',
        layout: action.layout ?? 'plain', isPrefab: inLibrary || action.prefab === true,
        plane: placement(s, action.parent) });
      if (action.layout === 'columns') {
        for (const title of [uiText("core/actions.text002"), uiText("core/actions.text003"), uiText("core/actions.text004")]) createCard(s, { parentId: id, title, layout: 'ordered', isPrefab: inLibrary });
      }
      if(action.parent !== null && s.state.cards.get(action.parent)?.layout === 'plane') {
        const entry=(s.state.children.get(action.parent) ?? []).find(e=>e.id===id) as PlaneEntry;
        apply(s,{kind:'canvas-drop',id,parent:action.parent,x:action.x ?? entry.x,y:action.y ?? entry.y});
      }
      return { createdId: id };
    }
    case 'doodle-update': {
      const card=s.state.cards.get(action.id);if(!card || card.deleted)throw new Error(uiText('core/actions.text005'));
      if(!validInk(action.document) || (action.before && !validInk(action.before)))throw new Error(uiText('drawing.invalid'));
      const current=card.doodle;
      const next=current && action.before?mergeInk(current,action.before,action.document):action.document;
      if(!validInk(next))throw new Error(uiText('drawing.limit'));
      setField(s,action.id,'/doodle',next);
      if(card.prefabRef && !card.overrides.includes('doodle'))setField(s,action.id,'/overrides',[...card.overrides,'doodle']);
      return {};
    }
    case 'edit': {
      const card = s.state.cards.get(action.id);
      if (!card || card.deleted) throw new Error(uiText("core/actions.text005"));
      if (card[action.field] === action.value) return {};
      setField(s, action.id, `/${action.field}`, action.value);
      if (card.prefabRef !== null && !card.overrides.includes(action.field)) {
        setField(s, action.id, '/overrides', [...card.overrides, action.field]);
      }
      return {};
    }
    case 'layout': {
      if (isBuiltin(action.id)) throw new Error(uiText("core/actions.text006"));
      const card = s.state.cards.get(action.id);
      if (!card) throw new Error(uiText("core/actions.text005"));
      if (action.layout === 'columns' && (s.state.children.get(action.id)?.length ?? 0) > 0 && card.layout !== 'columns') {
        throw new Error(uiText("core/actions.text007"));
      }
      if (card.type !== null) setField(s, action.id, '/type', null);
      const placements = (s.state.children.get(action.id) ?? []).map((entry, i) => ({ id: entry.id,
        x: 32 + (i % 4) * 244, y: 32 + Math.floor(i / 4) * 144, w: 220, h: 120, z: i }));
      setLayout(s, action.id, action.layout, { placements });
      if (action.layout === 'columns' && (s.state.children.get(action.id)?.length ?? 0) === 0) {
        for (const title of [uiText("core/actions.text002"), uiText("core/actions.text003"), uiText("core/actions.text004")]) createCard(s, { parentId: action.id, title, layout: 'ordered', isPrefab: card.isPrefab });
      }
      for (const follower of [...s.state.cards.values()]) {
        if (!follower.deleted && follower.type === action.id) {
          apply(s, { kind: 'presentation', id: follower.id, source: action.id });
        }
      }
      return {};
    }
    case 'presentation': {
      if (isBuiltin(action.id)) throw new Error(uiText("core/actions.text006"));
      if (action.source === null) { setField(s, action.id, '/type', null); return {}; }
      const source = s.state.cards.get(action.source);
      if (!source || source.deleted || source.type !== null || source.id === action.id) throw new Error(uiText("core/actions.text008"));
      if ([...s.state.cards.values()].some(card => !card.deleted && card.type === action.id)) throw new Error(uiText("core/actions.text009"));
      apply(s, { kind: 'layout', id: action.id, layout: source.layout });
      setField(s, action.id, '/type', source.id);
      return {};
    }
    case 'canvas-rebase': {
      if(s.state.cards.get(action.parent)?.layout!=='plane') throw new Error(uiText("core/actions.text010"));
      if(![action.offset.x,action.offset.y,action.period.width,action.period.height,action.viewport.width,action.viewport.height].every(Number.isFinite) || action.period.width<=0 || action.period.height<=0 || action.viewport.width<=0 || action.viewport.height<=0) throw new Error(uiText("core/actions.text011"));
      // Apply the coordinate-frame change to authoritative entries, not a stale snapshot.
      const current=(s.state.children.get(action.parent) ?? []).map(entry=>{
        if(!('x' in entry))throw new Error(uiText("core/actions.text012"));
        return entry as PlaneEntry;
      });
      const ink=s.state.cards.get(action.parent)!.doodle;
      const projected=ink?projectInkCanvas(current,ink,action.offset,action.period,action.viewport):null;
      const normalized=projected?.entries ?? viewportPlane(current,action.offset,1,action.period,action.viewport);
      if(projected)setField(s,action.parent,'/doodle',projected.document);
      for(const [index,entry] of normalized.entries()) {
        const before=current[index]!;
        if(Math.abs(entry.x-before.x)>1e-7 || Math.abs(entry.y-before.y)>1e-7)moveCard(s,entry.id,action.parent,index,entry);
      }
      return {};
    }
    case 'canvas-drop': {
      if(s.state.cards.get(action.parent)?.layout !== 'plane') throw new Error(uiText("core/actions.text010"));
      const entries=(s.state.children.get(action.parent) ?? []).map(e=>{
        if(!('x' in e)) throw new Error(uiText("core/actions.text012"));
        return e as PlaneEntry;
      });
      const source=s.state.cards.get(action.id);
      if(!source || source.deleted || isBuiltin(action.id)) throw new Error(uiText("core/actions.text013"));
      const rebased=rebasePlane(entries,action.id,{x:action.x,y:action.y},{width:action.w ?? 220,height:action.h ?? 120});
      const parentCard=s.state.cards.get(action.parent)!;const canvasInk=parentCard.doodle;
      if(canvasInk && (rebased.shift.x || rebased.shift.y)){const next={...canvasInk,strokes:canvasInk.strokes.map(stroke=>({...stroke,points:stroke.points.map(point=>({x:point.x+rebased.shift.x,y:point.y+rebased.shift.y}))}))};setField(s,action.parent,'/doodle',next);}
      for(const [index,entry] of rebased.entries.entries()) {
        if(entry.id===action.id) continue;
        const before=entries.find(e=>e.id===entry.id)!;
        if(entry.x!==before.x || entry.y!==before.y) moveCard(s,entry.id,action.parent,index,entry);
      }
      const moved=rebased.entries.find(e=>e.id===action.id)!;
      if(source.isPrefab && source.prefabRef===null && !inPrefabContext(s,action.parent)) {
        const result=apply(s,{kind:'instantiate',id:action.id,parent:action.parent,x:moved.x,y:moved.y});
        moveCard(s,result.createdId!,action.parent,entries.length,moved);
        return result;
      }
      moveCard(s,action.id,action.parent,entries.findIndex(e=>e.id===action.id)<0 ? entries.length : entries.findIndex(e=>e.id===action.id),moved);
      if(inPrefabContext(s,action.parent))markPrefabTree(s,action.id);
      return {};
    }
    case 'move': {
      if (isBuiltin(action.id)) throw new Error(uiText("core/actions.text015"));
      if(s.state.cards.get(action.id)?.isPrefab && s.state.cards.get(action.id)?.prefabRef===null && !inPrefabContext(s,action.parent)) {
        const result=apply(s,{kind:'instantiate',id:action.id,parent:action.parent,...(action.x===undefined?{}:{x:action.x}),...(action.y===undefined?{}:{y:action.y})});
        moveCard(s,result.createdId!,action.parent,action.index,placement(s,action.parent,action.x,action.y));
        return result;
      }
      moveCard(s, action.id, action.parent, action.index, placement(s, action.parent, action.x, action.y));
      if(inPrefabContext(s,action.parent))markPrefabTree(s,action.id);
      return {};
    }
    case 'instantiate': {
      const source = s.state.cards.get(action.id);
      if (!source?.isPrefab || source.deleted) throw new Error(uiText("core/actions.text016"));
      if (inPrefabContext(s,action.parent)) {
        throw new Error(uiText("core/actions.text017"));
      }
      const copies=new Map<string,string>();
      const copy = (sourceId: string, parent: string | null, at?: PlanePlacement): string => {
        const sourceCard = s.state.cards.get(sourceId)!;
        const id = createCard(s, { parentId: parent, title: sourceCard.title, content: sourceCard.content,doodle:sourceCard.doodle ?? null,
          layout: sourceCard.layout, type: sourceCard.type, plane: at ?? placement(s, parent) });
        copies.set(sourceId,id);
        setField(s, id, '/prefabRef', sourceCard.prefabRef ?? sourceId);
        for (const entry of [...(s.state.children.get(sourceId) ?? [])]) copy(entry.id, id, 'x' in entry ? entry : undefined);
        if(sourceCard.doodle)setField(s,id,'/doodle',remapInkCards(sourceCard.doodle,copies));
        savePrefabBase(s,id);
        return id;
      };
      return { createdId: copy(action.id, action.parent, placement(s, action.parent, action.x, action.y)) };
    }
    case 'prefab-sync': { syncPrefab(s,action.id,action.target); return {}; }
    case 'detach': {
      for (const id of collectSubtree(s.state, action.id).ids) {
        setField(s, id, '/prefabRef', null);
        setField(s, id, '/overrides', []);
        setField(s, id, '/prefabBase', null);
      }
      return {};
    }
    case 'delete': {
      const ids = new Set(collectSubtree(s.state, action.id).ids);
      for (const card of s.state.cards.values()) {
        if (!s.state.cards.get(locateEntry(s.state,action.id)?.parentId ?? '')?.isPrefab && !card.deleted && card.prefabRef !== null && ids.has(card.prefabRef) && !ids.has(card.id)) {
          throw new Error(uiText("core/actions.text018"));
        }
      }
      deleteCard(s, action.id);
      return {};
    }
  }
}
