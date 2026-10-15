import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceController} from '../src/webview/controller.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {emptyViewState} from '../src/core/view-state.ts';
import {markdownEditorParts} from '../src/webview/markdown-editor-model.ts';
const descriptor={assetId:`${'b'.repeat(64)}.png`,name:'shot.png',mime:'image/png',width:2,height:2};
function fixture(){const buffer=createBufferedFs(),disk=createMemoryFs(),s=openSession('/images',{ops:buffer.ops}),id=createCard(s,{parentId:null,title:'Image',content:''});return {disk,id,c:new WorkspaceController(s,emptyViewState(),buffer,toAsync(disk.ops))};}
test('native import finishes before refs are committed; image bytes are never journaled; undo removes only refs',async()=>{
 const {c,id,disk}=fixture();
 await c.execute({kind:'images-import',id,inputs:[{name:'shot.png',base64:'PRIVATE_BYTES'}]},undefined,async(tool)=>{assert.equal(tool,'images-import');assert.equal(c.session.state.cards.get(id)!.images?.length ?? 0,0);return [descriptor];});
 assert.equal(c.session.state.cards.get(id)!.images?.length,1);
 assert.equal(c.session.state.cards.get(id)!.content,`<image src="../assets/images/${descriptor.assetId}" layout="inline" name="image_0">shot.png</image>`);
 assert.deepEqual(markdownEditorParts(c.session.state.cards.get(id)!.content).filter(part=>part.atomic).map(part=>part.index),[0]);
 assert.ok(!disk.ops.readFile('/images/.kkb/operations.jsonl').includes('PRIVATE_BYTES'));
 await c.execute({kind:'undo'});assert.equal(c.session.state.cards.get(id)!.images?.length ?? 0,0);assert.equal(c.session.state.cards.get(id)!.content,'');
});
test('a rejected native image leaves card refs unchanged',async()=>{
 const {c,id}=fixture();await assert.rejects(c.execute({kind:'images-import',id,inputs:[{name:'bad.png',base64:'bad'}]},undefined,async()=>{throw new Error('invalid raster');}),/invalid raster/);
 assert.equal(c.session.state.cards.get(id)!.images?.length ?? 0,0);
});
test('clipboard insertion rejects a changed draft before native import or partial writes',async()=>{
 const {c,id}=fixture();await c.execute({kind:'edit',id,field:'content',value:'New text'});let imports=0;
 await assert.rejects(c.execute({kind:'images-import',id,beforeContent:'Old text',offset:3,inputs:[{name:'shot.png',base64:'test'}]},undefined,async()=>{imports++;return [descriptor];}),/图片已被其他操作修改/);
 assert.equal(imports,0);assert.equal(c.session.state.cards.get(id)!.content,'New text');assert.equal(c.session.state.cards.get(id)!.images?.length ?? 0,0);
});
