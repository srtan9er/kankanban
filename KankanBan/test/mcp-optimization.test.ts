import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {OperationJournal,type Actor} from '../src/core/collaboration.ts';
import type {CardEvent} from '../src/core/types.ts';
const user:Actor={kind:'user',id:'user',name:'zjj'},ai:Actor={kind:'ai',id:'codex',name:'Codex'};
const fixture=()=>{const fs=createMemoryFs();return {fs,j:new OperationJournal('/w',fs.ops,()=>123,()=>crypto.randomUUID())};};
test('only acknowledged reading survives reconnect; unread and incomplete pages are never skipped',()=>{
 const {fs,j}=fixture();j.append(user,'move',{id:'task',parent:'done'});
 const first=j.read(ai);assert.equal(new OperationJournal('/w',fs.ops,()=>123,()=>crypto.randomUUID()).read(ai).operations.length,1);
 (j as any).confirm(ai,first.reviewToken);
 const reopened=new OperationJournal('/w',fs.ops,()=>123,()=>crypto.randomUUID());assert.equal(reopened.read(ai).operations.length,0);
 reopened.append(user,'delete',{id:'task'});assert.equal(reopened.read(ai).operations.length,1);
});
test('default operation feed avoids repeating entire old/new/request bodies',()=>{
 const {j}=fixture(),before='x'.repeat(1200),after=before+' hello';
 j.append(user,'edit',{request:{kind:'edit',id:'card',field:'content',before,value:after},events:[{cardId:'card',type:'field_set',path:'/content',from:before,to:after}]});
 const feed=j.read(ai);assert.ok(JSON.stringify(feed.operations).length<900);assert.equal(j.operations[0]!.details && (j.operations[0]!.details as any).request.value,after);
});
test('consecutive editing snapshots compact with covered ranges; a deletion stays separate',()=>{
 const {j}=fixture();
 for(let i=0;i<8;i++)j.append(user,'edit',{request:{kind:'edit',id:'card',field:'content',before:'A'.repeat(i),value:'A'.repeat(i+1)}});
 j.append(user,'delete',{id:'card'});const feed=j.read(ai);
 assert.equal(feed.operations.length,2);assert.equal((feed.operations[0] as any).count,8);assert.equal((feed.operations[0] as any).seqStart,1);assert.equal(feed.operations[1]!.operation,'delete');
});
test('incomplete pagination cannot be confirmed and new changes after a snapshot stay unread',()=>{
 const {fs,j}=fixture();for(let i=0;i<105;i++)j.append(user,'move',{id:String(i)});
 const first=j.read(ai);assert.ok(first.nextCursor);assert.throws(()=>j.confirm(ai,first.nextCursor));
 assert.equal(new OperationJournal('/w',fs.ops,()=>123,()=>crypto.randomUUID()).read(ai).sourceCount,100);
 j.append(user,'delete',{id:'last'});const end=j.read(ai,undefined,first.nextCursor);assert.equal(end.sourceCount,5);
 j.confirm(ai,end.reviewToken);assert.throws(()=>j.assertReviewed(ai,end.reviewToken));
 assert.equal(new OperationJournal('/w',fs.ops,()=>123,()=>crypto.randomUUID()).read(ai).operations[0]?.operation,'delete');
});
test('workspace, actor and replaced-history boundaries cannot reuse a checkpoint',()=>{
 const {fs,j}=fixture();j.append(user,'edit',{id:'a'});const feed=j.read(ai);j.confirm(ai,feed.reviewToken);
 assert.equal(j.read({kind:'ai',id:'other',name:'Other'}).sourceCount,1);
 assert.equal(new OperationJournal('/other',fs.ops,()=>123,()=>crypto.randomUUID()).read(ai).sourceCount,0);
 fs.ops.writeFile('/w/.kkb/mcp-readers.json',JSON.stringify({version:1,readers:{'ai:codex':{through:1,headId:'wrong-history'}}}));
 assert.equal(new OperationJournal('/w',fs.ops,()=>123,()=>crypto.randomUUID()).read(ai).sourceCount,1);
});
test('incremental reads and guards do not traverse already-read operations',()=>{
 const {j}=fixture();for(let i=0;i<1000;i++)j.append(user,'move',{id:String(i)});
 let cursor:string|undefined,token:string|undefined;do{const page=j.read(ai,undefined,cursor);cursor=page.nextCursor;token=page.reviewToken;}while(cursor);j.confirm(ai,token);
 j.append(user,'delete',{id:'new'});let touched=0;
 (j as any).operations=new Proxy(j.operations,{get(target,key,receiver){if(typeof key==='string' && /^\d+$/.test(key))touched++;return Reflect.get(target,key,receiver);}});
 const next=j.read(ai);assert.equal(next.sourceCount,1);j.assertReviewed(ai,next.reviewToken);assert.ok(touched<10,`traversed ${touched} stored rows`);
});
test('unchanged event tails skip reserializing and walking the full replay log',()=>{
 const {j}=fixture();const events=Array.from({length:200},(_,i)=>({type:'field_set',id:'e'+i,seq:i,clientId:'user',timestamp:123,cardId:'a',path:'/title',from:'x',to:'y'})) as CardEvent[];
 j.importEvents(events);let touched=0;const tracked=new Proxy(events,{get(target,key,receiver){if(typeof key==='string' && /^\d+$/.test(key))touched++;return Reflect.get(target,key,receiver);}});
 j.importEvents(tracked);assert.ok(touched<5,`traversed ${touched} replay events`);
 const expanded=[...events,{...events.at(-1)!,id:'e-new'}];j.importEvents(expanded);assert.equal(j.operations.length,201);
});
test('raw history remains available when summaries are requested by default',()=>{
 const {j}=fixture();for(let i=0;i<4;i++)j.append(user,'edit',{request:{id:'a',field:'content',before:String(i),value:String(i+1)}});
 assert.equal(j.read(ai).operations.length,1);assert.equal(j.read(ai,undefined,undefined,{all:true,details:true}).operations.length,4);assert.equal(j.operations.length,4);
});
test('delete summaries retain cascade size even when stored snapshots are compacted',()=>{
 const {j}=fixture();j.append(user,'card_delete',{type:'card_delete',cardId:'a',parentId:'p',subtree:{cards:{count:120,sample:[]}}});
 assert.equal((j.read(ai).operations[0]!.details as {deletedCount:number}).deletedCount,120);
});
