import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {OperationJournal,type Actor} from '../src/core/collaboration.ts';
const user:Actor={kind:'user',id:'user',name:'玩家'},ai:Actor={kind:'ai',id:'codex',name:'Codex'},other:Actor={kind:'ai',id:'helper',name:'伙伴 AI'};
test('foreign operations must be read before acting; own actions do not invalidate receipt',()=>{
 const fs=createMemoryFs(),j=new OperationJournal('/w',fs.ops,()=>123,()=>crypto.randomUUID());
 j.append(user,'doodle-update',{id:'ink',strokes:0});j.append(other,'move',{id:'task',parent:'done'});
 assert.throws(()=>j.assertReviewed(ai));
 const first=j.read(ai);assert.equal(first.operations.length,2);assert.ok(first.reviewToken);j.assertReviewed(ai,first.reviewToken);
 j.append(ai,'create',{id:'own'});j.assertReviewed(ai,first.reviewToken);
 j.append(user,'delete',{id:'own'});assert.throws(()=>j.assertReviewed(ai,first.reviewToken));
 const next=j.read(ai,first.reviewToken);assert.equal(next.operations.length,1);assert.equal(next.operations[0]!.operation,'delete');
 assert.equal(next.operations[0]!.actor.name,'玩家');assert.equal(next.operations[0]!.timestamp,123);
 assert.throws(()=>j.assertReviewed(other,next.reviewToken));
 const restored=new OperationJournal('/w',fs.ops,()=>124,()=>crypto.randomUUID());assert.equal(restored.read(ai,next.reviewToken).operations.length,3);
});
test('pagination cannot acknowledge unread pages, and concurrent changes invalidate a receipt',()=>{
 const fs=createMemoryFs(),j=new OperationJournal('/w',fs.ops,()=>123,()=>crypto.randomUUID());
 for(let n=0;n<105;n++)j.append(user,'edit',{id:String(n)});
 const page=j.read(ai);assert.equal(page.operations.length,100);assert.equal(page.reviewToken,undefined);assert.ok(page.nextCursor);
 assert.throws(()=>j.assertReviewed(ai,page.nextCursor));
 const end=j.read(ai,undefined,page.nextCursor);assert.equal(end.operations.length,5);j.assertReviewed(ai,end.reviewToken);
 j.append(user,'edit',{id:'new'});assert.throws(()=>j.assertReviewed(ai,end.reviewToken));
});
test('an interrupted last append is repaired while complete-line corruption fails visibly',()=>{
 const fs=createMemoryFs(),j=new OperationJournal('/w',fs.ops,()=>123,()=>crypto.randomUUID());j.append(user,'edit',{id:'one'});
 fs.ops.appendFile('/w/.kkb/operations.jsonl','{"seq":2');
 const restored=new OperationJournal('/w',fs.ops,()=>124,()=>crypto.randomUUID());assert.equal(restored.operations.length,1);restored.append(user,'edit',{id:'two'});
 assert.equal(new OperationJournal('/w',fs.ops,()=>125,()=>crypto.randomUUID()).operations.length,2);
 fs.ops.appendFile('/w/.kkb/operations.jsonl','bad\n');assert.throws(()=>new OperationJournal('/w',fs.ops,()=>125,()=>crypto.randomUUID()),/损坏/);
});
