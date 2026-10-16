import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tutorialCards} from '../src/core/tutorial-template.ts';
import {ensureTutorial,TUTORIAL_EDITION} from '../src/core/tutorial.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {openSession,setField} from '../src/core/workspace.ts';
import {uiText} from '../src/i18n/text.ts';
import {parseTables} from '../src/core/table-markdown.ts';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {rebuildTutorialWorkspace} from '../scripts/rebuild-tutorial.mjs';
import {acquireWorkspace} from '../src/node/workspace-lock.ts';
import {createHash} from 'node:crypto';
import {parseCardImages} from '../src/core/image-markdown.ts';
import {AVAILABLE_EXTENSIONS} from '../src/extensions/registry.ts';
import {extensionTutorialCards} from '../src/core/tutorial-template.ts';
test('tutorial export replaces only the dedicated unlocked fixture after a checked build',()=>{
 const temp=mkdtempSync(join(tmpdir(),'kkb-tutorial-test-')),target=join(temp,'KkbTutorial'),marker=join(target,'.kkb','old.txt');mkdirSync(join(target,'.kkb'),{recursive:true});writeFileSync(marker,'old tutorial');
 const ignorePath=join(target,'.gitignore'),ignoreBytes=Buffer.from([35,32,255,10]);writeFileSync(ignorePath,ignoreBytes);
 try{const checked=rebuildTutorialWorkspace(target,{check:true});assert.equal(checked.status,'checked');assert.equal(readFileSync(marker,'utf8'),'old tutorial');
  assert.throws(()=>rebuildTutorialWorkspace(join(temp,'project'),{replace:true}));const release=acquireWorkspace(target);try{assert.throws(()=>rebuildTutorialWorkspace(target,{replace:true}));assert.equal(readFileSync(marker,'utf8'),'old tutorial');}finally{release();}
  const result=rebuildTutorialWorkspace(target,{replace:true});assert.equal(result.tutorialCards,tutorialCards.length);assert.equal(existsSync(marker),false);assert.equal(existsSync(join(target,'.kkb','writer.lock')),false);
  const updated=readFileSync(ignorePath);assert.deepEqual(updated.subarray(0,ignoreBytes.length),ignoreBytes);assert.ok(updated.toString().endsWith('.kkb/\n'));
  const session=openSession(target);assert.equal(session.state.cards.get(result.rootId)?.title,uiText('tutorial.rootTitle'));
  for(const card of session.state.cards.values())for(const image of parseCardImages(card.content,card.images ?? [])){
   assert.ok(image.image);const bytes=readFileSync(join(target,'.kkb','assets','images',image.assetId));
   assert.equal(createHash('sha256').update(bytes).digest('hex')+'.png',image.assetId);assert.equal(bytes.readUInt32BE(16),image.image.width);assert.equal(bytes.readUInt32BE(20),image.image.height);
  }
 }finally{const path=resolve(temp);if(path.startsWith(resolve(tmpdir())+sep)&&basename(path).startsWith('kkb-tutorial-test-'))rmSync(path,{recursive:true,force:true});}
});
test('modules keep materials local; only the unchanged D provider retains its step chain',()=>{
 const byId=new Map(tutorialCards.map(card=>[card.key,card]));
 for(const module of tutorialCards.filter(c=>c.role==='level')){
  const members=tutorialCards.filter(c=>c.level===module.key),steps=members.filter(c=>c.role==='step');
  if(/^[abc]\d+$/.test(module.key)){
   for(const member of members){
    assert.ok(member.key===module.key||member.isPrefab&&member.parent==='003'||byId.get(member.parent!)?.level===module.key,member.key);
    if(member.prefabRef)assert.equal(byId.get(member.prefabRef)?.level,module.key);
   }
   continue;
  }
  assert.ok(steps.length>=5,module.key);
  const first=tutorialCards.filter(c=>c.parent===module.key);assert.equal(first.filter(c=>c.role==='step').length,1);assert.equal(first.filter(c=>c.role==='practice').length,1);assert.equal(first.length,2);
  let cursor=first.find(c=>c.role==='step'),visited=new Set<string>();
  while(cursor){assert.ok(!visited.has(cursor.key));visited.add(cursor.key);assert.ok(uiText(cursor.content).length<=240,cursor.key);
   const children=tutorialCards.filter(c=>c.parent===cursor!.key);assert.ok(children.length<=2);const next=children.filter(c=>c.role==='step');assert.ok(next.length<=1);cursor=next[0];
  }
  assert.equal(visited.size,steps.length,module.key);
  for(const member of members){assert.ok(member.key===module.key||byId.get(member.parent!)?.level===module.key,member.key);if(member.prefabRef)assert.equal(byId.get(member.prefabRef)?.level,module.key);}
 }
});
test('extension lessons mount beneath D through the common provider with isolated keys',()=>{
 const mounted=extensionTutorialCards();assert.equal(mounted.filter(c=>c.parent==='faceD').length,AVAILABLE_EXTENSIONS.length);
 const sample=extensionTutorialCards([{...AVAILABLE_EXTENSIONS[0]!,id:'sample'}]);const keys=new Set(mounted.map(c=>c.key));assert.ok(sample.every(c=>!keys.has(c.key)));
 assert.ok(sample.every(c=>c.parent==='faceD'||sample.some(p=>p.key===c.parent)));
});
test('course has four faces and a valid graph, including the real prefab-library source',()=>{
 const keys=new Set(tutorialCards.map(c=>c.key));assert.equal(keys.size,tutorialCards.length);
 assert.deepEqual(tutorialCards.filter(c=>c.parent==='root').map(c=>c.key),['faceA','faceB','faceC','faceD']);
 for(const key of ['a1','a2','a3','a4','a5','a6','a7','a8','b1','b2','b3','b4','b5','c1','c2'])assert.ok(keys.has(key),key);
 for(const card of tutorialCards){assert.ok(card.parent===null||keys.has(card.parent)||card.parent==='003'&&card.isPrefab,card.key);assert.ok(uiText(card.title).trim());assert.ok(uiText(card.content).trim());}
 assert.equal(tutorialCards.filter(c=>c.parent==='faceA').length,8);assert.equal(tutorialCards.filter(c=>c.parent==='faceB').length,5);assert.equal(tutorialCards.filter(c=>c.parent==='faceC').length,2);
});
test('guide creation has valid tree, board columns, plane entries, named table and prefab practice',()=>{
 const disk=createMemoryFs(),s=openSession('/guide',{ops:disk.ops});const root=ensureTutorial(s);
 assert.ok(s.state.cards.get(root));assert.ok([...s.state.cards.values()].some(c=>parseTables(c.content).length>0));
 assert.ok([...s.state.cards.values()].some(c=>(c.images?.length ?? 0)>0),'practice assets must be real card images');
 assert.ok([...s.state.cards.values()].some(c=>c.images?.length && c.doodle?.strokes.length===0),'numbered drawing guide must remain separate from user ink');
 for(const card of s.state.cards.values()){if(card.layout==='columns'&&card.id!=='001')assert.equal(s.state.children.get(card.id)?.length,3);if(card.layout==='plane'&&card.id!=='002')for(const entry of s.state.children.get(card.id) ?? [])assert.ok('x' in entry);if(card.prefabRef)assert.ok(s.state.cards.get(card.prefabRef)?.isPrefab);}
 const count=s.state.cards.size;setField(s,root,'/content','practice edit');assert.equal(ensureTutorial(s,root,TUTORIAL_EDITION),root);assert.equal(s.state.cards.size,count);
 const latest=ensureTutorial(s,root,0);assert.notEqual(latest,root);assert.notEqual(s.state.cards.get(latest)?.content,'practice edit');
});
