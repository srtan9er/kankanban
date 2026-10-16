import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceController} from '../src/webview/controller.ts';
import {TUTORIAL_EDITION} from '../src/core/tutorial.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {emptyViewState} from '../src/core/view-state.ts';

function fixture(){
 const buffer=createBufferedFs(),disk=createMemoryFs(),session=openSession('/tutorial-assets',{ops:buffer.ops});
 const controller=new WorkspaceController(session,emptyViewState(),buffer,toAsync(disk.ops));
 return {buffer,disk,session,controller};
}

test('tutorial asset import completes before the learning tree or view is created',async()=>{
 const {session,controller:c}=fixture(),count=session.state.cards.size;
 let imports=0,release!:()=>void;
 const pending=new Promise<void>(resolve=>{release=resolve;});
 c.prepareTutorialAssets=async()=>{imports++;assert.equal(session.state.cards.size,count);assert.equal(c.view.tutorialCardId,undefined);await pending;};
 const execution=c.execute({kind:'tutorial'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(imports,1,'a new tutorial must import its assets before creating cards');
 assert.equal(session.state.cards.size,count);assert.equal(c.view.tutorialCardId,undefined);
 release();const result=await execution;
 assert.ok(session.state.cards.size>count);assert.equal(c.view.tutorialCardId,result.createdId);
});

test('a failed tutorial asset import preserves the existing tree, view and saved files',async()=>{
 const {session,controller:c,disk}=fixture();createCard(session,{parentId:null,title:'Keep this work',content:'Do not replace'});
 await c.flush();
 const before={cards:[...session.state.cards],children:[...session.state.children],seq:session.state.lastAppliedSeq,events:[...session.events],view:structuredClone(c.view),files:disk.snapshot()};
 c.prepareTutorialAssets=async()=>{throw new Error('asset import failed');};
 await assert.rejects(c.execute({kind:'tutorial'}),/asset import failed/);
 assert.deepEqual([...session.state.cards],before.cards);assert.deepEqual([...session.state.children],before.children);
 assert.equal(session.state.lastAppliedSeq,before.seq);assert.deepEqual(session.events,before.events);
 assert.deepEqual(c.view,before.view);assert.deepEqual(disk.snapshot(),before.files);
});

test('reviewing a current learning copy does not import its assets again',async()=>{
 const {session,controller:c}=fixture();let imports=0;c.prepareTutorialAssets=async()=>{imports++;};
 const first=await c.execute({kind:'tutorial'}),count=session.state.cards.size;
 const second=await c.execute({kind:'tutorial'});
 assert.equal(imports,1);assert.equal(c.view.tutorialEdition,TUTORIAL_EDITION);
 assert.equal(first.createdId,second.createdId);assert.equal(session.state.cards.size,count);
 assert.equal(c.view.openWindows.length,2);
});

test('upgrading an old learning copy imports assets before creating the new edition',async()=>{
 const {session,controller:c}=fixture();const first=await c.execute({kind:'tutorial'}),count=session.state.cards.size;
 c.view={...c.view,tutorialEdition:TUTORIAL_EDITION-1};let imports=0;
 c.prepareTutorialAssets=async()=>{imports++;assert.equal(session.state.cards.size,count);assert.equal(c.view.tutorialCardId,first.createdId);};
 const updated=await c.execute({kind:'tutorial'});
 assert.equal(imports,1);assert.notEqual(updated.createdId,first.createdId);assert.ok(session.state.cards.get(first.createdId!));
 assert.equal(c.view.tutorialEdition,TUTORIAL_EDITION);
});

test('a missing or deleted current tutorial still requires its asset import',async()=>{
 for(const deleted of [false,true]){
  const {session,controller:c}=fixture();const id=createCard(session,{parentId:null,title:'Prior tutorial'});
  if(deleted)session.state.cards.get(id)!.deleted=true;
  const previousId=deleted?id:'missing-tutorial';
  c.view={...c.view,tutorialCardId:previousId,tutorialEdition:TUTORIAL_EDITION};
  let imports=0;c.prepareTutorialAssets=async()=>{imports++;};
  const result=await c.execute({kind:'tutorial'});
  assert.equal(imports,1);assert.notEqual(result.createdId,previousId);
 }
});
