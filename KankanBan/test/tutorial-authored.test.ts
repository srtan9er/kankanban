import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tutorialCards} from '../src/core/tutorial-template.ts';
import {ensureTutorial} from '../src/core/tutorial.ts';
import {uiText} from '../src/i18n/text.ts';
import {openSession} from '../src/core/workspace.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {validInk} from '../src/core/drawing.ts';

test('the authored edition retains renamed pages, deletions, ordering and the added task',()=>{
 const get=(key:string)=>tutorialCards.find(c=>c.key===key)!;
 assert.equal(uiText(get('a1').title),'1A · 第一张卡片！');
 assert.equal(tutorialCards.some(c=>c.key==='a3_extend'),false);
 assert.deepEqual(tutorialCards.filter(c=>c.parent==='a4').map(c=>c.key),['a4_target','a4_move']);
 assert.equal(uiText(get('a8_coffee').title),'Buy Me some Token...');
 assert.ok(tutorialCards.some(c=>uiText(c.title)==='安装kankanban软件'));
});
test('authored ink survives new tutorial creation with fresh identities and local card bindings',()=>{
 const s=openSession('/authored-guide',{ops:createMemoryFs().ops});
 ensureTutorial(s);ensureTutorial(s,undefined,0);
 const planes=[...s.state.cards.values()].filter(c=>c.title==='6A · 灵感平面');
 assert.equal(planes.length,2);
 for(const plane of planes){
  assert.ok(validInk(plane.doodle));assert.equal(plane.doodle!.strokes.length,14);
  const children=new Set((s.state.children.get(plane.id) ?? []).map(c=>c.id));
  const strokes=new Set(plane.doodle!.strokes.map(c=>c.id));
  assert.equal(plane.doodle!.groups?.[0]?.cards.length,4);
  assert.ok(plane.doodle!.groups!.every(g=>g.cards.every(id=>children.has(id))&&g.strokes.every(id=>strokes.has(id))));
 }
 assert.notEqual(planes[0]!.doodle!.id,planes[1]!.doodle!.id);
 assert.notEqual(planes[0]!.doodle!.strokes[0]!.id,planes[1]!.doodle!.strokes[0]!.id);
});
