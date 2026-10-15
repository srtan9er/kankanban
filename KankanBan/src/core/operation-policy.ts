/** Private view preferences have a persistence path, but no collaboration meaning. */
const PRIVATE_OPERATIONS=new Set(['view','window-state','window','close-all','skin','appearance','interaction','signature','share-export','open_card_window','close_card_window','canvas-rebase','extension-control','extension-invoke','extension-job']);
export function collaborationRelevant(operation:string):boolean{return !PRIVATE_OPERATIONS.has(operation);}
type Data=Record<string,unknown>;
export function editGroup(operation:string,details:unknown):string|undefined {
 const d=details as {request?:Data},r=d?.request;
 if(!r)return;
 if('events' in d && !Array.isArray(d.events))return;
 if(operation==='edit' && ['title','content'].includes(String(r.field)))return `edit:${r.id}:${r.field}`;
 if(operation==='set_field' && ['/title','/content'].includes(String(r.path)))return `edit:${r.cardId}:${r.path}`;
}
/** Retain the first before-state and last after-state, not every autosave snapshot. */
export function mergeOperationDetails(first:unknown,last:unknown,count:number):unknown {
 const a=first as {request:Data;events?:Data[]},b=last as {request:Data;events?:Data[]};
 const initial=a.events ?? [],latest=b.events ?? [];
 const events=latest.map(e=>{const old=initial.find(o=>o.type===e.type && o.cardId===e.cardId && o.path===e.path);return old?{...e,from:old.from}:e;});
 for(const e of initial)if(!events.some(o=>o.type===e.type && o.cardId===e.cardId && o.path===e.path))events.push(e);
 return {request:{...b.request,...('before' in a.request?{before:a.request.before}:{})},events,autosaveCount:count};
}
