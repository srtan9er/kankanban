import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import '../src/node/bootstrap.ts';
import {createCard,openSession,setField,undoLast,type Session} from '../src/core/workspace.ts';
import {buildSharePackage,parseSharePackage,shareAssetIds,importSharePackage,type SharePackage} from '../src/core/share-package.ts';
import {stateFingerprint} from '../src/core/subtree.ts';
import type {CardImage} from '../src/core/card-images.ts';
import {parseCardImages} from '../src/core/image-markdown.ts';

const assetId='a'.repeat(64)+'.png',otherAsset='b'.repeat(64)+'.png';
const markdown=(asset=assetId)=>`![reference](../assets/images/${asset})`;
const body=`Read this\n\n${markdown()}`;
const image=(id='attachment'):CardImage=>({id,assetId,name:'reference.png',mime:'image/png',width:320,height:240});
function withSession(body:(s:Session)=>void,builtins=false):void{const root=mkdtempSync(join(tmpdir(),'kkb-sharing-'));try{body(openSession(root,{builtins,clientId:'author'}));}finally{rmSync(root,{recursive:true,force:true});}}
function fixture(s:Session):string{
 const root=createCard(s,{parentId:null,title:'Idea',content:body,layout:'plane',images:[image()]});
 createCard(s,{parentId:root,title:'child',content:markdown(),images:[image('child-attachment')],plane:{x:10,y:-20,w:220,h:100,z:3}});
 setField(s,root,'/createdBy','private signature');setField(s,root,'/prefabBase','private baseline');
 return root;
}
const packageFor=(s:Session,id:string)=>buildSharePackage(s.state,id,new Map([[assetId,'aW1hZ2U=']]));
const copy=(p:SharePackage):any=>JSON.parse(JSON.stringify(p));

test('subtree package contains only selected content, image metadata and used images',()=>withSession(s=>{
 const root=fixture(s);createCard(s,{parentId:null,title:'private unrelated card'});
 const pkg=packageFor(s,root);
 assert.equal(pkg.cards.length,2);assert.equal(pkg.cards[0]!.title,'Idea');assert.equal(pkg.cards[1]!.images[0]!.name,'reference.png');
 assert.equal(JSON.stringify(pkg).includes('sourceUrl'),false);assert.equal(JSON.stringify(pkg).includes('sourceNote'),false);
 assert.deepEqual(shareAssetIds(s.state,root),[assetId]);assert.deepEqual(pkg.assets,[{assetId,base64:'aW1hZ2U='}]);
 assert.equal(JSON.stringify(pkg).includes('private signature'),false);assert.equal(JSON.stringify(pkg).includes('private baseline'),false);
 assert.equal(JSON.stringify(pkg).includes('private unrelated card'),false);assert.equal(JSON.stringify(pkg).includes('createdAt'),false);
 assert.deepEqual(parseSharePackage(pkg),pkg);
}));

test('import preserves positions and image metadata with fresh identities, persists, and undoes as one transaction',()=>withSession(s=>{
 const original=fixture(s),pkg=packageFor(s,original),before=stateFingerprint(s.state),parent=createCard(s,{parentId:null,title:'destination'}),baseline=stateFingerprint(s.state);
 const imported=importSharePackage(s,pkg,parent);assert.equal(imported.ids.length,2);assert.notEqual(imported.rootId,original);
 assert.equal(s.state.children.get(parent)![0]!.id,imported.rootId);
 const childEntry=s.state.children.get(imported.rootId)![0]!;assert.deepEqual({...childEntry,id:'child'}, {id:'child',x:10,y:-20,w:220,h:100,z:3});
 const fields=s.state.cards.get(imported.rootId)!;assert.equal(fields.content,body);assert.notEqual(fields.images![0]!.id,'attachment');assert.equal(fields.images![0]!.name,'reference.png');
 assert.equal(fields.prefabBase,null);assert.equal(fields.createdBy,'author');
 const reopened=openSession(s.root,{builtins:false});assert.equal(stateFingerprint(reopened.state),stateFingerprint(s.state));
 assert.equal(undoLast(s),true);assert.equal(stateFingerprint(s.state),baseline);assert.notEqual(before,baseline);
}));

test('malformed packages reject before changing the destination',()=>withSession(s=>{
 const root=fixture(s),pkg=packageFor(s,root),baseline=stateFingerprint(s.state),count=s.events.length;
 const bad=[] as unknown[];
 const duplicate=copy(pkg);duplicate.cards.push(duplicate.cards[0]);bad.push(duplicate);
 const cycle=copy(pkg);cycle.children.push({parentId:cycle.cards[1].id,entries:[{id:root}]});bad.push(cycle);
 const dangling=copy(pkg);dangling.children[0].entries[0].id='missing';bad.push(dangling);
 const missing=copy(pkg);missing.assets=[];bad.push(missing);
 const unused=copy(pkg);unused.assets.push({assetId:otherAsset,base64:'aW1hZ2U='});bad.push(unused);
 const duplicateAsset=copy(pkg);duplicateAsset.assets.push(duplicateAsset.assets[0]);bad.push(duplicateAsset);
 const path=copy(pkg);path.assets[0].assetId='../secret';bad.push(path);
 const contamination=JSON.parse(JSON.stringify(pkg));contamination.cards[0].__proto__={polluted:true};bad.push(contamination);
 const jsonContamination=copy(pkg);Object.defineProperty(jsonContamination.cards[0],'__proto__',{value:{polluted:true},enumerable:true});bad.push(JSON.parse(JSON.stringify(jsonContamination)));
 const control=copy(pkg);control.cards[0].images[0].sourceUrl='javascript:alert(1)';bad.push(control);
 const nonfinite=copy(pkg);nonfinite.children[0].entries[0].x=Infinity;bad.push(nonfinite);
 const dimensions=copy(pkg);dimensions.cards[1].images[0].width=999;bad.push(dimensions);
 const corruptBase64=copy(pkg);corruptBase64.assets[0].base64='a===notbase64';bad.push(corruptBase64);
 const invalidPadding=copy(pkg);invalidPadding.assets[0].base64='ab==';bad.push(invalidPadding);
 const tooMany=copy(pkg);tooMany.cards=Array.from({length:10001},(_,i)=>({...tooMany.cards[0],id:'n'+i}));bad.push(tooMany);
 for(const invalid of bad){assert.throws(()=>parseSharePackage(invalid));assert.throws(()=>importSharePackage(s,invalid,null));assert.equal(stateFingerprint(s.state),baseline);assert.equal(s.events.length,count);}
 assert.equal(({} as any).polluted,undefined);
}));

test('rejects import into a fixed board, preserving all three columns',()=>withSession(s=>{
 const root=fixture(s),pkg=packageFor(s,root);const board=createCard(s,{parentId:null,title:'board',layout:'columns'});
 for(let i=0;i<3;i++)createCard(s,{parentId:board,title:String(i)});
 const before=stateFingerprint(s.state);assert.throws(()=>importSharePackage(s,pkg,board));assert.equal(stateFingerprint(s.state),before);
}));

test('ordinary imports detach prefab links while prefab-library imports become templates',()=>withSession(s=>{
 const root=fixture(s);setField(s,root,'/isPrefab',true);const child=s.state.children.get(root)![0]!.id;setField(s,child,'/prefabRef',root);
 const pkg=packageFor(s,root),ordinary=importSharePackage(s,pkg,null);assert.equal(ordinary.ids.length,2);for(const id of ordinary.ids){assert.equal(s.state.cards.get(id)!.isPrefab,false);assert.equal(s.state.cards.get(id)!.prefabRef,null);}
 const templates=importSharePackage(s,pkg,'003');assert.equal(templates.ids.length,2);for(const id of templates.ids){assert.equal(s.state.cards.get(id)!.isPrefab,true);assert.equal(s.state.cards.get(id)!.prefabRef,null);}
},true));

test('import maps internal display references and doodle card membership, detaching external references',()=>withSession(s=>{
 const root=fixture(s),child=s.state.children.get(root)![0]!.id;
 setField(s,root,'/doodle',{version:1,id:'ink',width:500,height:500,strokes:[{id:'stroke',color:'text',width:3,points:[{x:1,y:2}]}],groups:[{strokes:['stroke'],cards:[child]}]});
 setField(s,child,'/type',root);const pkg=packageFor(s,root),imported=importSharePackage(s,pkg,null),newChild=s.state.children.get(imported.rootId)![0]!.id;
 assert.equal(s.state.cards.get(newChild)!.type,imported.rootId);assert.deepEqual(s.state.cards.get(imported.rootId)!.doodle!.groups![0]!.cards,[newChild]);
 const external=createCard(s,{parentId:null,title:'display',layout:'grid'});setField(s,child,'/type',external);const detached=packageFor(s,root).cards.find(c=>c.id===child)!;assert.equal(detached.type,null);assert.equal(detached.layout,'grid');
}));

test('all descendants and horizontal order survive sharing without depending on numeric order gaps',()=>withSession(s=>{
 const root=createCard(s,{parentId:null,title:'collection',layout:'ordered'});
 for(const title of ['first','second','third']){const child=createCard(s,{parentId:root,title,layout:'ordered'});createCard(s,{parentId:child,title:title+' child'});}
 const pkg=buildSharePackage(s.state,root,new Map()),imported=importSharePackage(s,pkg,null);assert.equal(imported.ids.length,7);
 const entries=s.state.children.get(imported.rootId)!;assert.deepEqual(entries.map(e=>s.state.cards.get(e.id)!.title),['first','second','third']);
 for(const entry of entries)assert.equal(s.state.children.get(entry.id)!.length,1);
 assert.equal(new Set(imported.ids).size,7);
}));

test('failed identity allocation and invalid targets leave state and event log untouched',()=>withSession(s=>{
 const root=fixture(s),pkg=packageFor(s,root),before=stateFingerprint(s.state),events=s.events.length;
 assert.throws(()=>importSharePackage(s,pkg,'missing'));assert.equal(s.events.length,events);
 const generator=s.newId;s.newId=()=>root;assert.throws(()=>importSharePackage(s,pkg,null));s.newId=generator;
 assert.equal(stateFingerprint(s.state),before);assert.equal(s.events.length,events);
 const parent=createCard(s,{parentId:null,title:'canvas',layout:'plane'}),canvasBaseline=stateFingerprint(s.state);
 assert.throws(()=>importSharePackage(s,pkg,parent));assert.throws(()=>importSharePackage(s,pkg,parent,{x:0,y:0,w:-1,h:100,z:0}));
 assert.equal(stateFingerprint(s.state),canvasBaseline);
 const imported=importSharePackage(s,pkg,parent,{x:12,y:34,w:220,h:100,z:9});assert.deepEqual(s.state.children.get(parent),[{id:imported.rootId,x:12,y:34,w:220,h:100,z:9}]);
}));

test('a packaged board preserves exactly three ordered columns, while a broken board is rejected',()=>withSession(s=>{
 const root=createCard(s,{parentId:null,title:'board',layout:'columns'});
 for(let i=0;i<3;i++)createCard(s,{parentId:root,title:'column'+i});
 const pkg=buildSharePackage(s.state,root,new Map()),imported=importSharePackage(s,pkg,null);assert.equal(s.state.children.get(imported.rootId)!.length,3);
 const broken=copy(pkg);broken.children[0].entries.pop();broken.cards.pop();assert.throws(()=>parseSharePackage(broken));
}));

test('body Markdown alone determines shared images; orphan metadata stays local for undo',()=>withSession(s=>{
 const root=createCard(s,{parentId:null,title:'text',content:'No image here',images:[image()]});
 assert.deepEqual(shareAssetIds(s.state,root),[]);
 const pkg=buildSharePackage(s.state,root,new Map());assert.deepEqual(pkg.assets,[]);assert.deepEqual(pkg.cards[0]!.images,[]);
 assert.equal(s.state.cards.get(root)!.images!.length,1);
 setField(s,root,'/content',markdown());assert.deepEqual(shareAssetIds(s.state,root),[assetId]);
}));

test('repeated body references share one asset and body paths remain unchanged on import',()=>withSession(s=>{
 const text=markdown()+'\n\n'+markdown(),root=createCard(s,{parentId:null,title:'repeat',content:text,images:[image()]});
 const pkg=packageFor(s,root);assert.equal(pkg.assets.length,1);assert.equal(pkg.cards[0]!.images.length,1);
 const imported=importSharePackage(s,pkg,null);assert.equal(s.state.cards.get(imported.rootId)!.content,text);
}));

test('local body image references require metadata or a native-verified descriptor before sharing',()=>withSession(s=>{
 const root=createCard(s,{parentId:null,title:'unresolved image',content:markdown()});
 assert.deepEqual(shareAssetIds(s.state,root),[assetId]);assert.throws(()=>packageFor(s,root));
 const pkgWithFallback=buildSharePackage(s.state,root,new Map([[assetId,'aW1hZ2U=']]),new Map([[assetId,{name:'verified.png',mime:'image/png',width:320,height:240}]]));
 assert.equal(Object.hasOwn(pkgWithFallback.cards[0]!.images[0]!,'sourceUrl'),false);assert.equal(Object.hasOwn(pkgWithFallback.cards[0]!.images[0]!,'sourceNote'),false);assert.equal(pkgWithFallback.cards[0]!.images[0]!.width,320);
 assert.deepEqual(parseSharePackage(pkgWithFallback),pkgWithFallback);assert.equal(s.state.cards.get(root)!.images,undefined);
 const another=createCard(s,{parentId:null,title:'known image',content:markdown(),images:[image()]});
 const pkg=packageFor(s,another),missing=copy(pkg);missing.cards[0].images=[];assert.throws(()=>parseSharePackage(missing));
}));

test('Markdown examples in code are not shared, and unused metadata is excluded from the package',()=>withSession(s=>{
 const text=markdown()+'\n\n`'+markdown(otherAsset)+'`\n\n```markdown\n'+markdown(otherAsset)+'\n```';
 const unused={...image('unused'),assetId:otherAsset,name:'private stale metadata'};
 const root=createCard(s,{parentId:null,title:'examples',content:text,images:[image(),unused]});
 assert.deepEqual(shareAssetIds(s.state,root),[assetId]);
 const pkg=packageFor(s,root);assert.equal(pkg.cards[0]!.images.length,1);assert.equal(JSON.stringify(pkg).includes('private stale metadata'),false);
 const polluted=copy(pkg);polluted.cards[0].images.push(unused);assert.throws(()=>parseSharePackage(polluted));
}));

test('legacy paragraph image tags remain portable without rewriting their body, rendering as inline',()=>withSession(s=>{
 const legacy=`Before\n\n<image src="../assets/images/${assetId}" layout="block" width="240" height="160">reference</image>\n\nAfter`;
 const root=createCard(s,{parentId:null,title:'legacy image',content:legacy,images:[image()]});
 const pkg=packageFor(s,root);assert.deepEqual(pkg.assets,[{assetId,base64:'aW1hZ2U='}]);assert.equal(pkg.cards[0]!.content,legacy);
 const imported=importSharePackage(s,pkg,null),content=s.state.cards.get(imported.rootId)!.content;
 assert.equal(content,legacy);assert.equal(parseCardImages(content)[0]!.layout,'inline');
 assert.equal(openSession(s.root,{builtins:false}).state.cards.get(imported.rootId)!.content,legacy);
}));
