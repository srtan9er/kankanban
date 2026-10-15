import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCardImages,imageOnly,mixedPreview,markdownForImage,serializeImage,type ImageLayout} from '../src/core/image-markdown.ts';
import type {CardImage} from '../src/core/card-images.ts';
const asset=`${'a'.repeat(64)}.png`,syntax=`![Example](../assets/images/${asset})`;
const metadata:CardImage={id:'reference',assetId:asset,name:'Example',mime:'image/png',width:320,height:200};

test('local Markdown images retain ranges, repeated occurrences and optional asset metadata',()=>{
 const text=`Start\n${syntax}\nEnd\n${syntax}`,images=parseCardImages(text,[metadata]);
 assert.equal(images.length,2);assert.equal(images[0]!.alt,'Example');assert.equal(images[0]!.assetId,asset);assert.deepEqual(images[0]!.image,metadata);
 assert.equal(text.slice(images[0]!.start,images[0]!.end),syntax);assert.equal(text.slice(images[1]!.start,images[1]!.end),syntax);
 assert.equal(parseCardImages(syntax)[0]!.image,undefined);
});

test('images inside inline or fenced code and escaped Markdown remain ordinary text',()=>{
 for(const code of [`\`${syntax}\``,`\`\`${syntax}\`\``,`\`\`\`md\n${syntax}\n\`\`\``,`~~~\n${syntax}\n~~~`,`\\${syntax}`]){
  assert.deepEqual(parseCardImages(code),[]);assert.equal(mixedPreview(code),code);assert.equal(imageOnly(code),false);
 }
 const after=`\`code\`\n${syntax}`;assert.equal(parseCardImages(after).length,1);
});

test('image-only requires a real image and no text outside image expressions',()=>{
 assert.equal(imageOnly(`  ${syntax}\n${syntax}\n`),true);assert.equal(imageOnly(`${syntax}\nA note`),false);assert.equal(imageOnly('  \n'),false);
});

test('mixed previews replace image expressions in place without editing other text',()=>{
 const marker='<image_0>',text=`First ${syntax} last\n\`${syntax}\`\n![Remote](https://example.com/image.png)`;
 assert.equal(mixedPreview(text),`First ${marker} last\n\`${syntax}\`\n<image_1>`);
 assert.deepEqual(parseCardImages('![Wrong](../../assets/images/'+asset+')'),[]);
 assert.deepEqual(parseCardImages('![Remote](https://example.com/'+asset+')'),[]);
 assert.deepEqual(parseCardImages('![Unsafe](../assets/images/not-a-hash.png)'),[]);
});

test('generated Markdown escapes the alt text and does not lose file reference identity',()=>{
 const original={...metadata,name:'A [square] (round) \\ slash'};const generated=markdownForImage(original),parsed=parseCardImages(generated,[original]);
 assert.equal(parsed.length,1);assert.equal(parsed[0]!.alt,original.name);assert.equal(parsed[0]!.assetId,asset);
});

test('balanced destinations and reference definitions do not change local path restrictions',()=>{
 assert.deepEqual(parseCardImages(`![alt](../assets/images/${asset} "a title")`).map(i=>i.assetId),[asset]);
 assert.equal(mixedPreview('![remote](https://example.com/a_(b).png)'),'<image_0>');
});

test('controlled image tags expose only the four canonical layout modes and their geometry',()=>{
 for(const layout of ['inline','float','overlay','underlay'] as const){
  const source=`<image src="../assets/images/${asset}" layout="${layout}" width="240" height="160" x="40" y="-20">Alt &amp; context</image>`;
  const ref=parseCardImages(source,[metadata])[0]!;
  assert.ok(ref,layout);assert.equal(ref.syntax,'image');assert.equal(ref.layout,layout);
  assert.equal(ref.width,240);assert.equal(ref.height,160);assert.equal(ref.x,40);assert.equal(ref.y,-20);assert.equal(ref.alt,'Alt & context');
  assert.equal(source.slice(ref.start,ref.end),source);assert.deepEqual(ref.image,metadata);
  assert.equal(imageOnly(source),true);assert.equal(mixedPreview('Text '+source),'Text '+'<image_0>');
  assert.equal(parseCardImages(serializeImage(ref,{layout}))[0]!.layout,layout);
 }
 const markdown=parseCardImages(syntax)[0]!;assert.equal(markdown.syntax,'markdown');assert.equal(markdown.layout,'inline');
 assert.throws(()=>serializeImage(markdown,{layout:'block' as ImageLayout}));
});

test('legacy paragraph mode and omitted tag layout normalize to inline without changing the source body',()=>{
 const legacy=`<image src="../assets/images/${asset}" layout="block" width="240" height="160" x="40" y="20">Legacy image</image>`,ref=parseCardImages(legacy)[0]!;
 assert.equal(ref.layout,'inline');assert.equal(ref.width,240);assert.equal(ref.height,160);assert.equal(ref.x,40);assert.equal(ref.y,20);
 assert.equal(legacy.slice(ref.start,ref.end),legacy);assert.equal(imageOnly(legacy),true);assert.equal(mixedPreview(legacy),'<image_0>');
 assert.ok(serializeImage(ref).includes('layout="inline"'));assert.ok(!serializeImage(ref).includes('layout="block"'));
 assert.equal(parseCardImages(`<image src="../assets/images/${asset}">Default</image>`)[0]!.layout,'inline');
 const paragraph=`Before\n\n${syntax}\n\nAfter`;assert.equal(mixedPreview(paragraph),`Before\n\n${'<image_0>'}\n\nAfter`);
});

test('unsafe or malformed controlled tags stay text and do not become image references',()=>{
 const cases=[
  `<image src="../assets/images/${asset}" onclick="alert(1)">x</image>`,
  `<image src="../assets/images/${asset}" style="color:red">x</image>`,
  `<image src="../assets/images/${asset}" src="../assets/images/${asset}">x</image>`,
  `<image src="https://example.com/image.png">x</image>`,
  `<image src="../../assets/images/${asset}">x</image>`,
  `<image src="../assets/images/${asset}" layout="script">x</image>`,
  `<image src="../assets/images/${asset}" width="7">x</image>`,
  `<image src="../assets/images/${asset}" height="16385">x</image>`,
  `<image src="../assets/images/${asset}" x="10000001">x</image>`,
  `<image src="../assets/images/${asset}" y="NaN">x</image>`,
  `<image src="../assets/images/${asset}"><script>x</script></image>`,
  `<image src="../assets/images/${asset}">x`,
 ];
 for(const source of cases){assert.deepEqual(parseCardImages(source),[]);assert.equal(mixedPreview(source),source);assert.equal(imageOnly(source),false);}
});

test('controlled tags remain ordinary text in code and may coexist with Markdown occurrences',()=>{
 const extended=`<image src="../assets/images/${asset}" layout="float">Alt</image>`;
 for(const source of [`\`${extended}\``,`\`\`\`xml\n${extended}\n\`\`\``]){assert.deepEqual(parseCardImages(source),[]);assert.equal(mixedPreview(source),source);}
 const both=syntax+'\n'+extended;assert.equal(parseCardImages(both).length,2);assert.equal(imageOnly(both),true);
});

test('layout edits serialize safe controlled tags and retain geometry on subsequent edits',()=>{
 const original=parseCardImages(`![A \\[bracket\\] & text](../assets/images/${asset})`)[0]!;
 const first=serializeImage(original,{layout:'overlay',width:240,height:160,x:-40,y:20,alt:'A <script> "quote" & text'}),ref=parseCardImages(first)[0]!;
 assert.ok(!first.includes('<script>'));assert.equal(ref.alt,'A <script> "quote" & text');assert.equal(ref.layout,'overlay');
 const changed=parseCardImages(serializeImage(ref,{x:50}))[0]!;
 assert.equal(changed.x,50);assert.equal(changed.y,20);assert.equal(changed.width,240);assert.equal(changed.height,160);assert.equal(changed.layout,'overlay');
 assert.throws(()=>serializeImage(ref,{width:0}));assert.throws(()=>serializeImage(ref,{y:Infinity}));
});
test('controlled image names and layer order survive parsing and layout serialization',()=>{
 const assetId='a'.repeat(64)+'.png',source=`<image src="../assets/images/${assetId}" name="image_17" layout="overlay" layer="3">photo</image>`;
 const references=parseCardImages(source);assert.equal(references.length,1);assert.equal(references[0]!.name,'image_17');assert.equal(references[0]!.layer,3);
 const resized=serializeImage(references[0]!,{width:240,height:120});const restored=parseCardImages(resized)[0]!;assert.equal(restored.name,'image_17');assert.equal(restored.layer,3);
 assert.equal(parseCardImages(source.replace('image_17','../unsafe')).length,0);assert.equal(parseCardImages(source.replace('layer="3"','layer="3.5"')).length,0);
});
