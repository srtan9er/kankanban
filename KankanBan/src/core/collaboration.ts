import {writeAtomic,type FsOps} from './storage/fs-ops.ts';
import {joinPath} from './paths.ts';
import {uiText} from '../i18n/text.ts';
import type {CardEvent} from './types.ts';
import {stableStringify} from './subtree.ts';
import {summarizeOperations} from './operation-summary.ts';
import {collaborationRelevant,editGroup,mergeOperationDetails} from './operation-policy.ts';
export type Actor={kind:'user'|'ai'|'legacy';id:string;name:string};
export type McpContext={actor?:Actor;reviewToken?:string};
export type Operation={seq:number;id:string;timestamp:number;actor:Actor;operation:string;details:unknown};
type Receipt={actor:string;through:number};
type Page=Receipt & {from:number};
type Checkpoint={through:number;headId:string|null};
type ReplayCheckpoint={count:number;tail:string|null};
type Pending={record:Operation;group:string;count:number;startedAt:number};
export function actorKey(actor:Actor):string{return `${actor.kind}:${actor.id}`;}
const eventKeys=new WeakMap<object,string>();
export function eventKey(event:unknown):string {
 if(event && typeof event==='object'){const old=eventKeys.get(event);if(old)return old;const key=stableStringify(compactChange(event));eventKeys.set(event,key);return key;}
 return stableStringify(compactChange(event));
}
const upperBound=(values:readonly number[],n:number)=>{let lo=0,hi=values.length;while(lo<hi){const mid=(lo+hi)>>>1;if(values[mid]!<=n)lo=mid+1;else hi=mid;}return lo;};
export function validateActor(actor:unknown,kind?:Actor['kind']):Actor {
 const a=actor as Actor;
 if(!a || !['user','ai','legacy'].includes(a.kind) || (kind && a.kind!==kind) || typeof a.id!=='string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(a.id) || typeof a.name!=='string' || !a.name.trim() || a.name.length>80 || /[\x00-\x1f]/.test(a.name))throw new Error(uiText('collaboration.invalidActor'));
 return {...a,name:a.name.trim()};
}
/** Separate from undo's replay log: collaboration history is never truncated by undo. */
export class OperationJournal {
 readonly operations:Operation[]=[];
 private receipts=new Map<string,Receipt>();
 private pages=new Map<string,Page>();
 private path:string;
 private readersPath:string;
 private readers=new Map<string,Checkpoint>();
 private byActor=new Map<string,number[]>();
 private knownEvents=new Set<string>();
 private importedCount=0;
 private importedTail:CardEvent|undefined;
 private ops:FsOps;
 private clock:()=>number;
 private newId:()=>string;
 private statePath:string;
 private pending:Pending|null=null;
 private replay:ReplayCheckpoint|undefined;
 constructor(root:string,ops:FsOps,clock:()=>number,newId:()=>string){
  this.ops=ops;this.clock=clock;this.newId=newId;
  this.path=joinPath(root,'.kkb','operations.jsonl');
  this.readersPath=joinPath(root,'.kkb','mcp-readers.json');
  this.statePath=joinPath(root,'.kkb','operations-state.json');
  if(ops.exists(this.path)){
   const source=ops.readFile(this.path),lines=source.split('\n');let repair=false;
   for(let i=0;i<lines.length;i++){
    const line=lines[i]!;if(!line.trim())continue;
    let value:Operation;try{value=JSON.parse(line) as Operation;}catch{
     if(i===lines.length-1 && !source.endsWith('\n')){repair=true;break;}
     throw new Error(uiText('collaboration.invalidHistory'));
    }
    if(!value || typeof value!=='object' || value.seq!==this.operations.length+1 || typeof value.id!=='string' || !Number.isFinite(value.timestamp) || typeof value.operation!=='string')throw new Error(uiText('collaboration.invalidHistory'));
    validateActor(value.actor);this.operations.push(value);this.index(value);
   }
   if(repair || (source.length>0 && !source.endsWith('\n')))writeAtomic(ops,this.path,this.operations.map(op=>JSON.stringify(op)+'\n').join(''));
  }
  if(ops.exists(this.statePath)){
   let state:{version:number;pending:Pending|null;replay?:ReplayCheckpoint};
   try{state=JSON.parse(ops.readFile(this.statePath));}catch{throw new Error(uiText('collaboration.invalidHistory'));}
   if(state.version!==1 || (state.replay && (!Number.isSafeInteger(state.replay.count) || state.replay.count<0 || (state.replay.tail!==null && typeof state.replay.tail!=='string'))))throw new Error(uiText('collaboration.invalidHistory'));
   this.replay=state.replay;
   if(state.pending){
    if(!state.pending.record || typeof state.pending.group!=='string' || !Number.isFinite(state.pending.record.timestamp) || typeof state.pending.record.id!=='string' || !Number.isSafeInteger(state.pending.count) || state.pending.count<1 || !Number.isFinite(state.pending.startedAt))throw new Error(uiText('collaboration.invalidHistory'));
    validateActor(state.pending.record.actor);
    // An append can succeed before the following atomic state update.
    if(state.pending.record.id!==this.operations.at(-1)?.id){
     if(state.pending.record.seq!==this.operations.length+1)throw new Error(uiText('collaboration.invalidHistory'));
     this.pending=state.pending;
    }
   }
  }
  try{
   if(ops.exists(this.readersPath)){
    const saved=JSON.parse(ops.readFile(this.readersPath)) as {version:number;readers:Record<string,Checkpoint>};
    if(saved.version===1)for(const [key,value] of Object.entries(saved.readers)){
     if(/^ai:[a-zA-Z0-9._-]{1,80}$/.test(key) && Number.isSafeInteger(value.through) && value.through>=0 && value.through<=this.operations.length && (value.through===0?value.headId===null:this.operations[value.through-1]?.id===value.headId))this.readers.set(key,value);
    }
   }
  }catch{/* Checkpoints are a cache; corrupt or replaced histories safely require reading again. */}
 }
 private index(record:Operation):void{
  if(collaborationRelevant(record.operation,record.details)){const key=actorKey(record.actor),list=this.byActor.get(key) ?? [];list.push(record.seq);this.byActor.set(key,list);}
  const d=record.details as {id?:string;eventKeys?:string[]};if(d?.id)this.knownEvents.add(eventKey(d));for(const value of d?.eventKeys ?? [])this.knownEvents.add(value);
 }
 /** Persist only a receipt echoed after its complete response was delivered. */
 confirm(actor:Actor,token?:string,allowExpired=false):{through:number;status:string}{
  validateActor(actor,'ai');const key=actorKey(actor),receipt=token?this.receipts.get(token):undefined;
  if(!receipt || receipt.actor!==key){if(allowExpired)return {through:this.readers.get(key)?.through ?? 0,status:'expired'};throw new Error(uiText('collaboration.invalidCursor'));}
  const old=this.readers.get(key)?.through ?? -1;
  if(receipt.through>old){
   const next=new Map(this.readers);next.set(key,{through:receipt.through,headId:this.operations[receipt.through-1]?.id ?? null});
   this.ops.mkdirp(this.readersPath.slice(0,this.readersPath.lastIndexOf('/')));
   writeAtomic(this.ops,this.readersPath,JSON.stringify({version:1,readers:Object.fromEntries(next)}));this.readers=next;
  }
  return {through:Math.max(old,receipt.through),status:'confirmed'};
 }
 private latestForeign(key:string):number{
  let last=this.pending && actorKey(this.pending.record.actor)!==key?this.pending.record.seq:0;for(const [actor,values] of this.byActor)if(actor!==key)last=Math.max(last,values.at(-1) ?? 0);return last;
 }
 private foreignAfter(key:string,from:number,through:number):Operation[]{
  const streams=[...this.byActor].filter(([actor])=>actor!==key).map(([,values])=>({values,at:upperBound(values,from)})),rows:Operation[]=[];
  while(rows.length<101){
   let best:typeof streams[number]|undefined,seq=Infinity;
   for(const stream of streams){const n=stream.values[stream.at];if(n!==undefined && n<=through && n<seq){seq=n;best=stream;}}
   if(!best)break;rows.push(this.operations[seq-1]!);best.at++;
  }
  return rows;
 }

 append(actor:Actor,operation:string,details:unknown,timestamp=this.clock()):Operation {
  this.sealPending();
  const record:Operation={seq:this.operations.length+1,id:this.newId(),timestamp,actor:validateActor(actor),operation,details};
  this.ops.mkdirp(this.path.slice(0,this.path.lastIndexOf('/')));
  this.ops.appendFile(this.path,JSON.stringify(record)+'\n');this.ops.fsync(this.path);this.operations.push(record);this.index(record);return record;
 }
 private saveState():void {
  this.ops.mkdirp(this.statePath.slice(0,this.statePath.lastIndexOf('/')));
  writeAtomic(this.ops,this.statePath,JSON.stringify({version:1,pending:this.pending,replay:this.replay}));
 }
 /** Data already saved by core; this bounded pending record replaces itself until sealed. */
 record(actor:Actor,operation:string,details:unknown,events:readonly CardEvent[]):void {
  const group=actor.kind==='user'?editGroup(operation,details):undefined,timestamp=this.clock();
  const previous=this.pending;
  if(group && previous && previous.group===group && actorKey(previous.record.actor)===actorKey(actor) && previous.record.actor.name===actor.name && timestamp>=previous.record.timestamp && timestamp-previous.record.timestamp<=2000){
   previous.count++;previous.record={...previous.record,timestamp,details:mergeOperationDetails(previous.record.details,details,previous.count)};
  }else if(group){
   this.sealPending();
   const {eventKeys:_,...bounded}=details as Record<string,unknown>;
   this.pending={group,count:1,startedAt:timestamp,record:{seq:this.operations.length+1,id:this.newId(),timestamp,actor:validateActor(actor),operation,details:bounded}};
  }else if(collaborationRelevant(operation,details))this.append(actor,operation,details,timestamp);
  const unchanged=this.importedCount===events.length && this.importedTail===events.at(-1);
  const start=this.importedCount<=events.length && (this.importedCount===0 || this.importedTail===events[this.importedCount-1])?this.importedCount:0;
  for(let i=start;i<events.length;i++)this.knownEvents.add(eventKey(events[i]!));
  if(!unchanged)this.checkpointEvents(events);
  if(collaborationRelevant(operation,details) || !unchanged)this.saveState();
 }
 sealPending():void {
  if(!this.pending)return;
  const record={...this.pending.record,startedAt:this.pending.startedAt,count:this.pending.count};
  this.ops.mkdirp(this.path.slice(0,this.path.lastIndexOf('/')));
  this.ops.appendFile(this.path,JSON.stringify(record)+'\n');this.ops.fsync(this.path);
  this.operations.push(record);this.index(record);this.pending=null;this.saveState();
 }
 private checkpointEvents(events:readonly CardEvent[]):void {
  this.importedCount=events.length;this.importedTail=events.at(-1);
  this.replay={count:events.length,tail:events.length?eventKey(events.at(-1)!):null};
 }
 importEvents(events:readonly CardEvent[]):void {
  const cached=this.importedCount<=events.length && this.importedCount>0 && events[this.importedCount-1]===this.importedTail;
  const recovered=this.replay && this.replay.count<=events.length && (this.replay.count===0?this.replay.tail===null:eventKey(events[this.replay.count-1]!)===this.replay.tail);
  const start=cached?this.importedCount:recovered?this.replay!.count:0;
  for(let i=start;i<events.length;i++){const event=events[i]!;if(!this.knownEvents.has(eventKey(event))){
   if(!collaborationRelevant(event.type,event)){this.knownEvents.add(eventKey(event));continue;}
   this.append(event.actor ?? {kind:'legacy',id:event.clientId.replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,80)||'unknown',name:event.clientId},event.type,compactChange(event),event.timestamp);
  }}
  if(start!==events.length){this.checkpointEvents(events);this.saveState();}else{this.importedCount=events.length;this.importedTail=events.at(-1);}
 }

 assertReviewed(actor:Actor,token?:string):void {
  validateActor(actor,'ai');const receipt=token?this.receipts.get(token):undefined,key=actorKey(actor);
  if(!receipt || receipt.actor!==key || this.latestForeign(key)>receipt.through)throw new Error(uiText('collaboration.readRequired'));
 }
 read(actor:Actor,previous?:string,cursor?:string,options:{all?:boolean;details?:boolean}={}):{operations:Operation[];sourceCount:number;nextCursor?:string;reviewToken?:string;through:number} {
  this.sealPending();
  validateActor(actor,'ai');const key=actorKey(actor),receipt=previous?this.receipts.get(previous):undefined;
  const trustedReceipt=receipt?.actor===key?receipt:undefined,page=cursor?this.pages.get(cursor):undefined;
  if(cursor && (!page || page.actor!==key))throw new Error(uiText('collaboration.invalidCursor'));
  const from=page?.from ?? (options.all?0:trustedReceipt?.through ?? this.readers.get(key)?.through ?? 0),through=page?.through ?? this.operations.length;
  const foreign=this.foreignAfter(key,from,through),source=foreign.slice(0,100),sourceCount=source.length;
  const operations=options.details?source.map(o=>{if(o.details && typeof o.details==='object' && 'eventKeys' in o.details){const {eventKeys:_,...details}=o.details;return {...o,details};}return o;}):summarizeOperations(source);
  const token=this.newId();
  if(foreign.length>100){this.pages.set(token,{actor:key,from:source.at(-1)!.seq,through});return {operations,sourceCount,nextCursor:token,through};}
  this.receipts.set(token,{actor:key,through});return {operations,sourceCount,reviewToken:token,through};
 }

}
/** Preserve change meaning without copying large drawings or full documents into the feed. */
export function compactChange(value:unknown):unknown {
 if(typeof value==='string')return value.length>2000?{preview:value.slice(0,2000),length:value.length}:value;
 if(Array.isArray(value))return value.length>100?{count:value.length,sample:value.slice(0,10).map(compactChange)}:value.map(compactChange);
 if(value && typeof value==='object'){
  if('strokes' in value && Array.isArray(value.strokes))return {strokeCount:value.strokes.length,strokeIds:value.strokes.map((s:{id?:string})=>s.id)};
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,compactChange(v)]));
 }
 return value;
}
