import type {CoreState} from '../core/state.ts';
import {locateEntry} from '../core/indexes.ts';
import {isBoard} from '../core/renderer.ts';
/** Resolve a requested navigation target without changing tree structure. */
export function navigationTarget(state:CoreState,_current:string,requested:string):string{
 const seen=new Set<string>();
 while(!seen.has(requested)){
  seen.add(requested);
  const parent=locateEntry(state,requested)?.parentId;
  if(!parent || !isBoard(state,parent))break;
  requested=parent;
 }
 return requested;
}
