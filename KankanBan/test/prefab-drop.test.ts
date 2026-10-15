import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openSession,createCard} from '../src/core/workspace.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {executeAction} from '../src/core/actions.ts';
import {locateEntry} from '../src/core/indexes.ts';
import {stateFingerprint} from '../src/core/subtree.ts';
function fixture(){const s=openSession('/prefab-drop',{ops:createMemoryFs().ops});const source=createCard(s,{parentId:null,title:'Ordinary',content:'body',layout:'ordered'}),child=createCard(s,{parentId:source,title:'Child'}),target=executeAction(s,{kind:'create',parent:'003',title:'Target prefab'}).createdId!;return {s,source,child,target};}
for(const targetKind of ['library','prefab'] as const)test(`dropping an ordinary subtree into ${targetKind} creates a prefab copy without moving the original`,()=>{
 const {s,source,child,target}=fixture(),parent=targetKind==='library'?'003':target,before=locateEntry(s.state,source);
 const result=executeAction(s,{kind:'move',id:source,parent,index:0});assert.ok(result.createdId);assert.notEqual(result.createdId,source);assert.deepEqual(locateEntry(s.state,source),before);assert.equal(s.state.cards.get(source)!.isPrefab,false);
 const copy=s.state.cards.get(result.createdId!)!;assert.equal(copy.isPrefab,true);assert.equal(copy.prefabRef,null);assert.equal(copy.content,'body');assert.equal(copy.layout,'ordered');assert.equal(locateEntry(s.state,copy.id)!.parentId,parent);
 const copiedChild=s.state.children.get(copy.id)![0]!.id;assert.notEqual(copiedChild,child);assert.equal(s.state.cards.get(copiedChild)!.isPrefab,true);assert.equal(locateEntry(s.state,child)!.parentId,source);
});
test('dropping a prefab moves its original identity',()=>{
 const {s,target}=fixture(),other=executeAction(s,{kind:'create',parent:'003',title:'Other'}).createdId!,count=s.state.cards.size;
 const result=executeAction(s,{kind:'move',id:target,parent:other,index:0});assert.equal(result.createdId,undefined);assert.equal(s.state.cards.size,count);assert.equal(locateEntry(s.state,target)!.parentId,other);
});
for(const targetKind of ['library','prefab'] as const)test(`dropping an instance into ${targetKind} syncs its own source without moving it`,()=>{
 const {s,target}=fixture(),instance=executeAction(s,{kind:'instantiate',id:target,parent:null}).createdId!,other=executeAction(s,{kind:'create',parent:'003',title:'Unrelated'}).createdId!,parent=targetKind==='library'?'003':other;
 executeAction(s,{kind:'edit',id:instance,field:'content',value:'Updated instance'});const count=s.state.cards.size,before=locateEntry(s.state,instance),targetChildren=JSON.stringify(s.state.children.get(parent));
 const result=executeAction(s,{kind:'move',id:instance,parent,index:0});assert.equal(result.createdId,undefined);assert.deepEqual(locateEntry(s.state,instance),before);assert.equal(s.state.cards.size,count);assert.equal(JSON.stringify(s.state.children.get(parent)),targetChildren);assert.equal(s.state.cards.get(target)!.content,'Updated instance');assert.equal(s.state.cards.get(instance)!.isPrefab,false);
});
test('ordinary prefab copies preserve canvas geometry and undo as one operation',()=>{
 const {s,target}=fixture(),source=createCard(s,{parentId:null,title:'Canvas',layout:'plane'}),child=createCard(s,{parentId:source,title:'Positioned',plane:{x:44,y:55,w:260,h:140,z:2}}),before=stateFingerprint(s.state);
 const copy=executeAction(s,{kind:'move',id:source,parent:target,index:0}).createdId!;
 const entry=s.state.children.get(copy)![0]!;assert.notEqual(entry.id,child);assert.deepEqual({...entry,id:child},s.state.children.get(source)![0]);
 const reopened=openSession('/prefab-drop',{ops:s.ops});assert.ok(reopened.state.cards.get(copy)!.isPrefab);
 executeAction(s,{kind:'undo'});assert.equal(stateFingerprint(s.state),before);
});
test('canvas drop uses the same ordinary copy and instance sync policy',()=>{
 const {s,source,target}=fixture();executeAction(s,{kind:'layout',id:target,layout:'plane'});
 const copied=executeAction(s,{kind:'canvas-drop',id:source,parent:target,x:88,y:99,w:240,h:130}).createdId!;assert.ok(copied);assert.equal(locateEntry(s.state,source),undefined);
 const entry=locateEntry(s.state,copied)!.entry;assert.ok('x' in entry && entry.x===88 && entry.y===99);
 const template=executeAction(s,{kind:'create',parent:'003',title:'Template'}).createdId!,instance=executeAction(s,{kind:'instantiate',id:template,parent:null}).createdId!;
 executeAction(s,{kind:'edit',id:instance,field:'title',value:'Updated'});const entries=JSON.stringify(s.state.children.get(target));executeAction(s,{kind:'canvas-drop',id:instance,parent:target,x:4,y:5});assert.equal(JSON.stringify(s.state.children.get(target)),entries);assert.equal(s.state.cards.get(template)!.title,'Updated');assert.equal(locateEntry(s.state,instance),undefined);
});
test('instance drop syncs accumulated child structure and layout only to its corresponding template',()=>{
 const {s,target}=fixture(),instance=executeAction(s,{kind:'instantiate',id:target,parent:null}).createdId!,otherInstance=executeAction(s,{kind:'instantiate',id:target,parent:null}).createdId!,unrelated=executeAction(s,{kind:'create',parent:'003',title:'Unrelated'}).createdId!;
 executeAction(s,{kind:'layout',id:instance,layout:'ordered'});executeAction(s,{kind:'create',parent:instance,title:'New child',content:'child content'});
 executeAction(s,{kind:'move',id:instance,parent:unrelated,index:0});assert.equal(s.state.cards.get(target)!.layout,'ordered');assert.equal(s.state.children.get(target)!.length,1);assert.equal(s.state.cards.get(s.state.children.get(target)![0]!.id)!.content,'child content');
 assert.equal((s.state.children.get(otherInstance) ?? []).length,0);assert.equal((s.state.children.get(unrelated) ?? []).length,0);assert.equal(locateEntry(s.state,instance),undefined);
});
