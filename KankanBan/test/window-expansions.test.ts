import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceController} from '../src/webview/controller.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {emptyViewState,writeViewState,readViewState,windowViewFor} from '../src/core/view-state.ts';
import {openWindowSet} from '../src/core/windows.ts';
import {WindowPositions} from '../src/webview/window-events.ts';
import {newExpansionId,windowAnchor} from '../src/core/window-identity.ts';
import {roleOfLabel} from '../src/webview/window-role.ts';
test('duplicate native labels preserve the anchor card and expose their independent window ID',()=>{
 assert.deepEqual(roleOfLabel('card-card__one'),{kind:'card',cardId:'card',windowId:'card__one'});
});
test('each drag-out has a new identity and all position subscribers see only newer updates',()=>{
 assert.notEqual(newExpansionId('card'),newExpansionId('card'));assert.equal(windowAnchor(newExpansionId('card')),'card');
 const positions=new WindowPositions(),seen:number[][]=[[],[],[]];const unsubscribe=seen.map(list=>positions.subscribe(value=>list.push(value.x)));
 const value={windowId:'card-card__one',cardId:'card',x:1,y:2,sequence:1};positions.accept(value);positions.accept({...value,x:4,sequence:2});positions.accept({...value,x:0});assert.deepEqual(seen,[[1,4],[1,4],[1,4]]);
 unsubscribe[0]!();positions.accept({...value,x:6,sequence:3});assert.deepEqual(seen,[[1,4],[1,4,6],[1,4,6]]);
});
test('multiple expansions survive sync and restore, with independent focus and closure',async()=>{
 const buffer=createBufferedFs(),session=openSession('/expansions',{ops:buffer.ops}),card=createCard(session,{parentId:null,title:'Parent'}),child=createCard(session,{parentId:card,title:'Child'});
 const c=new WorkspaceController(session,emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 await c.execute({kind:'window',id:card,open:true});await c.execute({kind:'window',id:card+'__one',open:true});await c.execute({kind:'window',id:card+'__two',open:true});
 assert.deepEqual(c.view.openWindows,[card,card+'__one',card+'__two']);
 assert.equal(windowViewFor(c.view,card+'__one').focusId,card);
 await c.execute({kind:'view',id:card+'__one',focus:child});assert.equal(c.view.windows[card+'__one']!.focusId,child);assert.equal(c.view.windows[card+'__two']!.focusId,card);
 writeViewState(session.root,c.view,buffer.ops);const restored=readViewState(session.root,buffer.ops);assert.deepEqual(openWindowSet(session.state,restored.openWindows).filter(id=>id!=='000'),[card,card+'__one',card+'__two'].sort());
 await c.execute({kind:'window',id:card+'__one',open:false});assert.ok(c.view.openWindows.includes(card+'__two'));assert.ok(c.view.openWindows.includes(card));
});
test('all mirrors receive position and tree changes while keeping expansion identities',async()=>{
 const buffer=createBufferedFs(),s=openSession('/mirrors',{ops:buffer.ops}),a=createCard(s,{parentId:null,title:'A',layout:'plane'}),b=createCard(s,{parentId:null,title:'B',layout:'plane'}),child=createCard(s,{parentId:a,title:'Child',plane:{x:1,y:2,w:220,h:120,z:0}});
 const c=new WorkspaceController(s,emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 await c.execute({kind:'window',id:child+'__one',open:true});await c.execute({kind:'window',id:child+'__two',open:true});assert.equal(c.view.openWindows.length,2);
 const mirrors=[1,2,3].map(()=>new WorkspaceController(openSession('/mirror',{ops:createMemoryFs().ops}),emptyViewState(),createBufferedFs(),toAsync(createMemoryFs().ops)));
 const broadcast=()=>mirrors.forEach(m=>m.accept(c.snapshot()));
 await c.execute({kind:'move',id:child,parent:b,index:0,x:77,y:88});broadcast();
 for(const mirror of mirrors){assert.ok(!mirror.session.state.children.get(a)?.some(e=>e.id===child));assert.ok(mirror.session.state.children.get(b)?.some(e=>e.id===child && 'x' in e && e.x===77));assert.equal(mirror.view.openWindows.length,2);}
 await c.execute({kind:'delete',id:child});broadcast();for(const mirror of mirrors)assert.equal(mirror.view.openWindows.length,0);
});
test('extracting an ordinary child makes it a root and preserves all existing independent windows',async()=>{
 const buffer=createBufferedFs(),s=openSession('/extract',{ops:buffer.ops}),parent=createCard(s,{parentId:null,title:'Parent'}),child=createCard(s,{parentId:parent,title:'Child'}),grandchild=createCard(s,{parentId:child,title:'Grandchild'}),c=new WorkspaceController(s,emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 await c.execute({kind:'window',id:child+'__one',open:true});await c.execute({kind:'float',id:child});
 assert.ok(!s.state.children.get(parent)?.some(entry=>entry.id===child));assert.ok(s.state.children.get(child)?.some(entry=>entry.id===grandchild));
 assert.equal(c.view.openWindows.filter(id=>windowAnchor(id)===child).length,2);assert.ok(c.view.openWindows.includes(child+'__one'));assert.equal(c.view.windows[child+'__one']!.focusId,child);
});
test('an awaited tree mutation returns only after publishing its updated revision',async()=>{
 const buffer=createBufferedFs(),s=openSession('/published',{ops:buffer.ops}),a=createCard(s,{parentId:null,title:'A'}),b=createCard(s,{parentId:null,title:'B'}),child=createCard(s,{parentId:a,title:'Child'}),c=new WorkspaceController(s,emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 const before=c.snapshot().revision;let notified=false;const stop=c.subscribe(()=>{notified=true;});
 try{await c.execute({kind:'move',id:child,parent:b,index:0});assert.ok(c.snapshot().revision>before);assert.equal(notified,true);}finally{stop();}
});
test('reviewing the tutorial reuses its tree but opens a fresh independent view each time',async()=>{
 const buffer=createBufferedFs(),s=openSession('/tutorial-views',{ops:buffer.ops}),c=new WorkspaceController(s,emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 const first=await c.execute({kind:'tutorial'}),count=s.state.cards.size,second=await c.execute({kind:'tutorial'});
 assert.equal(first.createdId,second.createdId);assert.equal(s.state.cards.size,count);assert.equal(c.view.openWindows.length,2);
});
