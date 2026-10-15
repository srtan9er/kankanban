import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {openSession,createCard,undoLast,replayedState} from '../src/core/workspace.ts';
import {executeAction} from '../src/core/actions.ts';
import {stateFingerprint} from '../src/core/subtree.ts';
import {validCardImages,copyCardImages,readCardImages,type CardImage} from '../src/core/card-images.ts';
import {buildSharePackage,parseSharePackage} from '../src/core/share-package.ts';

const image:CardImage={id:'attachment',assetId:`${'a'.repeat(64)}.png`,name:'reference.png',mime:'image/png',width:320,height:200};
const retired=(value:CardImage)=>({...value,sourceUrl:'https://example.test/retired',sourceNote:'historical source'});
const oldImageJSON=(value:unknown)=>JSON.stringify(value,(_key,item)=>item && typeof item==='object' && typeof item.assetId==='string' && typeof item.mime==='string' && typeof item.width==='number'?retired(item):item);

test('retired source fields are read only at compatibility boundaries and copying uses a whitelist',()=>{
 assert.equal(validCardImages([image]),true);assert.equal(validCardImages([retired(image)]),false);
 assert.deepEqual(readCardImages([retired(image)]),[image]);assert.deepEqual(copyCardImages([retired(image)]),[image]);
 assert.throws(()=>readCardImages([{...retired(image),unknown:'extra'}]));
});

test('old card files and WAL replay normalize active metadata without rewriting history, including undo',()=>{
 const disk=createMemoryFs();let n=0,t=0;const s=openSession('/legacy',{ops:disk.ops,builtins:false,newId:()=>`c${++n}`,clock:()=>++t});
 const id=createCard(s,{parentId:null,content:`![image](../assets/images/${image.assetId})`,images:[image]}),seed=disk.snapshot();
 executeAction(s,{kind:'images-update',id,images:[{...image,name:'updated.png'}]});executeAction(s,{kind:'delete',id});
 const oldLog=s.events.map(event=>oldImageJSON(event)+'\n').join(''),legacy=createMemoryFs();
 for(const [path,content] of Object.entries(seed)){
  legacy.ops.mkdirp(path.slice(0,path.lastIndexOf('/')));
  legacy.ops.writeFile(path,path.endsWith('.md')?content.replace(/^images: (.*)$/m,(_line,json)=>`images: ${oldImageJSON(JSON.parse(json))}`):content);
 }
 legacy.ops.writeFile('/legacy/.kkb/events.jsonl',oldLog);const before=legacy.snapshot();
 const loaded=openSession('/legacy',{ops:legacy.ops,builtins:false});
 assert.deepEqual(loaded.state.cards.get(id)?.images,[{...image,name:'updated.png'}]);assert.equal(loaded.state.cards.get(id)?.deleted,true);
 assert.equal(stateFingerprint(loaded.state),stateFingerprint(replayedState(loaded)));assert.deepEqual(legacy.snapshot(),before);
 assert.equal(legacy.ops.readFile('/legacy/.kkb/events.jsonl'),oldLog);
 assert.equal(undoLast(loaded),true);assert.equal(loaded.state.cards.get(id)?.deleted,false);assert.deepEqual(loaded.state.cards.get(id)?.images,[{...image,name:'updated.png'}]);
 assert.ok(legacy.ops.readFile('/legacy/.kkb/events.jsonl').includes('historical source'));
 assert.equal(undoLast(loaded),true);assert.deepEqual(loaded.state.cards.get(id)?.images,[image]);
 assert.equal(stateFingerprint(loaded.state),stateFingerprint(replayedState(loaded)));
 assert.equal(legacy.ops.readFile(`/legacy/.kkb/cards/${id}.md`).includes('sourceUrl'),false);
});

test('historical delete snapshots compare equal after removing only retired image fields',()=>{
 const disk=createMemoryFs(),s=openSession('/snapshot',{ops:disk.ops,builtins:false}),id=createCard(s,{parentId:null,images:[image]});
 const oldState={...s.state,cards:new Map(s.state.cards)};oldState.cards.set(id,{...s.state.cards.get(id)!,images:[retired(image)]});
 assert.equal(stateFingerprint(oldState),stateFingerprint(s.state));
 const invalid={...s.state,cards:new Map(s.state.cards)};invalid.cards.set(id,{...s.state.cards.get(id)!,images:[{...retired(image),unknown:'do not discard'} as CardImage]});
 assert.throws(()=>stateFingerprint(invalid));
});

test('new sharing has no source properties and rejects retired source metadata in incoming packages',()=>{
 const disk=createMemoryFs(),s=openSession('/share-six',{ops:disk.ops,builtins:false}),id=createCard(s,{parentId:null,content:`![image](../assets/images/${image.assetId})`,images:[image]});
 const pkg=buildSharePackage(s.state,id,new Map([[image.assetId,'aW1hZ2U=']]));
 assert.equal(JSON.stringify(pkg).includes('sourceUrl'),false);assert.equal(JSON.stringify(pkg).includes('sourceNote'),false);
 const historical=JSON.parse(oldImageJSON(pkg));assert.throws(()=>parseSharePackage(historical));
});
