import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {CardRegions,CHILD_BAR_MIN_HEIGHT,CHILD_BAR_MIN_WIDTH,type ChildArea} from '../src/webview/CardRegions.tsx';

const css=readFileSync(new URL('../src/webview/workspace.css',import.meta.url),'utf8');
const pointer=(target:EventTarget,type:string,x=0,y=0)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y}));
async function fixture(vertical:boolean,collapsed=false){
 const host=document.createElement('div'),root=createRoot(host),style=document.createElement('style');style.textContent=css;document.head.append(style);document.body.append(host);let added=0;
 const expanded={width:vertical?CHILD_BAR_MIN_WIDTH:9999,height:vertical?9999:CHILD_BAR_MIN_HEIGHT},saved:ChildArea[]=[];
 const render=async(size:ChildArea)=>act(async()=>root.render(createElement(CardRegions,{vertical,saved:size,save:area=>saved.push(area),body:createElement('div',null,'Body'),children:createElement('div',null,'Children'),add:()=>{added++;}})));
 await render(collapsed?{width:0,height:0}:expanded);
 return {host,expanded,saved,render,added:()=>added,button:()=>host.querySelector<HTMLButtonElement>('.card-regions > .floating-add-card')!,panel:()=>host.querySelector<HTMLElement>('.child-region')!,close:async()=>{await act(async()=>root.unmount());host.remove();style.remove();}};
}

for(const vertical of [false,true])test(`${vertical?'vertical':'horizontal'} child creation fades with collapse, remains mounted, and cannot create while hidden`,async()=>{
 const f=await fixture(vertical);
 try{
  const button=f.button();assert.equal(button.disabled,false);assert.equal(getComputedStyle(button).opacity,'1');
  await f.render({width:0,height:0});assert.equal(f.button(),button,'retaining the same button lets opacity finish its transition');assert.equal(button.disabled,true);assert.equal(button.tabIndex,-1);assert.equal(button.getAttribute('aria-hidden'),'true');
  const closed=getComputedStyle(button);assert.equal(closed.opacity,'0');assert.equal(closed.pointerEvents,'none');assert.match(closed.transition,/opacity 140ms ease/);assert.match(closed.transition,/visibility 0s linear 140ms/);assert.equal(f.panel().style.transition,`${vertical?'width':'height'} 140ms ease`);
  await act(async()=>button.click());assert.equal(f.added(),0);
  await f.render(f.expanded);assert.equal(f.button(),button);assert.equal(button.disabled,false);assert.equal(button.tabIndex,0);assert.equal(button.getAttribute('aria-hidden'),'false');const open=getComputedStyle(button);assert.equal(open.opacity,'1');assert.equal(open.visibility,'visible');assert.match(open.transition,/opacity 140ms ease/);assert.doesNotMatch(open.transition,/visibility 0s linear 140ms/);
  await act(async()=>button.click());assert.equal(f.added(),1);
 }finally{await f.close();}
});
for(const vertical of [false,true])test(`${vertical?'vertical':'horizontal'} resize threshold fades the creation control before release and reverses smoothly`,async()=>{
 const f=await fixture(vertical);
 try{
  const region=f.host.querySelector<HTMLElement>('.card-regions')!,minimum=vertical?CHILD_BAR_MIN_WIDTH:CHILD_BAR_MIN_HEIGHT;region.getBoundingClientRect=()=>({left:0,top:0,right:640,bottom:480,width:640,height:480,x:0,y:0,toJSON(){}});
  const move=async(extent:number)=>act(async()=>{pointer(document,'pointermove',vertical?640-extent:0,vertical?0:480-extent);});
  await act(async()=>{pointer(f.host.querySelector('.child-region-resizer')!,'pointerdown');});await move(minimum/2-1);
  assert.equal(f.button().disabled,true);assert.equal(getComputedStyle(f.button()).opacity,'0');assert.match(f.panel().style.transition,/140ms ease/);assert.equal(f.saved.length,0,'visibility follows the drag without waiting for save');
  await move(minimum/2+1);assert.equal(f.button().disabled,false);assert.equal(getComputedStyle(f.button()).opacity,'1');assert.match(f.panel().style.transition,/140ms ease/);
  await act(async()=>{pointer(document,'pointerup');});assert.deepEqual(f.saved,[f.expanded]);
 }finally{await f.close();}
});
test('an initially collapsed child bar hides creation but leaves its expansion rails available',async()=>{
 const f=await fixture(false,true);
 try{assert.equal(f.button().disabled,true);assert.equal(getComputedStyle(f.button()).opacity,'0');assert.equal(getComputedStyle(f.button()).visibility,'hidden');assert.ok(f.host.querySelector('.child-region-resizer'));assert.equal(f.host.querySelector<HTMLButtonElement>('.child-region-resizer')!.disabled,false);}finally{await f.close();}
});
test('other floating creation buttons do not inherit the child bar fade state',async()=>{
 const f=await fixture(false,true),other=document.createElement('button');other.className='floating-add-card';f.host.append(other);
 try{assert.notEqual(getComputedStyle(other).opacity,'0');assert.notEqual(getComputedStyle(other).visibility,'hidden');assert.equal(other.disabled,false);}finally{await f.close();}
});
