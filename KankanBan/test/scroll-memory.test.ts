import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attachScrollMemory,ScrollPositions} from '../src/webview/scroll-memory.ts';
Object.assign(globalThis,{MutationObserver:window.MutationObserver,requestAnimationFrame:(callback:(time:number)=>void)=>setTimeout(()=>callback(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id)});
const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
function fixture(){const root=document.createElement('div');root.setAttribute('data-scroll-owner','card:A');const area=document.createElement('div');area.className='preview';root.append(area);document.body.append(root);let visible=true;Object.defineProperties(area,{clientWidth:{get:()=>visible?200:0},clientHeight:{get:()=>visible?100:0}});return {root,area,hide:()=>visible=false,show:()=>visible=true,close:()=>root.remove()};}
test('scroll positions have bounded memory and independent keys',()=>{const cache=new ScrollPositions();cache.set('window:A',{left:20,top:100});cache.set('window:B',{left:0,top:5});assert.equal(cache.get('window:A')?.top,100);assert.equal(cache.get('window:B')?.top,5);for(let i=0;i<600;i++)cache.set(String(i),{left:0,top:i});assert.equal(cache.entries().length,512);});
test('returning to a card restores both axes without affecting another card or window',async()=>{
 const f=fixture(),cache=new ScrollPositions();const stop=attachScrollMemory(f.root,'workspace/window-A',cache);
 try{f.area.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true}));f.area.scrollTop=260;f.area.scrollLeft=30;f.area.dispatchEvent(new window.Event('scroll'));
 f.root.dataset.scrollOwner='card:B';await tick();assert.equal(f.area.scrollTop,0);f.area.scrollTop=15;f.area.dispatchEvent(new window.Event('scroll'));
 f.root.dataset.scrollOwner='card:A';await tick();assert.equal(f.area.scrollTop,260);assert.equal(f.area.scrollLeft,30);
 const g=fixture(),other=attachScrollMemory(g.root,'workspace/window-B',cache);assert.equal(g.area.scrollTop,0);other();g.close();
 }finally{stop();f.close();}
});
for(const editorKind of ['textarea','markdown'] as const)test(`preview and ${editorKind} editor share the body location across DOM replacement`,async()=>{
 const f=fixture(),cache=new ScrollPositions(),stop=attachScrollMemory(f.root,'workspace/main',cache);
 try{f.area.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true}));f.area.scrollTop=190;f.area.dispatchEvent(new window.Event('scroll'));
 const edit=document.createElement(editorKind==='textarea'?'textarea':'div');edit.className=editorKind==='textarea'?'content':'markdown-editor content';Object.defineProperties(edit,{clientWidth:{value:200},clientHeight:{value:100}});f.area.replaceWith(edit);await tick();assert.equal(edit.scrollTop,190);
 }finally{stop();f.close();}
});
test('collapsed scroll area does not replace remembered location with zero',async()=>{
 const f=fixture(),cache=new ScrollPositions(),stop=attachScrollMemory(f.root,'workspace/main',cache);
 try{f.area.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true}));f.area.scrollTop=210;f.area.dispatchEvent(new window.Event('scroll'));f.hide();f.area.scrollTop=0;f.area.style.height='0px';f.area.dispatchEvent(new window.Event('scroll'));await tick();f.show();f.area.style.height='100px';await tick();assert.equal(f.area.scrollTop,210);
 }finally{stop();f.close();}
});
test('semantic body positioning suppresses old pixel restoration and still remembers later browsing',async()=>{
 const f=fixture(),cache=new ScrollPositions(),stop=attachScrollMemory(f.root,'workspace/semantic',cache);
 try{
  f.area.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true}));f.area.scrollTop=190;f.area.dispatchEvent(new window.Event('scroll'));
  const replacement=document.createElement('div');replacement.className='preview';replacement.dataset.bodyPositionManaged='true';replacement.scrollTop=330;Object.defineProperties(replacement,{clientWidth:{value:200},clientHeight:{value:100}});f.area.replaceWith(replacement);await tick();assert.equal(replacement.scrollTop,330);
  replacement.scrollTop=355;replacement.dispatchEvent(new window.Event('scroll'));const saved=cache.entries().find(([key])=>JSON.parse(key)[2]==='body');assert.equal(saved?.[1].top,355);
  replacement.removeAttribute('data-body-position-managed');await tick();assert.equal(replacement.scrollTop,355);
  f.root.dataset.scrollOwner='card:B';await tick();assert.equal(replacement.scrollTop,0);replacement.scrollTop=10;replacement.dispatchEvent(new window.Event('scroll'));
  f.root.dataset.scrollOwner='card:A';await tick();assert.equal(replacement.scrollTop,355);
 }finally{stop();f.close();}
});
test('a shared card body viewport alone owns scroll memory while its non-scrolling editor is ignored',async()=>{
 const f=fixture(),cache=new ScrollPositions();f.area.classList.add('card-body-editor');const stop=attachScrollMemory(f.root,'workspace/shared-body',cache);let innerRestores=0;
 try{
  f.area.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true}));f.area.scrollTop=190;f.area.dispatchEvent(new window.Event('scroll'));
  const editor=document.createElement('div');editor.className='markdown-editor content';editor.dataset.markdownEditor='true';editor.style.overflow='visible';Object.defineProperties(editor,{clientWidth:{value:200},clientHeight:{value:1000},scrollTop:{get:()=>0,set:()=>{innerRestores++;}}});f.area.append(editor);await tick();assert.equal(innerRestores,0,'the inner editor cannot restore the viewport scroll offset');
  editor.dispatchEvent(new window.MouseEvent('pointerdown',{bubbles:true}));editor.dispatchEvent(new window.Event('scroll'));assert.equal(cache.entries().find(([key])=>JSON.parse(key)[2]==='body')?.[1].top,190,'an inner zero scroll event must not replace the viewport position');assert.equal(f.area.scrollTop,190);
 }finally{stop();f.close();}
});
