import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState,TextSelection} from 'prosemirror-state';
import {toggleMark} from 'prosemirror-commands';
import {emptyTableMarkup,parseTables} from '../src/core/table-markdown.ts';
import {parseRichBody,serializeRichBody,richBodySchema,sourceToVisualPosition,visualPositionToSource} from '../src/webview/rich-editor-model.ts';

const image='<image src="../assets/images/'+ 'a'.repeat(64)+'.png" layout="underlay" name="image_7" width="80" x="24" layer="-2">Sample</image>';
const fixtures=[
 '', '\r\n# Heading\r\n\r\n**bold**  *italic* ~~gone~~ x^2^ H_2_O\r\n',
 '- [ ] Task one\n- [x] Task two\n\n> quote\n> continuation\n\n```ts\nconst x = "<image>";\n```\n',
 '## A\n\nText [link](https://example.com/a?q=1) and `inline`\nnext line\n\n---\n',
 'Before '+image+' after\n\n'+emptyTableMarkup('')+'\n',
 '<widget custom="keep &amp; all">unknown **extension**</widget>\n\n$$custom$$\n',
 '| A | B |\n| --- | :---: |\n| one | two |\n'
];
test('opening visual editing without edits preserves every original byte',()=>{
 for(const source of fixtures)assert.equal(serializeRichBody(parseRichBody(source)),source);
});
test('formatting uses visual text while preserving untouched source blocks and protected object attributes',()=>{
 const untouched='\n\n~~~js\n  untouched   \n~~~\n',source='Hello '+image+' world'+untouched;
 let state=EditorState.create({schema:richBodySchema,doc:parseRichBody(source)});
 const from=sourceToVisualPosition(state.doc,0),to=sourceToVisualPosition(state.doc,5);
 state=state.apply(state.tr.setSelection(TextSelection.create(state.doc,from,to)));
 assert.equal(toggleMark(richBodySchema.marks.strong!)(state,tr=>{state=state.apply(tr);}),true);
 const result=serializeRichBody(state.doc);assert.ok(result.startsWith('**Hello** '));assert.ok(result.includes(image));assert.ok(result.endsWith(untouched));
});
test('a changed table paragraph keeps exact dimensions, cells, placement, layer and collapse metadata',()=>{
 const table=emptyTableMarkup('').replace('layout="inline"','layout="float" x="41" y="87" layer="3" collapsed="true"');
 const source='Note '+table+' end';let state=EditorState.create({doc:parseRichBody(source)});
 state=state.apply(state.tr.insertText('!',sourceToVisualPosition(state.doc,4)));
 const result=serializeRichBody(state.doc);assert.ok(result.includes(table));assert.deepEqual(parseTables(result)[0]!.data,parseTables(source)[0]!.data);
});
test('source mapping locates text, syntax and object boundaries in UTF-16 positions',()=>{
 const source='# Heading\n\n**你好🌏** '+image+' tail',doc=parseRichBody(source);
 for(const index of [source.indexOf('Heading'),source.indexOf('你好'),source.indexOf('🌏'),source.indexOf('tail')+2]){
  const visual=sourceToVisualPosition(doc,index);assert.equal(visualPositionToSource(doc,visual),index);
 }
 let objectRaw:string|undefined;doc.descendants(node=>{if(node.type.name==='body_object')objectRaw=node.attrs.raw;});assert.equal(objectRaw,image);
 const start=source.indexOf(image),end=start+image.length;
 assert.ok(visualPositionToSource(doc,sourceToVisualPosition(doc,start))<=start);
 assert.ok(visualPositionToSource(doc,sourceToVisualPosition(doc,end,1),1)>=end);
});
test('all existing rich semantics remain represented rather than becoming literal markdown',()=>{
 const source='# Title\n\n**B** *I* ~~D~~ x^2^ H_2_O [link](https://example.com) `code`\nnext\n\n- [x] Done\n- [ ] Todo\n\n> Quote';
 const doc=parseRichBody(source),marks=new Set<string>(),types=new Set<string>();doc.descendants(node=>{types.add(node.type.name);for(const mark of node.marks)marks.add(mark.type.name);});
 for(const mark of ['strong','em','strike','sup','sub','link','code'])assert.ok(marks.has(mark),mark);
 for(const type of ['heading','hard_break','bullet_list','list_item','blockquote'])assert.ok(types.has(type),type);
 assert.equal(doc.child(2).child(0).attrs.checked,true);assert.equal(doc.child(2).child(1).attrs.checked,false);
});
test('unknown HTML retains its complete source when editing adjacent text, without creating executable DOM',()=>{
 const unknown='<custom-widget data-private="x" onclick="bad()">',source='Start '+unknown+' payload </custom-widget> end';
 let state=EditorState.create({doc:parseRichBody(source)});state=state.apply(state.tr.insertText('!',sourceToVisualPosition(state.doc,5)));
 const result=serializeRichBody(state.doc);assert.ok(result.includes(unknown));assert.ok(result.includes('</custom-widget>'));assert.equal(state.doc.child(0).child(1).type.name,'body_object');
});
test('multiline protected objects never consume following text on the closing line',()=>{
 const table=emptyTableMarkup(''),source=table+' text after\n\nOther paragraph';let state=EditorState.create({doc:parseRichBody(source)});
 assert.ok(state.doc.textContent.includes('text after'));state=state.apply(state.tr.insertText('!',sourceToVisualPosition(state.doc,source.indexOf('Other')+5)));
 const result=serializeRichBody(state.doc);assert.ok(result.includes('text after'));assert.ok(result.includes(table));
});
test('multiline code caret positions and task changes map and persist correctly',()=>{
 const source='```ts\nline1\nline2\n```\n\n- [ ] task',doc=parseRichBody(source);
 const offset=source.indexOf('line2')+2;assert.equal(visualPositionToSource(doc,sourceToVisualPosition(doc,offset)),offset);
 let state=EditorState.create({doc});const listPosition=doc.child(0).nodeSize,itemPosition=listPosition+1,item=doc.child(1).child(0);
 state=state.apply(state.tr.setNodeMarkup(itemPosition,undefined,{...item.attrs,checked:true}));assert.ok(serializeRichBody(state.doc).includes('[x] task'));
});
test('inserting and deleting whole blocks preserves surviving raw source and the trailing suffix',()=>{
 const first='## First\r\n',last='~~~custom\r\n  exact   payload\r\n~~~\r\n',suffix='\r\n\r\n',source='\r\n'+first+'\r\n'+last+suffix;
 let state=EditorState.create({doc:parseRichBody(source)});const inserted=richBodySchema.nodes.paragraph!.create(null,richBodySchema.text('Inserted'));
 state=state.apply(state.tr.insert(state.doc.child(0).nodeSize,inserted));let result=serializeRichBody(state.doc);assert.ok(result.includes(first));assert.ok(result.includes(last));assert.ok(result.endsWith(suffix));assert.ok(result.includes('Inserted'));
 state=state.apply(state.tr.delete(0,state.doc.child(0).nodeSize));result=serializeRichBody(state.doc);assert.ok(!result.includes(first));assert.ok(result.includes(last));assert.ok(result.endsWith(suffix));assert.ok(result.includes('Inserted'));
 const reparsed=parseRichBody(result);assert.equal(reparsed.childCount,2);assert.equal(reparsed.child(0).textContent,'Inserted');assert.equal(reparsed.child(1).textContent,'  exact   payload');
});
