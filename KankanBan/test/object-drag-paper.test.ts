import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {objectDragPaper,edgeScrollVelocity} from '../src/webview/object-drag-paper.ts';
test('temporary paper grows in both axes without changing text width, scrolls at edges and disappears on release',()=>{
 const previous={requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame},queue=new Map<number,FrameRequestCallback>();let next=0;
 globalThis.requestAnimationFrame=callback=>{queue.set(++next,callback);return next;};globalThis.cancelAnimationFrame=id=>{queue.delete(id);};
 const pane=document.createElement('div'),root=document.createElement('div');pane.className='preview';pane.style.overflow='auto';root.style.position='relative';pane.append(root);document.body.append(pane);
 const rect=(x:number,y:number,w:number,h:number)=>({x,y,left:x,top:y,right:x+w,bottom:y+h,width:w,height:h,toJSON(){}} as DOMRect);
 Object.defineProperties(pane,{clientWidth:{value:200},clientHeight:{value:120}});Object.defineProperties(root,{clientWidth:{value:200},clientHeight:{value:120}});
 pane.getBoundingClientRect=()=>rect(0,0,200,120);root.getBoundingClientRect=()=>rect(-pane.scrollLeft,-pane.scrollTop,200,120);
 let updates=0;const paper=objectDragPaper(root,()=>{updates++;});
 const frame=(time:number)=>{const [id,callback]=queue.entries().next().value!;queue.delete(id);callback(time);};
 try{
  paper.update({clientX:195,clientY:115},{x:400,y:500,width:200,height:100});const spacer=root.querySelector<HTMLElement>('[data-object-drag-paper]')!;
  assert.ok(Number.parseFloat(spacer.style.width)>=800);assert.ok(Number.parseFloat(spacer.style.height)>=720);assert.equal(root.style.width,'');assert.equal(root.style.padding,'');
  frame(16);assert.equal(updates,0);frame(32);frame(48);assert.ok(pane.scrollLeft>0);assert.ok(pane.scrollTop>0);assert.equal(updates,2);
  const extent={width:spacer.style.width,height:spacer.style.height};paper.update({clientX:100,clientY:60},{x:0,y:0,width:10,height:10});assert.equal(spacer.style.width,extent.width);assert.equal(spacer.style.height,extent.height);
  frame(64);assert.equal(updates,2);paper.update({clientX:195,clientY:115});frame(10000);assert.equal(updates,2);frame(10016);assert.equal(updates,3);paper.stop();assert.equal(root.querySelector('[data-object-drag-paper]'),null);assert.equal(queue.size,0);
  paper.update({clientX:195,clientY:115});assert.equal(root.childElementCount,0);
 }finally{paper.stop();pane.remove();Object.assign(globalThis,previous);}
});
test('dragging in the middle adds no space; approaching a boundary expands only that axis',()=>{
 const previous={requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame};
 globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
 const pane=document.createElement('div'),root=document.createElement('div');pane.className='preview';pane.append(root);document.body.append(pane);
 const rect={x:0,y:0,left:0,top:0,right:200,bottom:120,width:200,height:120,toJSON(){}} as DOMRect;pane.getBoundingClientRect=()=>rect;root.getBoundingClientRect=()=>rect;
 Object.defineProperties(root,{clientWidth:{value:200},clientHeight:{value:120}});
 let paper=objectDragPaper(root,()=>{});
 const sizes=()=>{const spacer=root.querySelector<HTMLElement>('[data-object-drag-paper]')!;return {width:Number.parseFloat(spacer.style.width)||0,height:Number.parseFloat(spacer.style.height)||0};};
 try{
  paper.update({clientX:100,clientY:60},{x:50,y:40,width:40,height:20});assert.ok(sizes().width<=200);assert.ok(sizes().height<=120);
  paper.update({clientX:167,clientY:60});assert.ok(sizes().width<=200);assert.ok(sizes().height<=120);
  paper.update({clientX:195,clientY:60});assert.ok(sizes().width>200);assert.ok(sizes().height<=120);
  paper.stop();paper=objectDragPaper(root,()=>{});paper.update({clientX:100,clientY:115});assert.ok(sizes().height>120);assert.ok(sizes().width<=200);
 }finally{paper.stop();pane.remove();Object.assign(globalThis,previous);}
});

test('edge scrolling accelerates by square-root time and limits the total diagonal speed',()=>{
 const rect={left:0,top:0,right:200,bottom:120},point={clientX:250,clientY:170};
 assert.deepEqual(edgeScrollVelocity(point,rect,0),{x:0,y:0});
 const one=edgeScrollVelocity(point,rect,1);assert.ok(Math.abs(Math.hypot(one.x,one.y)-600)<.001);
 const four=edgeScrollVelocity(point,rect,4);assert.ok(Math.abs(Math.hypot(four.x,four.y)-900)<.001);
 assert.deepEqual(edgeScrollVelocity({clientX:100,clientY:60},rect,100),{x:0,y:0});
});
