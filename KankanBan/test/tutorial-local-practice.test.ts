import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tutorialCards} from '../src/core/tutorial-template.ts';
import {ensureTutorial} from '../src/core/tutorial.ts';
import {uiText} from '../src/i18n/text.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {openSession,moveCard,deleteCard,setField} from '../src/core/workspace.ts';
import {collectSubtree} from '../src/core/subtree.ts';
import {syncPrefab} from '../src/core/prefab-sync.ts';

const card=(key:string)=>{const value=tutorialCards.find(c=>c.key===key);assert.ok(value,key);return value;};
const children=(key:string)=>tutorialCards.filter(c=>c.parent===key);
function fixture(){const s=openSession('/guide-a',{ops:createMemoryFs().ops});ensureTutorial(s);const id=(key:string)=>{const title=uiText(card(key).title);const found=[...s.state.cards.values()].find(c=>c.title===title&&c.isPrefab===!!card(key).isPrefab);assert.ok(found,key);return found.id;};return {s,id};}
test('1A starts on the current card and groups window practice into one next step',()=>{
 const opening=uiText(card('a1').content);assert.match(opening,/这张卡/);assert.match(opening,/标题.*正文/);
 assert.doesNotMatch(opening,/设置|署名|练习卡|并排|一次回车/);
 assert.deepEqual(children('a1').map(c=>c.key),['a1_windows']);
 assert.deepEqual(children('a1_windows').map(c=>c.key),['a1_trash']);
 assert.match(uiText(card('a1_windows').content),/面包屑/);
});
test('2A is a directory of ten independent examples with a comprehensive editable root',()=>{
 const techniques=children('a2');assert.equal(techniques.length,10);assert.ok(techniques.every(c=>!children(c.key).length));
 const text=uiText(card('a2').content);
 for(const pattern of [/^# /m,/^## /m,/^### /m,/\*\*.+\*\*/,/\*[^*\n]+\*/,/~~.+~~/,/^- /m,/^1\. /m,/- \[[ x]\]/,/^> /m,/\]\(https:\/\//,/```/,/`[^`\n]+`/,/\^3\^/,/_2_/])assert.match(text,pattern);
 assert.match(uiText(card('a2_rule').content),/^---$/m);assert.match(uiText(card('a2_escape').content),/\\\*/);
});
test('3A retains the author\'s single-page dotted guide without restoring the deleted extension',()=>{
 assert.equal(tutorialCards.filter(c=>c.level==='a3').length,1);
 assert.equal(card('a3').doodleAsset,'a3');
 assert.match(uiText(card('a3').content),/·1/);assert.match(uiText(card('a3').content),/·5/);
});
test('4A uses the moved subtree to demonstrate extraction and deletion boundaries',()=>{
 assert.deepEqual(children('a4').map(c=>c.key),['a4_target','a4_move']);
 assert.deepEqual(children('a4_move').map(c=>c.key),['a4_sync','a4_delete']);
 assert.equal(card('a4_reference').parent,'a4_target');
 const {s,id}=fixture(),moved=id('a4_move'),target=id('a4_target'),sync=id('a4_sync'),survivor=id('a4_delete');
 moveCard(s,moved,target,0);moveCard(s,moved,target,1);moveCard(s,moved,null,0);moveCard(s,survivor,null,0);
 assert.deepEqual(new Set(collectSubtree(s.state,moved).ids),new Set([moved,sync]));
 deleteCard(s,moved);assert.equal(s.state.cards.get(sync)?.deleted,true);assert.equal(s.state.cards.get(survivor)?.deleted,false);
});
test('5A has a locally expandable board with A/B/C/D goals and one optional agile card',()=>{
 assert.deepEqual(children('a5').map(c=>c.key),['a5_board']);assert.equal(card('a5_board').layout,'columns');
 assert.equal(children('a5_board').length,3);assert.equal(children('a5_todo').length,5);
 assert.equal(children('a5_doing').length,0);assert.equal(children('a5_done').length,1);
 assert.equal(uiText(children('a5_done')[0]!.title),'安装kankanban软件');
 assert.deepEqual(children('a5_todo').slice(0,4).map(c=>uiText(c.title)),['学习 A 面','学习 B 面','学习 C 面','学习 D 面']);
});
test('6A keeps the author\'s four positioned clues and their ink layer',()=>{
 assert.equal(card('a6').layout,'plane');assert.equal(card('a6').doodleAsset,'a6');
 const cards=children('a6');assert.equal(cards.length,4);assert.ok(cards.every(c=>!children(c.key).length));
 assert.ok(cards.every(c=>c.plane&&Number.isFinite(c.plane.x)&&Number.isFinite(c.plane.y)&&c.plane.w>0&&c.plane.h>0));
 assert.ok(cards.some(c=>uiText(c.content).includes('矩形')));
});
test('7A is an instance while its source and linked teaching children live in the prefab library',()=>{
 assert.equal(card('a7').prefabRef,'a7_template');assert.equal(card('a7_template').parent,'003');
 assert.equal(children('a7').length,3);assert.equal(children('a7_template').length,3);
 const {s,id}=fixture(),source=id('a7_template'),instance=id('a7');
 assert.notEqual(s.state.cards.get(source)?.content,s.state.cards.get(instance)?.content);
 for(const template of tutorialCards.filter(c=>c.isPrefab)){const parent=template.parent;assert.ok(parent==='003'||card(parent!).isPrefab,template.key);}
 assert.throws(()=>moveCard(s,source,instance,0));
 const first=s.state.cards.get(instance)!.content;syncPrefab(s,instance,'prefab');assert.equal(s.state.cards.get(source)?.content,first,'initial differing instance content must be syncable');
 setField(s,source,'/content','Template change');syncPrefab(s,source,'all');assert.equal(s.state.cards.get(instance)?.content,'Template change');
});
test('8A is a concise completion page and one GitHub coffee child',()=>{
 assert.deepEqual(children('a8').map(c=>c.key),['a8_coffee']);assert.equal(uiText(card('a8_coffee').title),'Buy Me some Token...');
 assert.match(uiText(card('a8_coffee').content),/https:\/\/github.com\/srtan9er\/kankanban/i);
 const text=uiText(card('a8').content);assert.match(text,/设置/);assert.match(text.trim().split('\n').at(-1)!,/学习 A 面.*已完成/);
 assert.ok(!tutorialCards.some(c=>/^a[1-8]_practice$/.test(c.key)));
});
