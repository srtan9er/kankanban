import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tutorialCards} from '../src/core/tutorial-template.ts';
import {ensureTutorial} from '../src/core/tutorial.ts';
import {uiText} from '../src/i18n/text.ts';
import {openSession} from '../src/core/workspace.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {parseTables,validTable} from '../src/core/table-markdown.ts';
import {parseCardImages} from '../src/core/image-markdown.ts';
import {TOOLS} from '../src/mcp/tools.ts';

const get=(key:string)=>{const card=tutorialCards.find(c=>c.key===key);assert.ok(card,key);return card;};
const children=(key:string)=>tutorialCards.filter(c=>c.parent===key);
test('B/C use task chapters and parallel references without remote practice or micro-step chains',()=>{
 for(const key of ['b1','b2','b3','b4','b5','c1','c2']){
  const chapter=get(key),references=children(key);
  assert.ok(references.length>0&&references.length<=5,key);
  assert.ok(references.every(c=>children(c.key).length===0),key);
  const members=tutorialCards.filter(c=>c.level===key);
  assert.equal(members.length,references.length+1,key);
  for(const c of members){
   assert.doesNotMatch(uiText(c.title),/下一步|练习卡|试衣间|设计纸/);
   assert.doesNotMatch(uiText(c.content),/纸飞机|把.*练习卡.*拖出|旁边的.*练习/);
  }
  assert.equal(chapter.level,key);
 }
});
test('image and table instructions carry usable objects on their own page',()=>{
 const session=openSession('/bc-guide',{ops:createMemoryFs().ops});ensureTutorial(session);
 const created=(key:string)=>{
  const value=[...session.state.cards.values()].find(c=>c.title===uiText(get(key).title));assert.ok(value,key);return value;
 };
 for(const key of ['b1','b1_layout','b1_layers','b1_gallery','b4']){
  const c=created(key),images=parseCardImages(c.content,c.images);
  assert.ok(images.length>0,key);assert.ok(images.every(i=>i.image),key);
 }
 const gallery=created('b1_gallery'),images=parseCardImages(gallery.content,gallery.images);
 let remaining=gallery.content;for(const image of [...images].reverse())remaining=remaining.slice(0,image.start)+remaining.slice(image.end);
 assert.equal(remaining.trim(),'','the gallery lesson must remain a real image-only card');
 for(const key of ['b2','b2_structure','b2_layout','b4','c1_check']){
  const tables=parseTables(created(key).content);assert.equal(tables.length,1,key);assert.ok(validTable(tables[0]!.data),key);
 }
 assert.ok(created('b4').doodle?.strokes.length,'the share example includes ink on the current card');
 assert.equal(parseTables(created('b2_create').content).length,0,'the creation recipe stays literal inside its code fence');
});
test('developer reference code fences are balanced and all prose resolves through locale keys',()=>{
 for(const c of tutorialCards.filter(c=>c.level?.startsWith('c')||c.level?.startsWith('b'))){
  const text=uiText(c.content);assert.equal(text.split('\n').filter(line=>/^```/.test(line)).length%2,0,c.key);
  assert.doesNotMatch(text,/^ {4}(?:```|<table)/m,c.key);
  assert.ok(uiText(c.title).trim());assert.ok(text.trim());
 }
 assert.match(uiText(get('c1').content),/my-theme\.css/);
 assert.match(uiText(get('c2_api').content),/interface ExtensionService/);
 assert.match(uiText(get('c2_tutorial').content),/真实前后依赖/);
});
test('the optional final MCP reference covers every registered tool exactly once',()=>{
 const last=children('b5').at(-1)!;
 assert.equal(last.key,'b5_catalog');
 assert.match(uiText(last.title),/按需查阅/);
 const names=[...uiText(last.content).matchAll(/^- `([a-z_]+)`：/gm)].map(match=>match[1]);
 assert.deepEqual([...names].sort(),TOOLS.map(tool=>tool.name).sort());
});
test('authored image credits link to Pretext and the table recipe describes the implemented shortcut',()=>{
 assert.match(uiText(get('b1_layout').content),/\[Pretext\]\(https:\/\/github\.com\/chenglou\/pretext\)/);
 assert.doesNotMatch(uiText(get('b1_layout').content),/Codex你看到了/);
 assert.match(uiText(get('b2_create').content),/Ctrl\+T/);
 assert.match(uiText(get('b2_create').content),/2×2/);
 assert.doesNotMatch(uiText(get('b2_create').content),/TODO/);
});
