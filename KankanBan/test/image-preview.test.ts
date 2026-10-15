import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cardImagePreview, imageRequestSummary,imageFileInputs} from '../src/webview/image-input.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {hydrate,toAsync} from '../src/platform/async-fs-ops.ts';
const image={id:'image1',assetId:`${'a'.repeat(64)}.png`,name:'shot.png',mime:'image/png' as const,width:20,height:10};
const markdown=`![shot](../assets/images/${image.assetId})`;
test('image-only classification follows body references and preserves repeated images',()=>{
 const preview=cardImagePreview({content:`${markdown}\n${markdown}`,images:[image]});
 assert.equal(preview.imageOnly,true);assert.equal(preview.text,'');assert.equal(preview.images.length,2);
});
test('mixed previews preserve text and replace each image with the named object fields',()=>{
 const preview=cardImagePreview({content:`My ${markdown} idea\n${markdown}`,images:[image]});
 assert.equal(preview.imageOnly,false);assert.equal(preview.text,'My <image_0> idea\n<image_1>');
 assert.equal(cardImagePreview({content:'Only text'}).text,'Only text');
 assert.equal(cardImagePreview({content:'',images:[image]}).imageOnly,false);
});
test('unknown image destinations remain visible markers alongside local images',()=>{
 const preview=cardImagePreview({content:`${markdown}\n![remote](https://example.com/image.png)`,images:[image]});
 assert.equal(preview.imageOnly,false);assert.equal(preview.text,'<image_0>\n<image_1>');
});
test('image import operation summaries do not record clipboard bytes or source file paths',()=>{
 const summary=imageRequestSummary({kind:'images-import',id:'card1',inputs:[{name:'shot.png',base64:'PRIVATE_BYTES'},{name:'file.jpg',path:'C:/private/file.jpg'}]});
 assert.deepEqual(summary,{kind:'images-import',id:'card1',images:['shot.png','file.jpg']});
});
test('hydration never reads binary assets into the UTF8 live mirror',async()=>{
 const disk=createMemoryFs();disk.ops.mkdirp('/project/.kkb/assets/images');disk.poke('/project/.kkb/assets/images/a.png','binary');disk.poke('/project/.kkb/normal.json','{}');
 const memory=createMemoryFs(),base=toAsync(disk.ops),reads:string[]=[];
 await hydrate(memory,{...base,readFile:async path=>{reads.push(path);return base.readFile(path);}},'/project/.kkb');
 assert.deepEqual(reads,['/project/.kkb/normal.json']);assert.equal(memory.ops.exists('/project/.kkb/assets'),false);
});
test('an oversized clipboard batch is rejected before reading or allocating base64',async()=>{
 let reads=0;const previous=globalThis.FileReader;
 Object.assign(globalThis,{FileReader:class{result='data:image/png;base64,YQ==';onload?:()=>void;readAsDataURL(){reads++;this.onload?.();}}});
 try{await assert.rejects(imageFileInputs(Array.from({length:64},()=>({name:'screenshot.png',type:'image/png',size:20*1024*1024}) as File)),/150 MiB/);assert.equal(reads,0);}finally{Object.assign(globalThis,{FileReader:previous});}
});
