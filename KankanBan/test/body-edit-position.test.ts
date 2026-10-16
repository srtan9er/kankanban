import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {usePressEdit} from '../src/webview/usePressEdit.ts';
import {bodyPreviewCaretFromPoint,bodyPreviewCaretAtOffset,captureBodyEditPosition,captureVisibleBodyEditPosition,restoreBodyEditPosition,sourceEditorCaretRect,sourceEditorCaretFromPoint,type BodyEditPoint} from '../src/webview/body-edit-position.ts';
import {renderMarkdownEditor,setMarkdownEditorSelection,getMarkdownEditorRange,markdownEditorOffsetAtPoint} from '../src/webview/markdown-editor-model.ts';
import {PrototypeNote} from '../src/webview/PrototypeNote.tsx';
import {getVisualEditorSelection} from '../src/webview/VisualBodyEditor.tsx';
import {openSession,createCard} from '../src/core/workspace.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {EditMode} from '../src/webview/edit-mode.ts';

const rect=(left:number,top:number,width=1,height=20)=>({left,top,right:left+width,bottom:top+height,x:left,y:top,width,height,toJSON(){}}) as DOMRect;
function preview(html:string){const root=document.createElement('div');root.innerHTML=html;root.getBoundingClientRect=()=>rect(20,40,300,180);document.body.append(root);return root;}
function caretFromPoint(node:Node,offset:number){const doc=document as unknown as Record<string,unknown>,previous=doc.caretPositionFromPoint;doc.caretPositionFromPoint=()=>({offsetNode:node,offset});return ()=>{if(previous)doc.caretPositionFromPoint=previous;else delete doc.caretPositionFromPoint;};}
function caretGeometry(){const prototype=window.Range.prototype as {getBoundingClientRect?:()=>DOMRect},previous=prototype.getBoundingClientRect;prototype.getBoundingClientRect=function(this:Range){const parent=this.startContainer.nodeType===3?this.startContainer.parentElement:this.startContainer as HTMLElement,box=parent?.getBoundingClientRect() ?? rect(0,0);return rect(box.left+this.startOffset*10,box.top,0,box.height || 20);};return ()=>{if(previous)prototype.getBoundingClientRect=previous;else delete prototype.getBoundingClientRect;};}

test('clicking formatted text keeps its exact source character, including links and code',()=>{
 const source='前 **粗体** 与 [链接](https://example.test) `代码`',link=source.indexOf('链接'),code=source.indexOf('代码');
 const root=preview(`<a data-source-start="${link}" data-source-end="${link+2}">链接</a><code data-source-start="${code}" data-source-end="${code+2}">代码</code>`),geometry=caretGeometry();
 try{for(const element of root.children){const restore=caretFromPoint(element.firstChild!,1);try{const caret=bodyPreviewCaretFromPoint(root,source,{clientX:40,clientY:60});assert.equal(caret?.offset,Number((element as HTMLElement).dataset.sourceStart)+1);}finally{restore();}}}finally{geometry();root.remove();}
});
test('collapsed Pretext whitespace uses the source map rather than rendered text length',()=>{
 const source='prefix 甲   乙',root=preview('<span data-source-start="7" data-source-end="12" data-source-map="[7,8,11,12]">甲 乙</span>'),restore=caretFromPoint(root.firstChild!.firstChild!,2),geometry=caretGeometry();
 try{assert.equal(bodyPreviewCaretFromPoint(root,source,{clientX:40,clientY:60})?.offset,11);assert.equal(bodyPreviewCaretAtOffset(root,11)?.offset,11);}finally{geometry();restore();root.remove();}
});
test('source lookup resolves a fragment at its visible position and includes the final caret',()=>{
 const root=preview('<span data-source-start="3" data-source-end="5">甲乙</span><span data-source-start="9" data-source-end="12">丙丁戊</span>'),geometry=caretGeometry();
 (root.children[0] as HTMLElement).getBoundingClientRect=()=>rect(50,80,20,20);(root.children[1] as HTMLElement).getBoundingClientRect=()=>rect(50,130,30,20);
 try{const caret=bodyPreviewCaretAtOffset(root,11);assert.equal(caret?.offset,11);assert.equal(caret?.rect.left,70);assert.equal(caret?.rect.top,130);const end=bodyPreviewCaretAtOffset(root,12);assert.equal(end?.rect.left,80);}finally{geometry();root.remove();}
});
test('image-only and table-only previews resolve both source boundaries to their own object frame',()=>{
 for(const kind of ['image','table']){
  const root=preview(`<div class="image-placement" data-object-type="${kind}" data-source-image-start="0" data-source-image-end="200"></div>`),frame=root.firstElementChild as HTMLElement;frame.getBoundingClientRect=()=>rect(50,90,160,80);
  try{const before=bodyPreviewCaretAtOffset(root,0),after=bodyPreviewCaretAtOffset(root,200);assert.equal(before?.offset,0);assert.equal(before?.rect.left,50);assert.equal(before?.rect.top,90);assert.equal(after?.offset,200);assert.equal(after?.rect.left,210);assert.equal(after?.rect.top,90);}finally{root.remove();}
 }
});
test('exact object boundaries outrank neighbouring text but ordinary source-map text keeps its own caret',()=>{
 const root=preview('<span data-source-start="0" data-source-end="2">前文</span><div class="image-placement" data-source-image-start="2" data-source-image-end="100"></div><span data-source-start="100" data-source-end="106" data-source-map="[100,105,106]">后文</span>'),geometry=caretGeometry();
 (root.children[0] as HTMLElement).getBoundingClientRect=()=>rect(30,60,20,20);(root.children[1] as HTMLElement).getBoundingClientRect=()=>rect(50,100,160,80);(root.children[2] as HTMLElement).getBoundingClientRect=()=>rect(30,200,20,20);
 try{assert.equal(bodyPreviewCaretAtOffset(root,2)?.rect.top,100);assert.equal(bodyPreviewCaretAtOffset(root,100)?.rect.top,100);assert.equal(bodyPreviewCaretAtOffset(root,105)?.rect.top,200);assert.equal(bodyPreviewCaretAtOffset(root,105)?.rect.left,40);}finally{geometry();root.remove();}
});
test('table cell text and nested image offsets do not masquerade as outer body source coordinates',()=>{
 const root=preview('<div class="image-placement" data-object-type="table" data-source-image-start="0" data-source-image-end="200"><span data-source-start="0" data-source-end="2">单元</span><div class="image-placement" data-source-image-start="0" data-source-image-end="10"></div></div>'),frame=root.firstElementChild as HTMLElement;frame.getBoundingClientRect=()=>rect(50,100,160,80);
 try{const caret=bodyPreviewCaretAtOffset(root,1);assert.equal(caret?.offset,0);assert.equal(caret?.rect.left,50);assert.equal(caret?.rect.top,100);}finally{root.remove();}
});
test('leaving editing restores the same source anchor despite different rendered height',()=>{
 const viewport=preview('');viewport.scrollTop=420;viewport.scrollLeft=60;Object.defineProperties(viewport,{clientTop:{value:2},clientLeft:{value:2},clientWidth:{value:280},clientHeight:{value:160}});
 try{const position=captureBodyEditPosition(viewport,67,rect(82,102,0,22));assert.deepEqual(position,{offset:67,viewportX:60,viewportY:60});const restored=restoreBodyEditPosition(viewport,position,offset=>{assert.equal(offset,67);return rect(102,242,0,22);});assert.equal(restored,true);assert.equal(viewport.scrollTop,560);assert.equal(viewport.scrollLeft,80);}finally{viewport.remove();}
});
test('a last editing caret outside the view is clamped into the visible viewport on return',()=>{
 const viewport=preview('');Object.defineProperties(viewport,{clientWidth:{value:300},clientHeight:{value:100}});
 try{const position=captureBodyEditPosition(viewport,23,rect(900,900,0,20));assert.equal(position.viewportY,80);assert.equal(position.viewportX,300);viewport.scrollTop=15;assert.equal(restoreBodyEditPosition(viewport,position,()=>null),false);assert.equal(viewport.scrollTop,15);}finally{viewport.remove();}
});
test('visible source caret is preferred while an offscreen caret uses the current top visible text',()=>{
 const viewport=preview('');Object.defineProperties(viewport,{clientWidth:{value:300},clientHeight:{value:100}});
 try{
  const visible={offset:42,rect:rect(80,70,0,20)},offscreen={offset:9,rect:rect(80,-200,0,20)};let called=false;
  assert.deepEqual(captureVisibleBodyEditPosition(viewport,visible,()=>{called=true;return null;}),{offset:42,viewportX:60,viewportY:30});assert.equal(called,false);
  const position=captureVisibleBodyEditPosition(viewport,offscreen,point=>{called=true;assert.ok(point.clientY>=40 && point.clientY<60);return {offset:130,rect:rect(80,48,0,20)};});assert.equal(position?.offset,130);assert.equal(position?.viewportY,8);assert.equal(called,true);
  assert.equal(captureVisibleBodyEditPosition(viewport,null,()=>null),null);
 }finally{viewport.remove();}
});
test('source editor caret geometry counts hidden image attributes instead of the short display token',()=>{
 const value=`前 <image name="image_0" src="../assets/images/${'a'.repeat(64)}.png" layout="inline"></image> 后`,root=preview(''),geometry=caretGeometry();renderMarkdownEditor(root,value);
 const atom=root.querySelector<HTMLElement>('[data-markdown-token]')!,tail=atom.nextSibling!,after=value.indexOf(' 后');atom.getBoundingClientRect=()=>rect(100,60,90,20);
 try{
  const restore=caretFromPoint(tail,2);try{assert.equal(sourceEditorCaretFromPoint(root,{clientX:210,clientY:60})?.offset,after+2);}finally{restore();}
  const caret=sourceEditorCaretRect(root,after+2);assert.ok(caret);assert.equal(caret.left,40);
 }finally{geometry();root.remove();}
});
test('source editor adapters preserve browser-created block newlines without moving the selection',()=>{
 const root=preview('<div>甲乙</div><div>丙丁</div>'),geometry=caretGeometry(),last=root.lastChild!.firstChild!,restore=caretFromPoint(last,1),selection=document.getSelection()!,range=document.createRange();range.setStart(root.firstChild!.firstChild!,1);range.collapse(true);selection.removeAllRanges();selection.addRange(range);
 try{assert.equal(sourceEditorCaretFromPoint(root,{clientX:60,clientY:70})?.offset,4);const caret=sourceEditorCaretRect(root,4);assert.ok(caret);assert.equal(selection.anchorNode,root.firstChild!.firstChild);assert.equal(selection.anchorOffset,1);}finally{restore();geometry();selection.removeAllRanges();root.remove();}
});
test('excluded image, table, button and child-card presses are never mapped into body text',()=>{
 const root=preview('<span data-source-start="0" data-source-end="2">正文</span><button>go</button><div class="image-placement">image</div><div class="editable-table">table</div><div data-card-id="child">child</div>');
 try{for(const target of [...root.children].slice(1))assert.equal(bodyPreviewCaretFromPoint(root,'正文',{clientX:30,clientY:50,target}),null);}finally{root.remove();}
});

function pointer(target:EventTarget,type:string,x:number,y:number){const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y,screenX:x,screenY:y});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);}
test('press-edit passes the original pointer position and target, and still rejects drags',async()=>{
 const calls:{field:string;point:BodyEditPoint|undefined}[]=[],host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 function Harness(){const handlers=usePressEdit('note',(field,point)=>calls.push({field,point}));return createElement('div',handlers,createElement('div',{className:'preview'},createElement('strong',null,'正文')));}
 try{await act(async()=>root.render(createElement(Harness)));const text=host.querySelector('strong')!;
  await act(async()=>{pointer(text,'pointerdown',30,40);pointer(text,'pointerup',32,42);text.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:32,clientY:42}));});assert.equal(calls[0]?.field,'content');assert.deepEqual(calls[0]?.point,{clientX:30,clientY:40,target:text});
  await act(async()=>{pointer(text,'pointerdown',30,40);pointer(document,'pointermove',60,40);pointer(text,'pointerup',60,40);text.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:60,clientY:40}));});assert.equal(calls.length,1);
  await act(async()=>text.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:0})));assert.equal(calls.length,2);assert.equal(calls[1]?.point,undefined);
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('a body click queued behind saving a title still enters at the clicked source character',async()=>{
 Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
 const content='**目标** 后面的正文',session=openSession('/body-entry-position',{ops:createMemoryFs().ops}),id=createCard(session,{parentId:null,title:'Title',content}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);let release!:()=>void;
 const saving=new Promise<void>(resolve=>{release=resolve;});let saveStarted=false;
 try{
  await act(async()=>root.render(createElement(PrototypeNote,{card:session.state.cards.get(id)!,send:async request=>{if(request.kind==='edit'){saveStarted=true;await saving;}return {};},children:null,breadcrumb:null,add:()=>{}})));
  const title=host.querySelector<HTMLInputElement>('.title')!;await act(async()=>title.click());await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(title,'Changed');title.dispatchEvent(new Event('input',{bubbles:true}));});
  const initialVisual=host.querySelector<HTMLElement>('[data-visual-editor]')!;assert.ok(initialVisual);assert.equal(initialVisual.getAttribute('data-visual-active'),'false');
  const text=host.querySelector<HTMLElement>('.preview strong')!,restore=caretFromPoint(text.firstChild!,1);
  try{
   await act(async()=>{pointer(text,'pointerdown',30,40);pointer(text,'pointerup',30,40);text.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,clientX:30,clientY:40}));});assert.equal(saveStarted,true);assert.equal(host.querySelector('[data-visual-editor]'),initialVisual);assert.equal(initialVisual.getAttribute('data-visual-active'),'false');assert.equal(initialVisual.getAttribute('contenteditable'),null);
   await act(async()=>release());const visual=host.querySelector<HTMLElement>('[data-visual-editor]')!;assert.equal(visual,initialVisual,'activating input keeps the existing formatted surface');assert.equal(visual.getAttribute('data-visual-active'),'true');assert.equal(visual.getAttribute('contenteditable'),'true');assert.equal(getVisualEditorSelection(visual).offset,content.indexOf('目标')+1);
  }finally{restore();}
 }finally{release();await act(async()=>root.unmount());host.remove();}
});

async function bodyPositionFixture(run:(host:HTMLElement,viewport:HTMLElement,source:HTMLElement)=>Promise<void>,content='0123456789'.repeat(20)){
 Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
 const session=openSession('/body-view-position',{ops:createMemoryFs().ops}),id=createCard(session,{parentId:null,title:'Title',content}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 const prototype=window.Range.prototype as {getBoundingClientRect?:()=>DOMRect;getClientRects?:()=>DOMRectList},previousRect=prototype.getBoundingClientRect,previousRects=prototype.getClientRects;
 prototype.getBoundingClientRect=function(this:Range){
  const element=this.startContainer.nodeType===3?this.startContainer.parentElement:this.startContainer as HTMLElement,pane=element?.closest<HTMLElement>('.card-body-editor'),editor=element?.closest<HTMLElement>('[data-markdown-editor]'),fragment=element?.closest<HTMLElement>('[data-source-start]');
  let sourceOffset=this.startOffset,base=600;
  if(editor){base=editor.hasAttribute('data-visual-editor')?600:500;if(!editor.hasAttribute('data-visual-editor'))sourceOffset=markdownEditorOffsetAtPoint(editor,this.startContainer,this.startOffset);else if(fragment)sourceOffset=Number(fragment.dataset.sourceStart)+this.startOffset;}
  else if(fragment)sourceOffset=Number(fragment.dataset.sourceStart)+this.startOffset;
  return rect(20,base+sourceOffset*10-(pane?.scrollTop??0),Math.max(0,(this.endOffset-this.startOffset)*10),20);
 };
 prototype.getClientRects=function(this:Range){const value=this.getBoundingClientRect();return Object.assign([value],{item:(index:number)=>index===0?value:null}) as unknown as DOMRectList;};
 try{
  function Harness(){const [editable,setEditable]=useState(true);return createElement(EditMode.Provider,{value:{editable,busy:false,toggle:()=>setEditable(value=>!value)}},createElement(PrototypeNote,{card:session.state.cards.get(id)!,send:async()=>({}),children:null,breadcrumb:null,add:()=>{}}));}
  await act(async()=>root.render(createElement(Harness)));
  const pane=host.querySelector<HTMLElement>('.card-body-editor')!;pane.getBoundingClientRect=()=>rect(0,0,400,200);Object.defineProperties(pane,{clientWidth:{value:400},clientHeight:{value:200}});
  await act(async()=>pane.dispatchEvent(new MouseEvent('click',{bubbles:true})));await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="切换到 Markdown 源码"]')!.click());
  const source=host.querySelector<HTMLElement>('[data-markdown-editor]:not([data-visual-editor])')!;assert.ok(source);await run(host,pane,source);
 }finally{await act(async()=>root.unmount());host.remove();if(previousRect)prototype.getBoundingClientRect=previousRect;else delete prototype.getBoundingClientRect;if(previousRects)prototype.getClientRects=previousRects;else delete prototype.getClientRects;}
}
test('ending source input retains its surface and an explicit visual switch maps the source anchor',()=>bodyPositionFixture(async(host,viewport,source)=>{
 viewport.scrollTop=500;setMarkdownEditorSelection(source,6);
 await act(async()=>host.querySelector('.note-title-row')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0})));
 assert.equal(host.querySelector('[data-markdown-editor]'),source);assert.equal(viewport.dataset.editorMode,'source');assert.equal(viewport.dataset.bodyEditing,'false');assert.equal(viewport.scrollTop,500);
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="切换到排版编辑"]')!.click());assert.equal(viewport.dataset.editorMode,'visual');assert.equal(viewport.scrollTop,600);assert.equal(getVisualEditorSelection(host.querySelector<HTMLElement>('[data-visual-editor]')!).offset,6);
}));
test('ending source input and then switching visual after scrolling preserves the top visible source anchor',()=>bodyPositionFixture(async(host,viewport,source)=>{
 viewport.scrollTop=1000;setMarkdownEditorSelection(source,0);const restore=caretFromPoint(source.firstChild!,50);
 try{await act(async()=>host.querySelector('.note-title-row')!.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0})));assert.equal(host.querySelector('[data-markdown-editor]'),source);assert.equal(viewport.dataset.bodyEditing,'false');assert.equal(viewport.scrollTop,1000);await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="切换到排版编辑"]')!.click());assert.equal(viewport.scrollTop,1100);}finally{restore();}
}));
test('source to formatted editing restores the same source caret and its viewport anchor',()=>bodyPositionFixture(async(host,viewport,source)=>{
 viewport.scrollTop=500;setMarkdownEditorSelection(source,6);
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="切换到排版编辑"]')!.click());const visual=host.querySelector<HTMLElement>('[data-visual-editor]')!;assert.ok(visual);assert.equal(visual.getAttribute('data-visual-active'),'true');assert.equal(getVisualEditorSelection(visual).offset,6);assert.equal(viewport.scrollTop,600);
}));
test('switching the window to browse mode also preserves the final editing viewport',()=>bodyPositionFixture(async(host,viewport,source)=>{
 viewport.scrollTop=500;setMarkdownEditorSelection(source,6);await act(async()=>host.querySelector<HTMLButtonElement>('.note-title-row .toggle')!.click());assert.equal(host.querySelector('[data-markdown-editor]'),source);assert.equal(source.getAttribute('contenteditable'),'false');assert.equal(viewport.dataset.editorMode,'source');assert.equal(viewport.dataset.bodyEditing,'false');assert.equal(viewport.scrollTop,500);
}));
test('pressing the shared body scrollbar does not leave editing before the user scrolls',()=>bodyPositionFixture(async(host,viewport)=>{
 viewport.style.overflowY='auto';viewport.getBoundingClientRect=()=>rect(0,0,416,200);Object.defineProperties(viewport,{offsetWidth:{value:416},offsetHeight:{value:200},scrollHeight:{value:2000}});
 assert.equal(viewport.dataset.bodyEditing,'true');await act(async()=>viewport.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,clientX:410,clientY:100})));assert.ok(host.querySelector('[data-markdown-editor]'),'the persistent viewport scrollbar belongs to the body editing surface');assert.equal(viewport.dataset.bodyEditing,'true');
}));
test('switching both editor modes retains full source offsets after an atomic image tag',async()=>{
 const content=`前 <image src="../assets/images/${'a'.repeat(64)}.png" name="image_0" layout="inline">说明</image> 后面的正文`,offset=content.indexOf('后面')+1;
 await bodyPositionFixture(async(host,_viewport,source)=>{
  setMarkdownEditorSelection(source,offset);await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="切换到排版编辑"]')!.click());let visual=host.querySelector<HTMLElement>('[data-visual-editor]')!;assert.equal(getVisualEditorSelection(visual).offset,offset);
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="切换到 Markdown 源码"]')!.click());const current=host.querySelector<HTMLElement>('[data-markdown-editor]:not([data-visual-editor])')!;assert.equal(getMarkdownEditorRange(current).start,offset);assert.ok(current.querySelector('[data-markdown-token]'));
 },content);
});
