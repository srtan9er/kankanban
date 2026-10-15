import type {Operation} from './collaboration.ts';
type Data=Record<string,unknown>;
const obj=(v:unknown):Data=>v && typeof v==='object' && !Array.isArray(v)?v as Data:{};
function short(v:unknown):unknown {
 if(typeof v==='string')return v.length<=180?v:{length:v.length,preview:v.slice(0,100),tail:v.slice(-60)};
 if(Array.isArray(v))return v.length<=8?v.map(short):{count:v.length,sample:v.slice(0,8).map(short)};
 if(v && typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!['eventKeys','before','events','undone','request','points'].includes(k)).slice(0,12).map(([k,value])=>[k,short(value)]));
 return v;
}
function delta(before:unknown,after:unknown):unknown {
 if(typeof before!=='string'||typeof after!=='string')return {before:short(before),after:short(after)};
 let start=0,end=0;while(start<before.length && start<after.length && before[start]===after[start])start++;
 while(end<before.length-start && end<after.length-start && before[before.length-1-end]===after[after.length-1-end])end++;
 return {start,removed:short(before.slice(start,before.length-end)),inserted:short(after.slice(start,after.length-end)),beforeLength:before.length,afterLength:after.length};
}
function change(e:Data):Data {
 if(e.type==='field_set')return {cardId:e.cardId,field:e.path,delta:delta(e.from,e.to)};
 if(e.type==='card_create'){const f=obj(e.fields);return {cardId:e.cardId,title:f.title,parent:e.parentId,layout:f.layout};}
 if(e.type==='card_move')return {cardId:e.cardId,fromParent:e.fromParent,toParent:e.toParent,fromIndex:e.fromIndex,index:e.index};
 if(e.type==='card_delete'){const tree=obj(e.subtree);return {cardId:e.cardId,parent:e.parentId,deletedCount:Array.isArray(tree.cards)?tree.cards.length:obj(tree.cards).count};}
 return {type:e.type,cardId:e.cardId,parentId:e.parentId,from:short(e.from),to:short(e.to),entry:short(e.entry)};
}
function edited(op:Operation):{cardId:unknown;field:unknown;before:unknown;after:unknown}|undefined {
 const d=obj(op.details),r=obj(d.request),e=Array.isArray(d.events)?obj(d.events[0]):d;
 const field=r.field?'/'+r.field:r.path ?? e.path,cardId=r.cardId ?? r.id ?? e.cardId;
 if(!['edit','set_field','field_set'].includes(op.operation)||!['/title','/content'].includes(field as string)||!cardId)return;
 return {cardId,field,before:e.from ?? r.before,after:e.to ?? r.value};
}
function summarize(op:Operation):Operation {
 const d=obj(op.details),r=obj(d.request),edit=edited(op);
 let details:unknown;
 if(edit)details={cardId:edit.cardId,field:edit.field,delta:delta(edit.before,edit.after)};
 else if(d.type)details=change(d);
 else {
  const events=Array.isArray(d.events)?d.events:Array.isArray(obj(d.events).sample)?obj(d.events).sample as unknown[]:[];
  const undone=Array.isArray(d.undone)?d.undone:[];
  details={...(Object.keys(r).length?{request:short(r)}:{value:short(d)}),...(events.length?{eventCount:Array.isArray(d.events)?d.events.length:obj(d.events).count,changes:events.slice(0,12).map(e=>change(obj(e)))}:{}),...(undone.length?{undoneCount:undone.length,undoneCards:undone.slice(0,12).map(e=>obj(e).cardId)}:{})};
 }
 return {...op,details};
}
/** All covered sequence numbers remain explicit; raw records are untouched. */
export function summarizeOperations(source:readonly Operation[]):Operation[] {
 const result:Operation[]=[];
 for(let i=0;i<source.length;i++){
  const first=source[i]!,edit=edited(first);let last=first,count=1;
  if(edit)while(i+1<source.length){const next=source[i+1]!,n=edited(next);
   if(!n || n.cardId!==edit.cardId || n.field!==edit.field || next.actor.id!==first.actor.id || next.actor.kind!==first.actor.kind || next.actor.name!==first.actor.name || next.timestamp-last.timestamp<0 || next.timestamp-last.timestamp>2000 || next.seq!==last.seq+1)break;
   last=next;count++;i++;
  }
  const row=summarize(last);
  if(count>1 && edit){const end=edited(last)!;row.details={cardId:edit.cardId,field:edit.field,delta:delta(edit.before,end.after)};Object.assign(row,{seqStart:first.seq,seqEnd:last.seq,count,startedAt:first.timestamp});}
  result.push(row);
 }
 return result;
}
