import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {Markdown} from '../src/webview/Markdown.tsx';
import {inlineText,tableCells} from '../src/webview/markdown-syntax.ts';
import {safeFlowOffset} from '../src/webview/flow-image-drag.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {executeAction} from '../src/core/actions.ts';
import type {Request} from '../src/webview/controller.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:[...text].length*8})};}}});
const assetId='a'.repeat(64)+'.png',image={id:'image',assetId,name:'test',mime:'image/png' as const,width:80,height:40};
const base='*斜体* **粗体** ~~删除~~ x^2^ H_2_O\n\n| 名称 | 数量 |\n| :--- | ---: |\n| *项目* | 2 |\n\n---\n- [ ] 完成此项\n* [X] 已完成\n`*字面* ~~字面~~ ^字面^ _字面_`';
async function fixture(text:string,run:(host:HTMLElement,requests:Request[])=>Promise<void>,prepare?:()=>Promise<unknown>){
 const host=document.createElement('div'),root=createRoot(host),requests:Request[]=[];document.body.append(host);
 try{await act(async()=>root.render(createElement('div',{onClick:()=>host.dataset.clicked='true'},createElement(Markdown,{text,images:[image],id:'card',send:async request=>{requests.push(request);},prepare}))));await run(host,requests);}finally{await act(async()=>root.unmount());host.remove();}
}
for(const mode of ['text','inline','float'] as const){
 const suffix=mode==='text'?'':`\n<image src="../assets/images/${assetId}" layout="${mode}" width="80" height="40" x="150" y="0">picture</image>`;
 test(`${mode}: format text, tables and rules without interpreting code or HTML`,()=>fixture(base+suffix,async host=>{
  assert.equal(host.querySelector('em')?.textContent,'斜体');assert.equal(host.querySelector('strong')?.textContent,'粗体');assert.equal(host.querySelector('del')?.textContent,'删除');
  assert.equal(host.querySelector('sup')?.textContent,'2');assert.equal(host.querySelector('sub')?.textContent,'2');assert.equal(host.querySelectorAll('hr').length,1);
  assert.equal(host.querySelectorAll('th').length,2);assert.equal(host.querySelector('tbody td em')?.textContent,'项目');assert.equal((host.querySelector('th:last-child') as HTMLElement)?.style.textAlign,'right');
  assert.equal(host.querySelector('code')?.textContent,'*字面* ~~字面~~ ^字面^ _字面_');
 }));
 test(`${mode}: preview task click edits only its source marker and consumes click`,()=>fixture(base+suffix,async(host,requests)=>{
  const checks=host.querySelectorAll<HTMLInputElement>('input[type=checkbox]');assert.equal(checks.length,2);assert.equal(checks[1]!.checked,true);
  await act(async()=>checks[0]!.click());assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit');assert.equal(requests[0].before,base+suffix);assert.equal(requests[0].value,(base+suffix).replace('- [ ]','- [x]'));assert.equal(host.dataset.clicked,undefined);
 }));
}
test('a failed task save leaves the checkbox unchanged and reports the error',()=>fixture('- [ ] preserve',async(host,requests)=>{
 await act(async()=>host.querySelector<HTMLInputElement>('input')!.click());assert.equal(requests.length,0);assert.equal(host.querySelector<HTMLInputElement>('input')!.checked,false);assert.match(host.querySelector('[role=alert]')?.textContent ?? '',/save blocked/);
},async()=>{throw new Error('save blocked');}));
test('escaped syntax, unmatched delimiters and raw HTML stay literal',()=>fixture('\\*literal\\* _unclosed\n<script>alert(1)</script>\n```\n---\n- [ ] literal\n```',async host=>{
 assert.equal(host.querySelector('em,sub,script,hr,input'),null);assert.ok(host.textContent!.includes('*literal*'));assert.ok(host.textContent!.includes('_unclosed'));assert.match(host.textContent!,/<script>/);
}));
test('nested emphasis and code markers keep exact source ranges',()=>{
 for(const text of ['***both***','**bold *both***','*italic **both***']){const tokens=inlineText(text);assert.ok(tokens.some(token=>token.strong && token.italic));for(const token of tokens)assert.equal(text.slice(token.start,token.end),token.text);}
 const code=inlineText('*before `*literal*` after*');assert.equal(code.find(token=>token.kind==='code')?.text,'*literal*');assert.ok(code.every(token=>token.italic));
 assert.deepEqual(tableCells('| a\\|b | `x|y` |')?.map(cell=>cell.text),['a\\|b','`x|y`']);
});
test('formatting spans across an inline picture without corrupting its identity',()=>fixture(`**before <image src="../assets/images/${assetId}" layout="inline" name="image_5">caption</image> after**`,async host=>{
 assert.equal(host.querySelectorAll('.image-placement').length,1);assert.equal([...host.querySelectorAll('strong')].map(node=>node.textContent).join(''),'before  after');
}));
test('a table accepts escaped pipes, code pipes and inline pictures',()=>fixture(`| Text | Picture |\n| --- | :---: |\n| a\\|b and \`x|y\` | <image src="../assets/images/${assetId}" layout="inline">a|b</image> |`,async host=>{
 assert.equal(host.querySelectorAll('tbody td').length,2);assert.equal(host.querySelector('tbody td code')?.textContent,'x|y');assert.ok(host.querySelector('tbody td')!.textContent!.includes('a|b'));assert.equal(host.querySelectorAll('tbody td .image-placement').length,1);
}));
test('fence character and length must match before tasks resume rendering',()=>fixture('````\n~~~\n- [ ] literal\n```\n````\n- [ ] real',async host=>{
 assert.equal(host.querySelectorAll('input').length,1);assert.match(host.querySelector('pre')!.textContent!,/~~~\n- \[ \] literal\n```/);
}));
test('image insertion cannot split escaped markers, rules or table separators',()=>{
 const escaped='\\*literal';assert.equal(safeFlowOffset(escaped,1),0);
 const rule='before\n---\nafter';assert.ok([7,10].includes(safeFlowOffset(rule,8)));
 const divider='| :--- | ---: |';assert.ok([0,divider.length].includes(safeFlowOffset(divider,4)));
});
test('without a save channel preview tasks are disabled',async()=>{
 const host=document.createElement('div'),root=createRoot(host);try{await act(async()=>root.render(createElement(Markdown,{text:'- [ ] read only'})));assert.equal(host.querySelector<HTMLInputElement>('input')!.disabled,true);}finally{await act(async()=>root.unmount());}
});
test('task toggles persist, render both directions, and remain one undo operation',async()=>{
 const fs=createMemoryFs(),session=openSession('/task-preview',{ops:fs.ops}),before='- [ ] first\n* [X] second',id=createCard(session,{parentId:null,content:before});
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 const render=()=>root.render(createElement(Markdown,{text:session.state.cards.get(id)!.content,id,send:async(request:Request)=>{assert.ok(request.kind==='edit');executeAction(session,request);render();}}));
 try{
  await act(async()=>render());await act(async()=>host.querySelectorAll<HTMLInputElement>('input')[1]!.click());
  assert.equal(session.state.cards.get(id)!.content,'- [ ] first\n* [ ] second');assert.equal(host.querySelectorAll<HTMLInputElement>('input')[1]!.checked,false);
  await act(async()=>host.querySelectorAll<HTMLInputElement>('input')[1]!.click());assert.equal(host.querySelectorAll<HTMLInputElement>('input')[1]!.checked,true);
  assert.equal(openSession('/task-preview',{ops:fs.ops}).state.cards.get(id)!.content,'- [ ] first\n* [x] second');
  executeAction(session,{kind:'undo'});assert.equal(session.state.cards.get(id)!.content,'- [ ] first\n* [ ] second');executeAction(session,{kind:'undo'});assert.equal(session.state.cards.get(id)!.content,before);
 }finally{await act(async()=>root.unmount());host.remove();}
});
