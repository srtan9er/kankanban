import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {createCard,openSession} from '../src/core/workspace.ts';
import {emptyViewState} from '../src/core/view-state.ts';
import {WorkspaceController} from '../src/webview/controller.ts';
import {locateEntry} from '../src/core/indexes.ts';
import {Drafts} from '../src/webview/drafts.ts';
function fixture(){const b=createBufferedFs(),s=openSession('/windows',{ops:b.ops});const a=createCard(s,{parentId:null,title:'A'}),child=createCard(s,{parentId:a,title:'B',content:'original'}),other=createCard(s,{parentId:null,title:'Other'});return {a,child,other,c:new WorkspaceController(s,emptyViewState(),b,toAsync(createMemoryFs().ops))};}
test('ancestor and descendant desktop expansions preserve the tree and reuse one window per card',async()=>{
 const {c,a,child}=fixture();await c.execute({kind:'window',id:a,open:true});await c.execute({kind:'window',id:child,open:true});await c.execute({kind:'window',id:child,open:true});assert.equal(locateEntry(c.session.state,child)?.parentId,a);assert.equal(c.view.openWindows.filter(id=>id===child).length,1);await c.execute({kind:'window',id:a,open:false});assert.ok(c.view.openWindows.includes(child));
});
test('moving a displayed descendant resets only invalid navigation, keeps its own window open',async()=>{
 const {c,a,child,other}=fixture();await c.execute({kind:'window',id:a,open:true});await c.execute({kind:'view',id:a,focus:child});await c.execute({kind:'window',id:child,open:true});await c.execute({kind:'move',id:child,parent:other,index:0});assert.equal(c.view.windows[a]?.focusId,a);assert.ok(c.view.openWindows.includes(child));
});
test('deleting a displayed descendant closes its expansion and returns ancestor view to its anchor',async()=>{
 const {c,a,child}=fixture();await c.execute({kind:'window',id:a,open:true});await c.execute({kind:'view',id:a,focus:child});await c.execute({kind:'window',id:child,open:true});await c.execute({kind:'delete',id:child});assert.equal(c.view.windows[a]?.focusId,a);assert.ok(!c.view.openWindows.includes(child));assert.ok(c.view.openWindows.includes(a));
});
test('stale edits from another window are rejected without replacing saved text',async()=>{
 const {c,child}=fixture();await c.execute({kind:'edit',id:child,field:'content',value:'first',before:'original'});await assert.rejects(c.execute({kind:'edit',id:child,field:'content',value:'stale',before:'original'}));assert.equal(c.session.state.cards.get(child)?.content,'first');
});
test('draft saves for the same field serialize and advance their comparison base',async()=>{
 const calls:unknown[]=[];let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const d=new Drafts(async(field,value,before)=>{calls.push([field,value,before]);if(value==='first')await gate;});d.set('content','first','original');const initial=d.flush();d.set('content','second','original');const next=d.flush();assert.equal(calls.length,1);release();await Promise.all([initial,next]);assert.deepEqual(calls,[['content','first','original'],['content','second','first']]);assert.equal(d.has('content'),false);
});

test('expanding a prefab child is a view operation, not instantiation',async()=>{
 const {c}=fixture();const source=(await c.execute({kind:'create',parent:'003',title:'Prefab'})).createdId!;const child=(await c.execute({kind:'create',parent:source,title:'Source child'})).createdId!;const count=c.session.state.cards.size;await c.execute({kind:'window',id:source,open:true});await c.execute({kind:'window',id:child,open:true});assert.equal(c.session.state.cards.size,count);assert.equal(locateEntry(c.session.state,child)?.parentId,source);assert.equal(c.session.state.cards.get(child)?.prefabRef,null);assert.equal(c.session.state.cards.get(child)?.isPrefab,true);
});
test('prefab child structure drag instantiates outside prefab context but preserves its source and window',async()=>{
 const {c,other}=fixture();const source=(await c.execute({kind:'create',parent:'003',title:'Prefab'})).createdId!;const child=(await c.execute({kind:'create',parent:source,title:'Source child'})).createdId!;await c.execute({kind:'window',id:child,open:true});const result=await c.execute({kind:'move',id:child,parent:other,index:0});assert.ok(result.createdId);assert.notEqual(result.createdId,child);assert.equal(locateEntry(c.session.state,child)?.parentId,source);assert.equal(locateEntry(c.session.state,result.createdId!)?.parentId,other);assert.equal(c.session.state.cards.get(result.createdId!)?.prefabRef,child);assert.ok(c.view.openWindows.includes(child));
});
test('moving a prefab child under another prefab preserves identity and its expansion',async()=>{
 const {c}=fixture();const source=(await c.execute({kind:'create',parent:'003',title:'P'})).createdId!,target=(await c.execute({kind:'create',parent:'003',title:'Q'})).createdId!,child=(await c.execute({kind:'create',parent:source,title:'Source child'})).createdId!;await c.execute({kind:'window',id:source,open:true});await c.execute({kind:'view',id:source,focus:child});await c.execute({kind:'window',id:child,open:true});const count=c.session.state.cards.size;const result=await c.execute({kind:'move',id:child,parent:target,index:0});assert.equal(result.createdId,undefined);assert.equal(c.session.state.cards.size,count);assert.equal(locateEntry(c.session.state,child)?.parentId,target);assert.equal(c.view.windows[source]?.focusId,source);assert.ok(c.view.openWindows.includes(child));
});
test('instance child structure drag moves the same card and keeps its expansion',async()=>{
 const {c,other}=fixture();const source=(await c.execute({kind:'create',parent:'003',title:'Prefab'})).createdId!;await c.execute({kind:'create',parent:source,title:'Nested'});const instance=(await c.execute({kind:'instantiate',id:source,parent:null})).createdId!,child=c.session.state.children.get(instance)![0]!.id;await c.execute({kind:'window',id:child,open:true});const count=c.session.state.cards.size;const result=await c.execute({kind:'move',id:child,parent:other,index:0});assert.equal(result.createdId,undefined);assert.equal(c.session.state.cards.size,count);assert.equal(locateEntry(c.session.state,child)?.parentId,other);assert.ok(c.view.openWindows.includes(child));
});
