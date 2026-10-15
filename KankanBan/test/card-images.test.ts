import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {openSession,createCard,setField,replayedState} from '../src/core/workspace.ts';
import {executeAction} from '../src/core/actions.ts';
import {stateFingerprint} from '../src/core/subtree.ts';
import {parseCard,serializeCard} from '../src/core/storage/frontmatter.ts';
import type {CardImage} from '../src/core/types.ts';

const image=(changes:Partial<CardImage>={}):CardImage=>({id:'image-1',assetId:`${'a'.repeat(64)}.png`,name:'reference.png',mime:'image/png',width:320,height:200,...changes});
const setup=()=>{let n=0,t=10;const fs=createMemoryFs();const session=openSession('/ws',{ops:fs.ops,newId:()=>`c${++n}`,clock:()=>++t});return {fs,session};};

test('image references and metadata round-trip through card files and replay',()=>{
 const {fs,session:s}=setup(),images=[image()];const id=createCard(s,{parentId:null,images});
 assert.deepEqual(s.state.cards.get(id)?.images,images);
 assert.deepEqual(openSession('/ws',{ops:fs.ops}).state.cards.get(id)?.images,images);
 assert.equal(stateFingerprint(replayedState(s)),stateFingerprint(s.state));
 assert.deepEqual(parseCard(serializeCard(s.state.cards.get(id)!)).images,images);
});

test('image changes undo as one action, while delete undo retains references',()=>{
 const {session:s}=setup(),id=createCard(s,{parentId:null,images:[image()]});const before=stateFingerprint(s.state);
 executeAction(s,{kind:'images-update',id,images:[image({name:'updated.png'})],before:[image()]});
 assert.equal(s.state.cards.get(id)?.images?.[0]?.name,'updated.png');
 executeAction(s,{kind:'undo'});assert.equal(stateFingerprint(s.state),before);
 executeAction(s,{kind:'delete',id});executeAction(s,{kind:'undo'});assert.deepEqual(s.state.cards.get(id)?.images,[image()]);
});

test('stale full image edits do not replace newer user changes',()=>{
 const {session:s}=setup(),id=createCard(s,{parentId:null,images:[image()]});
 executeAction(s,{kind:'images-update',id,images:[image({name:'newer-user.png'})],before:[image()]});
 const before=stateFingerprint(s.state),count=s.events.length;
 assert.throws(()=>executeAction(s,{kind:'images-update',id,images:[],before:[image()]}),/图片.*修改/);
 assert.equal(stateFingerprint(s.state),before);assert.equal(s.events.length,count);
});

test('invalid image metadata is refused before it changes state or disk',()=>{
 const {fs,session:s}=setup(),id=createCard(s,{parentId:null}),before=stateFingerprint(s.state),disk=fs.snapshot();
 const invalid=[null,{},new Array(1),[image({assetId:'../outside.png'})],[image({mime:'image/jpeg'})],[image({assetId:`${'A'.repeat(64)}.png`})],[image({width:0})],[image({width:16385})],[image({height:Infinity})],[{...image(),sourceUrl:'https://example.test'}],[{...image(),sourceNote:'removed feature'}],[image(),image()],[image({id:'bad/id'})],[{...image(),unknown:'extra'}],Array.from({length:65},(_,n)=>image({id:`image-${n}`}))];
 for(const value of invalid){assert.throws(()=>setField(s,id,'/images',value));assert.equal(stateFingerprint(s.state),before);assert.deepEqual(fs.snapshot(),disk);}
 assert.throws(()=>createCard(s,{parentId:null,images:[image({assetId:'invalid'})]}));
 assert.equal(stateFingerprint(s.state),before);
});

test('older image-free files remain readable and empty images have the same fingerprint',()=>{
 const {session:s}=setup(),id=createCard(s,{parentId:null}),fields=s.state.cards.get(id)!;
 const legacy=serializeCard(fields).split('\n').filter(line=>!line.startsWith('images:')).join('\n');
 const restored=parseCard(legacy);assert.deepEqual(restored.images ?? [],[]);
 const withEmpty={...s.state,cards:new Map(s.state.cards)};withEmpty.cards.set(id,{...fields,images:[]});
 assert.equal(stateFingerprint(withEmpty),stateFingerprint(s.state));
 assert.throws(()=>parseCard(legacy.replace('\ntitle:',`\nimages: ${JSON.stringify([{...image(),unknown:'must not be ignored'}])}\ntitle:`)));
});

test('prefab instantiation copies images for every descendant without changing asset IDs',()=>{
 const {session:s}=setup(),parent=createCard(s,{parentId:'003',isPrefab:true,images:[image()]}),child=createCard(s,{parentId:parent,isPrefab:true,images:[image({id:'child-image',name:'child.png'})]});
 const copy=executeAction(s,{kind:'instantiate',id:parent,parent:null}).createdId!,copyChild=s.state.children.get(copy)![0]!.id;
 assert.deepEqual(s.state.cards.get(copy)?.images,[image()]);
 assert.deepEqual(s.state.cards.get(copyChild)?.images,[image({id:'child-image',name:'child.png'})]);
 assert.notEqual(copy,parent);assert.notEqual(copyChild,child);
});

test('explicit prefab synchronization includes image metadata and preserves unrelated edits',()=>{
 const {session:s}=setup(),template=createCard(s,{parentId:'003',isPrefab:true,images:[image()]});
 const first=executeAction(s,{kind:'instantiate',id:template,parent:null}).createdId!,second=executeAction(s,{kind:'instantiate',id:template,parent:null}).createdId!;
 executeAction(s,{kind:'edit',id:second,field:'title',value:'Local title'});
 executeAction(s,{kind:'images-update',id:first,images:[image({name:'instance.png'})],before:[image()]});
 assert.ok(s.state.cards.get(first)?.overrides.includes('images'));
 executeAction(s,{kind:'prefab-sync',id:first,target:'all'});
 for(const id of [template,first,second])assert.equal(s.state.cards.get(id)?.images?.[0]?.name,'instance.png');
 assert.equal(s.state.cards.get(second)?.title,'Local title');
 executeAction(s,{kind:'images-update',id:template,images:[]});executeAction(s,{kind:'prefab-sync',id:template,target:'all'});
 for(const id of [template,first,second])assert.deepEqual(s.state.cards.get(id)?.images ?? [],[]);
});

test('caller arrays do not mutate persisted cards or prefab copies',()=>{
 const {session:s}=setup(),images=[image()],id=createCard(s,{parentId:'003',isPrefab:true,images});
 const copy=executeAction(s,{kind:'instantiate',id,parent:null}).createdId!;
 images[0]!.name='mutated-caller.png';images.push(image({id:'extra'}));
 assert.deepEqual(s.state.cards.get(id)?.images,[image()]);assert.deepEqual(s.state.cards.get(copy)?.images,[image()]);
 const update=[image({name:'new.png'})];executeAction(s,{kind:'images-update',id:copy,images:update});update[0]!.name='later.png';
 assert.equal(s.state.cards.get(copy)?.images?.[0]?.name,'new.png');
 assert.equal(stateFingerprint(replayedState(s)),stateFingerprint(s.state));
});

test('unchanged image lists do not create an operation',()=>{
 const {session:s}=setup(),id=createCard(s,{parentId:null,images:[image()]}),count=s.events.length;
 executeAction(s,{kind:'images-update',id,images:[image()],before:[image()]});assert.equal(s.events.length,count);
});

test('image references recover consistently from every interrupted persistence operation',()=>{
 const {fs,session:s}=setup(),id=createCard(s,{parentId:null,images:[image()]});const seed=fs.snapshot();let writes=0;
 const writing=['mkdirp','writeFile','appendFile','rename','remove','fsync'] as const;
 s.ops={...fs.ops};for(const key of writing){const original=fs.ops[key] as (...args:any[])=>unknown;(s.ops[key] as (...args:any[])=>unknown)=(...args:any[])=>{writes++;return original(...args);};}
 executeAction(s,{kind:'images-update',id,images:[image({name:'committed.png'})],before:[image()]});
 assert.ok(writes>4);
 for(let crash=0;crash<writes;crash++){
  const disk=createMemoryFs();for(const [path,value] of Object.entries(seed)){disk.ops.mkdirp(path.slice(0,path.lastIndexOf('/')));disk.ops.writeFile(path,value);}
  const draft=openSession('/ws',{ops:disk.ops});let at=0;draft.ops={...disk.ops};
  for(const key of writing){const original=disk.ops[key] as (...args:any[])=>unknown;(draft.ops[key] as (...args:any[])=>unknown)=(...args:any[])=>{if(at++===crash)throw new Error('interrupted persistence');return original(...args);};}
  assert.throws(()=>executeAction(draft,{kind:'images-update',id,images:[image({name:'committed.png'})],before:[image()]}),/interrupted persistence/);
  const restored=openSession('/ws',{ops:disk.ops});
  assert.equal(stateFingerprint(restored.state),stateFingerprint(replayedState(restored)),`crash point ${crash}`);
  assert.ok(['reference.png','committed.png'].includes(restored.state.cards.get(id)!.images![0]!.name));
 }
});

test('pasted images append controlled inline image tags and metadata as one undoable operation',()=>{
 const {session:s}=setup(),id=createCard(s,{parentId:null,content:'Notes'}),before=stateFingerprint(s.state);
 executeAction(s,{kind:'images-append',id,images:[image()]});
 assert.equal(s.state.cards.get(id)?.content,`Notes\n<image src="../assets/images/${image().assetId}" layout="inline" name="image_0">reference.png</image>`);
 assert.deepEqual(s.state.cards.get(id)?.images,[image()]);
 executeAction(s,{kind:'undo'});assert.equal(stateFingerprint(s.state),before);
});

test('image insertion uses the intended caret and rejects stale content without partial changes',()=>{
 const {session:s}=setup(),id=createCard(s,{parentId:null,content:'Before\nAfter'});
 executeAction(s,{kind:'images-append',id,images:[image()],beforeContent:'Before\nAfter',offset:7});
 assert.equal(s.state.cards.get(id)?.content,`Before\n<image src="../assets/images/${image().assetId}" layout="inline" name="image_0">reference.png</image>\nAfter`);
 const before=stateFingerprint(s.state),count=s.events.length;
 assert.throws(()=>executeAction(s,{kind:'images-append',id,images:[image()],beforeContent:'Before\nAfter'}));
 assert.equal(stateFingerprint(s.state),before);assert.equal(s.events.length,count);
});

test('repeated asset insertions keep each image tag occurrence but share existing metadata',()=>{
 const {session:s}=setup(),id=createCard(s,{parentId:null});
 executeAction(s,{kind:'images-append',id,images:[image({name:'A [reference].png'})]});
 executeAction(s,{kind:'images-append',id,images:[image({id:'other-import-id',name:'same bytes.png'})]});
 const card=s.state.cards.get(id)!;
 assert.equal(card.content,`<image src="../assets/images/${image().assetId}" layout="inline" name="image_0">A [reference].png</image>\n<image src="../assets/images/${image().assetId}" layout="inline" name="image_1">same bytes.png</image>`);
 assert.deepEqual(card.images,[image({name:'A [reference].png'})]);
});

test('deleted body references release image index quota on append and both steps undo safely',()=>{
 const {session:s}=setup(),oldImages=Array.from({length:64},(_,index)=>image({id:`old-${index}`,assetId:`${(index+1).toString(16).padStart(64,'0')}.png`,name:`old-${index}.png`}));
 const oldBody=oldImages.map(item=>`![${item.name}](../assets/images/${item.assetId})`).join('\n');
 const id=createCard(s,{parentId:null,content:oldBody,images:oldImages});
 executeAction(s,{kind:'edit',id,field:'content',value:'',before:oldBody});
 assert.deepEqual(s.state.cards.get(id)?.images,oldImages);
 executeAction(s,{kind:'images-append',id,images:[image()]});
 assert.deepEqual(s.state.cards.get(id)?.images,[image()]);
 executeAction(s,{kind:'undo'});assert.equal(s.state.cards.get(id)?.content,'');assert.deepEqual(s.state.cards.get(id)?.images,oldImages);
 executeAction(s,{kind:'undo'});assert.equal(s.state.cards.get(id)?.content,oldBody);assert.deepEqual(s.state.cards.get(id)?.images,oldImages);
});

test('referenced images still enforce the quota and keep existing image information',()=>{
 const {session:s}=setup(),images=Array.from({length:64},(_,index)=>image({id:`used-${index}`,assetId:`${(index+1).toString(16).padStart(64,'0')}.png`}));
 const content=images.map(item=>`![${item.name}](../assets/images/${item.assetId})`).join('\n'),id=createCard(s,{parentId:null,content,images}),before=stateFingerprint(s.state);
 assert.throws(()=>executeAction(s,{kind:'images-append',id,images:[image()]}));assert.equal(stateFingerprint(s.state),before);
 executeAction(s,{kind:'images-append',id,images:[{...images[0]!,id:'repeated',name:'do-not-replace.png'}]});
 assert.deepEqual(s.state.cards.get(id)?.images,images);
});

test('append index cleanup and new body references synchronize together across prefab instances',()=>{
 const {session:s}=setup(),old=image({assetId:`${'b'.repeat(64)}.png`,name:'old.png'}),oldBody=`![old](../assets/images/${old.assetId})`;
 const template=createCard(s,{parentId:'003',isPrefab:true,content:oldBody,images:[old]}),instance=executeAction(s,{kind:'instantiate',id:template,parent:null}).createdId!;
 executeAction(s,{kind:'edit',id:instance,field:'content',value:''});executeAction(s,{kind:'images-append',id:instance,images:[image()]});
 executeAction(s,{kind:'prefab-sync',id:instance,target:'all'});
 for(const id of [template,instance]){assert.deepEqual(s.state.cards.get(id)?.images,[image()]);assert.equal(s.state.cards.get(id)?.content,`<image src="../assets/images/${image().assetId}" layout="inline" name="image_0">reference.png</image>`);}
 executeAction(s,{kind:'undo'});assert.deepEqual(s.state.cards.get(template)?.images,[old]);assert.equal(s.state.cards.get(template)?.content,oldBody);
});
