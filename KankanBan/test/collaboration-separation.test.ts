import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession,readCard} from '../src/core/workspace.ts';
import {emptyViewState,readViewState} from '../src/core/view-state.ts';
import {WorkspaceController} from '../src/webview/controller.ts';
import {OperationJournal,type McpContext} from '../src/core/collaboration.ts';
const actor={kind:'ai' as const,id:'codex',name:'Codex'};
function fixture(){const disk=createMemoryFs(),buffer=createBufferedFs();let now=1000;const session=openSession('/w',{ops:buffer.ops,clock:()=>now});return {disk,buffer,c:new WorkspaceController(session,emptyViewState(),buffer,toAsync(disk.ops)),advance:(n:number)=>now+=n};}
async function read(c:WorkspaceController,context:McpContext={actor}){return (await c.execute({kind:'mcp',tool:'read_operations',args:{},context})).toolResult as {operations:any[];reviewToken:string;sourceCount:number};}
test('personal browsing persists independently and cannot invalidate AI review',async()=>{
 const {c,disk}=fixture();const id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 const feed=await read(c),context={actor,reviewToken:feed.reviewToken};
 await c.execute({kind:'view',id,focus:id,childArea:{width:240,height:0}});
 await c.execute({kind:'window-state',windowLabel:'main',changes:{x:100,y:200}});
 await c.execute({kind:'window',id,open:true});
 assert.equal(readViewState('/w',disk.ops).windows[id]?.childArea?.height,0);
 assert.equal((await read(c,context)).sourceCount,0);
 await c.execute({kind:'mcp',tool:'set_field',args:{cardId:id,path:'/title',value:'Reviewed'},context});
 assert.equal(readCard(c.session,id).title,'Reviewed');
});
test('continuous autosaves persist every value but produce one durable collaboration edit',async()=>{
 const {c,disk,buffer,advance}=fixture();const baseline=c.journal.operations.length;const id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 for(let i=1;i<=30;i++){advance(200);await c.execute({kind:'edit',id,field:'content',value:'字'.repeat(i)});assert.equal(openSession('/w',{ops:disk.ops}).state.cards.get(id)?.content,'字'.repeat(i));}
 const feed=await read(c);assert.equal(feed.operations.filter(o=>o.operation==='edit').length,1);
 const lines=disk.ops.readFile('/w/.kkb/operations.jsonl').trim().split('\n');assert.equal(lines.length,baseline+2);
 const journal=new OperationJournal('/w',buffer.ops,c.session.clock,c.session.newId);journal.importEvents(c.session.events);assert.equal(journal.operations.length,baseline+2);
});
test('reading seals an edit: newer autosaves must be read again; deletion remains independent',async()=>{
 const {c,advance}=fixture();const id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 await c.execute({kind:'edit',id,field:'content',value:'first'});const first=await read(c),context={actor,reviewToken:first.reviewToken};
 advance(100);await c.execute({kind:'edit',id,field:'content',value:'second'});
 await assert.rejects(c.execute({kind:'mcp',tool:'delete_card',args:{cardId:id},context}),/read_operations/);
 const next=await read(c,context);assert.equal(next.operations.length,1);assert.equal(next.operations[0].operation,'edit');
 await c.execute({kind:'delete',id});const deleted=await read(c,{actor,reviewToken:next.reviewToken});assert.equal(deleted.operations[0].operation,'delete');
});
test('old personal view records are omitted from AI summaries and review checks',()=>{
 const fs=createMemoryFs(),j=new OperationJournal('/w',fs.ops,()=>1000,()=>crypto.randomUUID());
 j.append({kind:'user',id:'user',name:'zjj'},'create',{id:'a'});const feed=j.read(actor);
 j.append({kind:'user',id:'user',name:'zjj'},'view',{request:{kind:'view',id:'a',focus:'a'}});
 assert.doesNotThrow(()=>j.assertReviewed(actor,feed.reviewToken));assert.equal(j.read(actor,feed.reviewToken).sourceCount,0);
});
test('pending edit survives reopening, resumes without importing every autosave, and keeps one record',async()=>{
 const {c,disk,advance}=fixture();const id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 await c.execute({kind:'edit',id,field:'content',value:'one'});advance(200);await c.execute({kind:'edit',id,field:'content',value:'two'});
 const journal=new OperationJournal('/w',disk.ops,c.session.clock,c.session.newId);journal.importEvents(c.session.events);
 const feed=journal.read(actor);assert.equal(feed.operations.filter(o=>o.operation==='edit').length,1);assert.equal((feed.operations.at(-1) as any).count,2);
 assert.equal((feed.operations.at(-1)!.details as any).delta.inserted,'two');
});
test('tree movements are discrete gestures and are not merged by timing',async()=>{
 const {c}=fixture();const parent=(await c.execute({kind:'create',parent:null,title:'P',layout:'ordered'})).createdId!;
 const a=(await c.execute({kind:'create',parent,title:'A'})).createdId!,b=(await c.execute({kind:'create',parent,title:'B'})).createdId!;
 const first=await read(c);await c.execute({kind:'move',id:a,parent,index:1});await c.execute({kind:'move',id:a,parent,index:0});
 const feed=await read(c,{actor,reviewToken:first.reviewToken});assert.equal(feed.operations.filter(o=>o.operation==='move').length,2);assert.deepEqual(c.session.state.children.get(parent)?.map(e=>e.id),[a,b]);
});
test('an interrupted seal with an old pending state does not duplicate the durable edit',async()=>{
 const {c,disk}=fixture();const id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;await c.execute({kind:'edit',id,field:'content',value:'saved'});
 const pending=disk.ops.readFile('/w/.kkb/operations-state.json');await read(c);disk.ops.writeFile('/w/.kkb/operations-state.json',pending);
 const restored=new OperationJournal('/w',disk.ops,c.session.clock,c.session.newId);restored.importEvents(c.session.events);
 assert.equal(restored.read(actor).operations.filter(o=>o.operation==='edit').length,1);
});
