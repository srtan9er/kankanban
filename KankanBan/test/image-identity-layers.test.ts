import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {executeAction} from '../src/core/actions.ts';
import {parseCardImages,serializeImage} from '../src/core/image-markdown.ts';
import {imageNames,nameInsertedImages,ensureImageNames} from '../src/core/image-identity.ts';
import {imageStack,imageLayerActions,shiftImageLayer} from '../src/core/image-layers.ts';
import {markdownEditorParts} from '../src/webview/markdown-editor-model.ts';
const assetId='a'.repeat(64)+'.png',image={id:'one',assetId,name:'photo.png',mime:'image/png' as const,width:160,height:80};
const tag=(name:string,layout='float',layer?:number)=>`<image src="../assets/images/${assetId}" layout="${layout}" name="${name}" width="160" height="80" x="10" y="20"${layer===undefined?'':` layer="${layer}"`}>photo</image>`;
test('per-card names persist through order changes, deletion, append, reload and undo',()=>{
 const fs=createMemoryFs(),s=openSession('/stable-images',{ops:fs.ops}),id=createCard(s,{parentId:null});
 executeAction(s,{kind:'images-append',id,images:[image,{...image,id:'two'}]});let content=s.state.cards.get(id)!.content;assert.deepEqual(imageNames(parseCardImages(content)),['image_0','image_1']);
 const reversed=content.split('\n').reverse().join('\n');executeAction(s,{kind:'edit',id,field:'content',value:reversed,before:content});content=s.state.cards.get(id)!.content;assert.deepEqual(markdownEditorParts(content).filter(part=>part.atomic).map(part=>part.name),['image_1','image_0']);
 const first=parseCardImages(content)[0]!;executeAction(s,{kind:'edit',id,field:'content',value:content.slice(first.start,first.end),before:content});executeAction(s,{kind:'images-append',id,images:[image]});content=s.state.cards.get(id)!.content;assert.deepEqual(imageNames(parseCardImages(content)),['image_1','image_2']);
 assert.equal(openSession('/stable-images',{ops:fs.ops}).state.cards.get(id)!.content,content);executeAction(s,{kind:'undo'});assert.deepEqual(imageNames(parseCardImages(s.state.cards.get(id)!.content)),['image_1']);
});
test('copying an atom gets a fresh name, while moving a cut atom retains its name',()=>{
 const original=tag('image_8'),copy=nameInsertedImages(original,original);assert.equal(parseCardImages(copy)[0]!.name,'image_9');assert.equal(nameInsertedImages(original,''),original);
 assert.deepEqual(imageNames(parseCardImages(ensureImageNames(copy+'\n'+original,original))),['image_9','image_8']);
 const resized=serializeImage(parseCardImages(original)[0]!,{width:200});assert.equal(parseCardImages(resized)[0]!.name,'image_8');
});
test('one layer step changes only painting order and keeps source position, name and layout',()=>{
 const body='before\n'+[tag('image_7'),tag('image_3','overlay'),tag('image_11')].join('\n')+'\nafter';
 const value=shiftImageLayer(body,0,'up'),refs=parseCardImages(value);assert.deepEqual(imageStack(refs),[3,2,4]);assert.deepEqual(imageNames(refs),['image_7','image_3','image_11']);assert.deepEqual(refs.map(ref=>ref.layout),['float','overlay','float']);assert.ok(value.startsWith('before\n') && value.endsWith('\nafter'));assert.ok(refs.every(ref=>ref.x===10 && ref.y===20));
 assert.deepEqual(imageStack(parseCardImages(shiftImageLayer(value,0,'down'))),[2,3,4]);assert.equal(shiftImageLayer(body,2,'up'),body);
});
test('underlay order stays below text and cannot move into the foreground band',()=>{
 const body=[tag('image_0','underlay'),tag('image_1','underlay'),tag('image_2','overlay')].join('\n'),refs=parseCardImages(body);assert.deepEqual(imageStack(refs),[-1,0,2]);
 const changed=parseCardImages(shiftImageLayer(body,0,'up'));assert.deepEqual(imageStack(changed),[0,-1,2]);assert.ok(changed.slice(0,2).every(ref=>ref.layout==='underlay'));assert.deepEqual(imageLayerActions(changed,0),{up:false,down:true});assert.deepEqual(imageLayerActions(refs,2),{up:false,down:false});
});
