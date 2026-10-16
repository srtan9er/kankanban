import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openSession,setField,undoLast} from '../src/core/workspace.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {WorkspaceController} from '../src/webview/controller.ts';
import {emptyViewState,readViewState} from '../src/core/view-state.ts';
import {CHILD_MIN_WIDTH,CHILD_MIN_HEIGHT} from '../src/core/layout-metrics.ts';
import {OperationJournal} from '../src/core/collaboration.ts';
import {buildSharePackage,parseSharePackage,importSharePackage} from '../src/core/share-package.ts';
import {executeAction} from '../src/core/actions.ts';
import {parseCard,serializeCard} from '../src/core/storage/frontmatter.ts';

function fixture(){const disk=createMemoryFs(),buffer=createBufferedFs();const session=openSession('/sizes',{ops:buffer.ops});return {disk,buffer,c:new WorkspaceController(session,emptyViewState(),buffer,toAsync(disk.ops))};}
const sizes=(c:WorkspaceController,id:string)=>(c.session.state.cards.get(id) as unknown as {layoutSizes?:unknown})?.layoutSizes;

test('each card persists only its per-layout custom region dimensions and restores them on switching',async()=>{
 const {c,disk,buffer}=fixture();const id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 await c.execute({kind:'view',id,childArea:{width:9999,height:300}});
 await c.execute({kind:'layout',id,layout:'ordered'});
 assert.deepEqual(c.view.windows[id]?.childArea,{width:CHILD_MIN_WIDTH,height:9999});
 await c.execute({kind:'view',id,childArea:{width:260,height:9999}});
 await c.execute({kind:'layout',id,layout:'grid'});await c.execute({kind:'layout',id,layout:'plain'});
 assert.equal(c.view.windows[id]?.childArea?.height,300);
 assert.deepEqual(sizes(c,id),{plain:{height:300},ordered:{width:260}});
 const restored=openSession('/sizes',{ops:disk.ops});
 assert.deepEqual((restored.state.cards.get(id) as any).layoutSizes,sizes(c,id));
 assert.match(disk.ops.readFile(`/sizes/.kkb/cards/${id}.md`),/layoutSizes:.*"height":300/);
 const next=new WorkspaceController(restored,readViewState('/sizes',disk.ops),buffer,toAsync(disk.ops));
 await next.execute({kind:'layout',id,layout:'ordered'});assert.equal(next.view.windows[id]?.childArea?.width,260);
});
test('zero is remembered while returning to the default removes the layout override',async()=>{
 const {c}=fixture();const id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 await c.execute({kind:'view',id,childArea:{width:0,height:0}});
 await c.execute({kind:'layout',id,layout:'ordered'});await c.execute({kind:'layout',id,layout:'plain'});
 assert.deepEqual(c.view.windows[id]?.childArea,{width:0,height:0});assert.deepEqual(sizes(c,id),{plain:{height:0}});
 await c.execute({kind:'view',id,childArea:{width:9999,height:CHILD_MIN_HEIGHT}});
 assert.deepEqual(sizes(c,id),{});
});
test('region sizes belong to the focused card, with independent values for cards sharing a window',async()=>{
 const {c}=fixture(),parent=(await c.execute({kind:'create',parent:null,title:'P'})).createdId!,child=(await c.execute({kind:'create',parent,title:'C'})).createdId!;
 await c.execute({kind:'view',id:parent,focus:parent,childArea:{width:9999,height:280}});
 await c.execute({kind:'view',id:parent,focus:child,childArea:{width:9999,height:360}});
 assert.deepEqual(sizes(c,parent),{plain:{height:280}});assert.deepEqual(sizes(c,child),{plain:{height:360}});
 await c.execute({kind:'layout',id:child,layout:'ordered'});await c.execute({kind:'layout',id:child,layout:'plain'});
 assert.equal(c.view.windows[parent]?.childArea?.height,360);
});
test('legacy child-area values are retained when leaving an existing layout for the first time',async()=>{
 const {c}=fixture(),id=(await c.execute({kind:'create',parent:null,title:'Old'})).createdId!;
 c.view.windows[id]={...{focusId:id,regions:{breadcrumb:32,content:200,children:240},collapsed:{breadcrumb:false,content:false,children:false},bounds:null},childArea:{width:9999,height:310}};
 await c.execute({kind:'layout',id,layout:'ordered'});await c.execute({kind:'layout',id,layout:'plain'});
 assert.equal(c.view.windows[id]?.childArea?.height,310);assert.deepEqual(sizes(c,id),{plain:{height:310}});
});
test('layout-size attributes validate before saving and undo without leaving invalid optional fields',async()=>{
 const {c,disk}=fixture(),id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 assert.doesNotThrow(()=>setField(c.session,id,'/layoutSizes',{plain:{height:300}}));
 const saved=structuredClone(sizes(c,id));
 for(const value of [[],{invalid:{height:2}},{plain:{height:-1}},{plain:{height:NaN}},{plain:{width:Infinity}},{plain:{height:1,extra:true}}]){
  assert.throws(()=>setField(c.session,id,'/layoutSizes',value));assert.deepEqual(sizes(c,id),saved);
 }
 undoLast(c.session);await c.flush();assert.equal(sizes(c,id),undefined);
 assert.doesNotThrow(()=>openSession('/sizes',{ops:disk.ops}));
});
test('persisting region dimensions does not add collaboration noise, including after journal recovery',async()=>{
 const {c,disk}=fixture(),id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 const actor={kind:'ai' as const,id:'codex',name:'Codex'},before=c.journal.read(actor);
 await c.execute({kind:'view',id,childArea:{width:9999,height:320}});
 assert.equal(c.journal.read(actor,before.reviewToken).sourceCount,0);
 const restored=new OperationJournal('/sizes',disk.ops,c.session.clock,c.session.newId);restored.importEvents(c.session.events);
 assert.equal(restored.read(actor).operations.filter(op=>op.operation==='field_set'&&(op.details as any)?.field==='/layoutSizes').length,0);
 assert.deepEqual(sizes(c,id),{plain:{height:320}});
});
test('recovering collaboration solely from saved core events omits region-size changes',async()=>{
 const {c}=fixture(),id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 await c.execute({kind:'view',id,childArea:{width:9999,height:330}});
 const isolated=createMemoryFs(),journal=new OperationJournal('/recover',isolated.ops,c.session.clock,c.session.newId);
 journal.importEvents(c.session.events);
 assert.equal(journal.read({kind:'ai',id:'codex',name:'Codex'}).operations.filter(op=>op.operation==='field_set').length,0);
});
test('share round trips retain dimensions and reject malformed optional attributes',async()=>{
 const {c}=fixture(),id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 await c.execute({kind:'view',id,childArea:{width:9999,height:300}});
 const pkg=buildSharePackage(c.session.state,id,new Map());
 assert.deepEqual((pkg.cards[0] as any).layoutSizes,{plain:{height:300}});
 const imported=importSharePackage(c.session,pkg,null);assert.deepEqual(sizes(c,imported.rootId),{plain:{height:300}});
 const bad=structuredClone(pkg) as any;bad.cards[0].layoutSizes={plain:{height:-1}};assert.throws(()=>parseSharePackage(bad));
});
test('prefab copies and explicit synchronization retain layout-size history without aliasing',async()=>{
 const {c}=fixture(),source=executeAction(c.session,{kind:'create',parent:'003',title:'Template'}).createdId!;
 setField(c.session,source,'/layoutSizes',{plain:{height:300}});
 const instance=executeAction(c.session,{kind:'instantiate',id:source,parent:null}).createdId!;
 assert.deepEqual(sizes(c,instance),{plain:{height:300}});
 setField(c.session,instance,'/layoutSizes',{plain:{height:350},ordered:{width:260}});
 assert.deepEqual(sizes(c,source),{plain:{height:300}});
 executeAction(c.session,{kind:'prefab-sync',id:instance,target:'all'});
 assert.deepEqual(sizes(c,source),{plain:{height:350},ordered:{width:260}});
});
test('MCP changes use the same per-card region memory as direct layout changes',async()=>{
 const {c}=fixture(),id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 await c.execute({kind:'view',id,childArea:{width:9999,height:340}});
 const actor={kind:'ai' as const,id:'codex',name:'Codex'};
 await c.execute({kind:'mcp',tool:'set_layout',args:{cardId:id,layout:'ordered'},context:{actor,reviewToken:c.journal.read(actor).reviewToken!}});
 await c.execute({kind:'view',id,childArea:{width:250,height:9999}});
 await c.execute({kind:'mcp',tool:'set_layout',args:{cardId:id,layout:'plain'},context:{actor,reviewToken:c.journal.read(actor).reviewToken!}});
 assert.equal(c.view.windows[id]?.childArea?.height,340);assert.deepEqual(sizes(c,id),{plain:{height:340},ordered:{width:250}});
});
test('optional size attributes round-trip and corrupted on-disk dimensions are rejected',async()=>{
 const {c}=fixture(),id=(await c.execute({kind:'create',parent:null,title:'A'})).createdId!;
 const card=c.session.state.cards.get(id)!,legacy=serializeCard(card);assert.equal(parseCard(legacy).layoutSizes,undefined);
 const content=serializeCard({...card,layoutSizes:{plain:{height:0},ordered:{width:260}}});
 assert.deepEqual(parseCard(content).layoutSizes,{plain:{height:0},ordered:{width:260}});
 assert.throws(()=>parseCard(content.replace('"width":260','"width":-1')));
});
