import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement,createRef} from 'react';
import {createRoot} from 'react-dom/client';
import {VisualBodyEditor,getVisualEditorSelection,setVisualEditorSelection,insertVisualEditorMarkup} from '../src/webview/VisualBodyEditor.tsx';
import {emptyTableMarkup} from '../src/core/table-markdown.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
const nativeStyle=getComputedStyle,bodyStyle=document.createElement('div').style;bodyStyle.fontSize='13px';bodyStyle.lineHeight='20.8px';bodyStyle.fontFamily='sans-serif';Object.assign(globalThis,{getComputedStyle:(element:Element)=>element.closest('.rich-image-body')?bodyStyle:nativeStyle(element)});

const key=(host:Element,key:string,options:KeyboardEventInit={})=>host.querySelector('[data-visual-editor]')!.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options}));
test('visual editing displays actual formatting, does not write on open, and keeps source selection',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let writes=0;
 const source='# Heading\n\n**Hello** *world*';
 try{
  await act(async()=>root.render(createElement(VisualBodyEditor,{ref,value:source,onChange:()=>{writes++;},initialSourceOffset:source.indexOf('world')})));
  assert.equal(host.querySelector('h1')?.textContent,'Heading');assert.equal(host.querySelector('strong')?.textContent,'Hello');assert.equal(host.querySelector('em')?.textContent,'world');assert.equal(writes,0);assert.ok(host.querySelector('.kkb-markdown.rich-image-body .rich-image-flow'));assert.equal(host.querySelector('h1')?.getAttribute('data-md-kind'),'h1');
  setVisualEditorSelection(ref.current!,source.indexOf('world')+2);assert.equal(getVisualEditorSelection(ref.current!).offset,source.indexOf('world')+2);
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('Ctrl+B / Ctrl+I / Ctrl+Shift+X persist markdown and support native history shortcuts',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='Hello world';
 const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 try{
  await act(async()=>render());setVisualEditorSelection(ref.current!,0,5);await act(async()=>key(host,'b',{ctrlKey:true}));assert.equal(value,'**Hello** world');assert.equal(host.querySelector('strong')?.textContent,'Hello');
  await act(async()=>key(host,'z',{ctrlKey:true}));assert.equal(value,'Hello world');await act(async()=>key(host,'y',{ctrlKey:true}));assert.equal(value,'**Hello** world');
  setVisualEditorSelection(ref.current!,String(value).indexOf('world'),String(value).length);await act(async()=>key(host,'i',{ctrlKey:true}));assert.ok(host.querySelector('em'));await act(async()=>key(host,'X',{ctrlKey:true,shiftKey:true}));assert.ok(host.querySelector('del'));assert.ok(String(value).includes('~~'));
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('single Enter is a visible line break and inserting a protected table keeps a real preview',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='FirstSecond';
 const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 try{
  await act(async()=>render());setVisualEditorSelection(ref.current!,5);await act(async()=>key(host,'Enter'));assert.equal(value,'First\nSecond');assert.deepEqual([...host.querySelectorAll('[data-md-kind=p]')].map(node=>node.textContent),['First','Second']);
  setVisualEditorSelection(ref.current!,value.length);const table=emptyTableMarkup(value);await act(async()=>insertVisualEditorMarkup(ref.current!,table));assert.ok(value.includes(table));assert.equal(host.querySelectorAll('[data-table-cell]').length,4);
  setVisualEditorSelection(ref.current!,0,value.length);await act(async()=>key(host,'b',{ctrlKey:true}));assert.ok(value.includes(table));
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('paste uses plain text and never inserts executable clipboard HTML',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='';
 const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 try{
  await act(async()=>render());setVisualEditorSelection(ref.current!,0);const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:(type:string)=>type==='text/html'?'<img src=x onerror="bad()"><script>bad()</script>':'Safe text',files:[]}});
  await act(async()=>host.querySelector('[data-visual-editor]')!.dispatchEvent(event));assert.equal(value,'Safe text');assert.equal(host.querySelector('script,img'),null);
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('disabled visual editor rejects formatting, insertion and clipboard mutation',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let writes=0;
 try{
  await act(async()=>root.render(createElement(VisualBodyEditor,{ref,value:'Read only',disabled:true,onChange:()=>{writes++;}})));setVisualEditorSelection(ref.current!,0,4);
  await act(async()=>key(host,'b',{ctrlKey:true}));await act(async()=>insertVisualEditorMarkup(ref.current!,emptyTableMarkup('')));assert.equal(writes,0);assert.equal(host.querySelector('strong,table'),null);
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('external updates refresh rendered content without writing back and retain a valid caret',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let writes=0,value='Old';
 const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:()=>{writes++;}}));
 try{
  await act(async()=>render());setVisualEditorSelection(ref.current!,2);ref.current!.focus();value='# New external';await act(async()=>render());assert.equal(host.querySelector('h1')?.textContent,'New external');assert.equal(writes,0);assert.ok(getVisualEditorSelection(ref.current!).offset<=value.length);
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('internal copy and paste keeps selected rich marks instead of copying a broken delimiter fragment',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='**Hello** tail';const data=new Map<string,string>();
 const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 const clipboard=(type:string)=>{const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:(mime:string)=>data.get(mime) ?? '',setData:(mime:string,text:string)=>data.set(mime,text),files:[]}});return event;};
 try{
  await act(async()=>render());setVisualEditorSelection(ref.current!,3,6);await act(async()=>host.querySelector('[data-visual-editor]')!.dispatchEvent(clipboard('copy')));assert.equal(data.get('text/plain'),'**ell**');
  setVisualEditorSelection(ref.current!,value.length);await act(async()=>host.querySelector('[data-visual-editor]')!.dispatchEvent(clipboard('paste')));assert.equal(host.querySelectorAll('strong').length,2);assert.equal(host.querySelectorAll('strong')[1]!.textContent,'ell');
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('Enter after a heading continues as normal body text instead of an impossible multiline heading',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='# Heading';
 const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 try{
  await act(async()=>render());setVisualEditorSelection(ref.current!,value.length);await act(async()=>key(host,'Enter'));assert.equal(host.querySelectorAll('h1').length,1);assert.equal(host.querySelector('h1')!.textContent,'Heading');assert.equal(value,'# Heading\n');await act(async()=>ref.current!.dispatchEvent(new window.InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:'Next'})));assert.equal(host.querySelector('p')!.textContent,'Next');
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('source selections keep balanced mark and atom boundaries and collapsed carets remain collapsed',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);const table=emptyTableMarkup(''),value='Before **middle** after '+table+' tail';
 try{
  await act(async()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:()=>{}})));
  const start=value.indexOf('middle'),end=start+6;setVisualEditorSelection(ref.current!,start,end);let selection=getVisualEditorSelection(ref.current!);assert.equal(selection.offset,start);assert.equal(selection.end,end);
  const objectStart=value.indexOf(table),objectEnd=objectStart+table.length;setVisualEditorSelection(ref.current!,objectStart,objectEnd);selection=getVisualEditorSelection(ref.current!);assert.equal(selection.offset,objectStart);assert.equal(selection.end,objectEnd);
  for(const offset of [0,start,end,end+1,objectStart,objectStart+5,objectEnd,value.length]){setVisualEditorSelection(ref.current!,offset);selection=getVisualEditorSelection(ref.current!);assert.equal(selection.offset,selection.end,`collapsed at ${offset}`);}
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('an external update deferred during IME is reconciled after composition ends',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='Original',writes=0;
 const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:()=>{writes++;}}));
 try{
  await act(async()=>render());const editor=host.querySelector('[data-visual-editor]')!;setVisualEditorSelection(ref.current!,0,value.length);await act(async()=>editor.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true})));
  value='External update';await act(async()=>render());assert.equal(editor.textContent,'Original');
  await act(async()=>editor.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true})));assert.equal(editor.textContent,'External update');assert.equal(writes,0);
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('a stale deferred external value never overwrites newer IME input',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='Original';
 const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 try{
  await act(async()=>render());const editor=host.querySelector('[data-visual-editor]')!;setVisualEditorSelection(ref.current!,0,value.length);await act(async()=>editor.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true})));
  value='Stale external';await act(async()=>render());
  await act(async()=>{editor.querySelector('.rich-image-text')!.firstChild!.nodeValue='New IME input';editor.dispatchEvent(new window.InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'New IME input',isComposing:true}));});
  await act(async()=>editor.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true,data:'New IME input'})));assert.equal(value,'New IME input');assert.equal(editor.textContent,'New IME input');
 }finally{await act(async()=>root.unmount());host.remove();}
});
