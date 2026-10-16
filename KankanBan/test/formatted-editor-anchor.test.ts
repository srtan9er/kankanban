import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formattedPointAtOffset,formattedCaretRect} from '../src/webview/formatted-editor-model.ts';

function fixture(html:string){
 const root=document.createElement('div');root.style.position='relative';root.innerHTML=html;document.body.append(root);
 const boxes=new Map<Element,DOMRect>(),rect=(left:number,top:number,width:number,height:number)=>new window.DOMRect(left,top,width,height),nativeRect=HTMLElement.prototype.getBoundingClientRect,nativeStyle=getComputedStyle;
 boxes.set(root,rect(100,50,600,400));
 const normal=document.createElement('p').style;normal.fontSize='16px';normal.lineHeight='24px';normal.fontFamily='TestBody';normal.marginTop='4px';
 HTMLElement.prototype.getBoundingClientRect=function(){if(this.hasAttribute('data-editor-caret-anchor'))return rect(100+parseFloat(this.style.left),50+parseFloat(this.style.top),0,parseFloat(this.style.height));return boxes.get(this)??nativeRect.call(this);};
 Object.assign(globalThis,{getComputedStyle:(element:Element)=>element.tagName==='P'&&!element.hasAttribute('data-test-style')?normal:(element as HTMLElement).style});
 return {root,boxes,rect,normal,close(){root.remove();HTMLElement.prototype.getBoundingClientRect=nativeRect;Object.assign(globalThis,{getComputedStyle:nativeStyle});}};
}
function anchor(root:HTMLElement){const element=root.querySelector<HTMLElement>('[data-editor-caret-anchor]');assert.ok(element);assert.equal(element.style.position,'absolute');assert.equal(element.style.width,'0px');assert.equal(element.style.overflow,'visible');assert.ok(parseFloat(element.style.height)>0);return element;}
test('empty-body caret uses the placeholder text position and font without adding a flow box',()=>{
 const f=fixture('<div class="markdown body-placeholder" style="font-size:18px;font-family:TestPlaceholder;line-height:30px;padding:4px 6px">Body placeholder</div>');
 try{const placeholder=f.root.firstElementChild as HTMLElement;f.boxes.set(placeholder,f.rect(124,68,520,38));const before=placeholder.outerHTML;formattedPointAtOffset(f.root,'',0);const caret=anchor(f.root);assert.equal(caret.style.left,'30px');assert.equal(caret.style.top,'22px');assert.equal(caret.style.height,'30px');assert.equal(caret.style.fontFamily,'TestPlaceholder');assert.equal(placeholder.outerHTML,before);const box=formattedCaretRect(f.root,'',0)!;assert.equal(box.left,130);assert.equal(box.top,72);assert.equal(box.height,30);}finally{f.close();}
});
test('an empty heading caret stays at its real text origin with the heading line height',()=>{
 const f=fixture('<div class="rich-image-body"><div class="rich-image-flow"><h1 data-md-kind="h1" style="font-size:26px;font-family:TestHeading;line-height:39px;padding:3px 4px;border:2px solid"></h1></div></div>');
 try{const heading=f.root.querySelector('h1')!,flow=f.root.querySelector('.rich-image-flow')!,before=flow.outerHTML;f.boxes.set(heading,f.rect(128,82,544,0));formattedPointAtOffset(f.root,'# ',2);const caret=anchor(f.root);assert.equal(caret.style.left,'34px');assert.equal(caret.style.top,'37px');assert.equal(caret.style.height,'39px');assert.equal(caret.style.fontFamily,'TestHeading');assert.equal(flow.outerHTML,before);assert.equal(heading.childNodes.length,0);}finally{f.close();}
});
test('a trailing empty line uses body typography and inset below the last heading without changing flow',()=>{
 const f=fixture('<div class="rich-image-body" style="--md-inset-x:28px;--md-inset-y:18px"><div class="rich-image-flow"><h1 data-md-kind="h1" style="font-size:24px;font-family:TestHeading;line-height:36px;margin-bottom:8px"><span data-source-start="2" data-source-end="7">Title</span></h1></div></div>');
 try{const body=f.root.firstElementChild!,heading=f.root.querySelector('h1')!,text=f.root.querySelector('span')!,flow=f.root.querySelector('.rich-image-flow')!,before=flow.outerHTML;f.boxes.set(body,f.rect(100,50,600,100));f.boxes.set(heading,f.rect(128,72,544,36));f.boxes.set(text,f.rect(128,72,90,36));formattedPointAtOffset(f.root,'# Title\n',8);const caret=anchor(f.root);assert.equal(caret.style.left,'28px');assert.equal(caret.style.top,'66px');assert.equal(caret.style.height,'24px');assert.equal(caret.style.fontFamily,'TestBody');assert.equal(flow.outerHTML,before);const box=formattedCaretRect(f.root,'# Title\n',8)!;assert.equal(box.left,128);assert.equal(box.top,116);assert.equal(box.height,24);}finally{f.close();}
});
