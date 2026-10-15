import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCardImages} from '../src/core/image-markdown.ts';
import {safeFlowOffset,moveFlowImage,fragmentSourceMap,flowCaretFromPoint} from '../src/webview/flow-image-drag.ts';
const asset='a'.repeat(64)+'.png',token=`<image src="../assets/images/${asset}" layout="inline" width="160" height="80">甲 &amp; 图</image>`;
test('flow move reorders exactly one image token across paragraphs without changing its geometry or other text',()=>{
 const source='前面\n'+token+'\n后来😀';const reference=parseCardImages(source)[0]!;
 const result=moveFlowImage(source,reference,source.indexOf('😀'));
 assert.equal(result.value,'前面\n\n后来'+token+'😀');
 const moved=parseCardImages(result.value)[0]!;assert.equal(moved.layout,'inline');assert.equal(moved.width,160);assert.equal(moved.height,80);assert.equal(moved.alt,'甲 & 图');assert.equal(moved.assetId,asset);
 assert.equal(moveFlowImage(source,reference,reference.start+3).value,source);
 const up=moveFlowImage(source,reference,1);assert.equal(up.value,'前'+token+'面\n\n后来😀');
});
test('drop boundaries cannot split other image tags, code, links, Markdown delimiters or emoji graphemes',()=>{
 const text=token+'\n**文字** [链接](https://example.test/a) `code`\n```ts\ncode here\n```\n尾巴👩🏽‍💻';
 const ref=parseCardImages(text)[0]!;
 assert.ok([ref.start,ref.end].includes(safeFlowOffset(text,10)));
 const link=text.indexOf('[链接]'),code=text.indexOf('`code`'),fence=text.indexOf('```ts');
 assert.ok([link,link+'[链接](https://example.test/a)'.length].includes(safeFlowOffset(text,link+2)));
 assert.ok([code,code+6].includes(safeFlowOffset(text,code+3)));
 assert.ok([fence,text.indexOf('尾巴')].includes(safeFlowOffset(text,text.indexOf('code here')+3)));
 const strong=text.indexOf('**文字');assert.notEqual(safeFlowOffset(text,strong+1),strong+1);
 const emoji=text.indexOf('👩');assert.ok([emoji,text.length].includes(safeFlowOffset(text,emoji+3)));
});
test('fragment maps retain collapsed whitespace and UTF16 source offsets for Pretext fragments',()=>{
 const source='甲   乙😀  丙',first=fragmentSourceMap(source,'甲 乙😀',40);
 assert.deepEqual(first.offsets,[40,41,44,45,46,47]);
 const last=fragmentSourceMap(source,'丙',40,first.next);assert.deepEqual(last.offsets,[49,50]);
});
test('dropping beside a code fence keeps both delimiters intact and never appends into an unfinished fence',()=>{
 const source=token+'\n```ts\nconst demo=1;\n```';const reference=parseCardImages(source)[0]!,fence=source.indexOf('```ts');
 const before=moveFlowImage(source,reference,fence);assert.equal(parseCardImages(before.value).length,1);assert.ok(before.value.includes('\n```ts\nconst demo=1;\n```'));
 const after=moveFlowImage(source,reference,source.length);assert.equal(parseCardImages(after.value).length,1);assert.ok(after.value.includes('\n```\n'+token));
 const unfinished='prefix\n```ts\ncode';assert.equal(safeFlowOffset(unfinished,unfinished.length),unfinished.indexOf('```ts'));
});
test('browser text caret resolves visible Markdown text back to its own source range',()=>{
 const host=document.createElement('div');host.innerHTML='<strong data-source-start="7" data-source-end="13">文字😀尾巴</strong>';document.body.append(host);
 const leaf=host.querySelector('strong')!,old=(document as any).caretPositionFromPoint;
 (document as any).caretPositionFromPoint=()=>({offsetNode:leaf.firstChild,offset:4});
 try{const target=flowCaretFromPoint(host,'prefix 文字😀尾巴',50,70);assert.ok(target);assert.equal(target.offset,11);assert.ok(target.height>0);}finally{host.remove();if(old)(document as any).caretPositionFromPoint=old;else delete(document as any).caretPositionFromPoint;}
});
test('image-only flow finds insertion boundaries beside images without splitting their tokens',()=>{
 const text=token+'\n'+token,refs=parseCardImages(text),host=document.createElement('div');document.body.append(host);
 try{refs.forEach((reference,index)=>{const frame=document.createElement('div');frame.className='image-placement';frame.dataset.layout='inline';frame.dataset.sourceImageStart=String(reference.start);frame.dataset.sourceImageEnd=String(reference.end);frame.getBoundingClientRect=()=>({left:10,top:index*100,right:170,bottom:index*100+80,width:160,height:80,x:10,y:index*100,toJSON(){}});host.append(frame);});const target=flowCaretFromPoint(host,text,160,150)!;assert.equal(target.offset,refs[1]!.end);const moved=moveFlowImage(text,refs[0]!,target.offset);assert.equal(moved.start,token.length+1);assert.equal(parseCardImages(moved.value).length,2);}finally{host.remove();}
});
