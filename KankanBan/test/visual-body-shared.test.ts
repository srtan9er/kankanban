import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement,createRef} from 'react';
import {createRoot} from 'react-dom/client';
import {VisualBodyEditor,getVisualEditorSelection,setVisualEditorSelection} from '../src/webview/VisualBodyEditor.tsx';
import {Markdown} from '../src/webview/Markdown.tsx';
import {emptyTableMarkup} from '../src/core/table-markdown.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
const nativeStyle=getComputedStyle,bodyStyle=document.createElement('div').style;bodyStyle.fontSize='13px';bodyStyle.lineHeight='20.8px';bodyStyle.fontFamily='sans-serif';Object.assign(globalThis,{getComputedStyle:(element:Element)=>element.closest('.rich-image-body')?bodyStyle:nativeStyle(element)});
const input=(host:Element,text:string,inputType='insertText')=>host.dispatchEvent(new window.InputEvent('beforeinput',{bubbles:true,cancelable:true,data:text,inputType}));
test('reading and editing keep the exact shared Markdown flow DOM and do not write on mode changes',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);const value='# Heading\n\nA **bold** paragraph.\n\n'+emptyTableMarkup('');let active=false,writes=0;
 const render=()=>root.render(createElement('div',{},createElement('section',{className:'baseline'},createElement(Markdown,{text:value})),createElement(VisualBodyEditor,{ref,value,active,onChange:()=>{writes++;}})));
 try{await act(async()=>render());const flow=host.querySelector('[data-visual-editor] .rich-image-flow');assert.ok(flow,'the editor must render the existing shared Markdown flow');assert.equal(flow.outerHTML,host.querySelector('.baseline .rich-image-flow')!.outerHTML);active=true;await act(async()=>render());assert.equal(host.querySelector('[data-visual-editor] .rich-image-flow'),flow);assert.equal(writes,0);}finally{await act(async()=>root.unmount());host.remove();}
});
test('typing Markdown directly formats the same body and keeps the logical caret after hidden closing markers',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='';const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 try{await act(async()=>render());setVisualEditorSelection(ref.current!,0);for(const char of '**bold**')await act(async()=>input(ref.current!,char));assert.equal(value,'**bold**');assert.equal(host.querySelector('strong')?.textContent,'bold');assert.equal(getVisualEditorSelection(ref.current!).offset,value.length);await act(async()=>input(ref.current!,' tail'));assert.equal(value,'**bold** tail');assert.equal(host.querySelector('strong')?.textContent,'bold');}finally{await act(async()=>root.unmount());host.remove();}
});
test('typed block syntax, italic, strike, script and code remain canonical Markdown rather than escaped literals',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='';const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 const source='# Heading\n\n*italic* ~~gone~~ x^2^ H_2_O `code`\n\n- [ ] Task\n\n> Quote\n\n---\n\n```ts\nlet x = 1\n```';
 try{await act(async()=>render());setVisualEditorSelection(ref.current!,0);for(const char of source)await act(async()=>input(ref.current!,char,char==='\n'?'insertParagraph':'insertText'));assert.equal(value,source);for(const selector of ['h1','em','del','sup','sub','code','input[type=checkbox]','blockquote','hr','pre'])assert.ok(host.querySelector(selector),selector);}finally{await act(async()=>root.unmount());host.remove();}
});
test('native drag selections across formatted spans remain selectable and can be bolded directly',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='Text **bold** tail';const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 try{await act(async()=>render());const first=host.querySelector('[data-source-start="0"]')!.firstChild!,bold=host.querySelector('strong')!.firstChild!;document.getSelection()!.setBaseAndExtent(first,1,bold,2);const selection=getVisualEditorSelection(ref.current!);assert.equal(selection.offset,1);assert.equal(selection.end,9);await act(async()=>ref.current!.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true,cancelable:true})));assert.ok([...host.querySelectorAll('strong')].some(node=>node.textContent?.includes('ext')));assert.ok(host.textContent?.includes('Text bold tail'));}finally{await act(async()=>root.unmount());host.remove();}
});
test('collapsed Ctrl+B formats subsequent typing and toggling off continues outside its closing marker',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='';const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 const bold=()=>ref.current!.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true,cancelable:true}));
 try{await act(async()=>render());setVisualEditorSelection(ref.current!,0);await act(async()=>bold());await act(async()=>input(ref.current!,'H'));await act(async()=>input(ref.current!,'i'));assert.equal(value,'**Hi**');await act(async()=>bold());await act(async()=>input(ref.current!,' tail'));assert.equal(value,'**Hi** tail');assert.equal(host.querySelector('strong')?.textContent,'Hi');}finally{await act(async()=>root.unmount());host.remove();}
});
test('table cell source maps never become body source coordinates or receive body shortcuts',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);const value='Before\n\n'+emptyTableMarkup('').replace('<cell row="0" col="0" rowspan="1" colspan="1"></cell>','<cell row="0" col="0" rowspan="1" colspan="1">Cell text</cell>');let writes=0;
 try{await act(async()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:()=>{writes++;}})));setVisualEditorSelection(ref.current!,2);const local=host.querySelector('.image-placement [data-source-start]');assert.ok(local);const walker=document.createTreeWalker(local,4),text=walker.nextNode()!;document.getSelection()!.setBaseAndExtent(text,1,text,3);assert.equal(getVisualEditorSelection(ref.current!).offset,2);await act(async()=>local.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true,cancelable:true})));assert.equal(writes,0);}finally{await act(async()=>root.unmount());host.remove();}
});
test('semantic deletion skips hidden marks, preserves partial formatting and removes an emptied wrapper',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='**bold**';const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 const key=(key:string)=>ref.current!.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
 try{await act(async()=>render());setVisualEditorSelection(ref.current!,value.length);await act(async()=>key('Backspace'));assert.equal(value,'**bol**');assert.equal(host.querySelector('strong')?.textContent,'bol');setVisualEditorSelection(ref.current!,2);await act(async()=>key('Backspace'));assert.equal(value,'**bol**');await act(async()=>key('Delete'));assert.equal(value,'**ol**');setVisualEditorSelection(ref.current!,2,4);await act(async()=>key('Delete'));assert.equal(value,'');assert.equal(host.querySelector('hr'),null);}finally{await act(async()=>root.unmount());host.remove();}
});
test('deleting grapheme emoji, literal unfinished syntax and an adjacent table preserves their boundaries',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);const table=emptyTableMarkup('');let value='**👩🏽‍💻** tail '+table;const render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));const back=()=>ref.current!.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));
 try{await act(async()=>render());setVisualEditorSelection(ref.current!,value.indexOf(' tail'));await act(async()=>back());assert.equal(value,' tail '+table);setVisualEditorSelection(ref.current!,value.length);await act(async()=>back());assert.equal(value,' tail ');value='**unfinished';await act(async()=>render());setVisualEditorSelection(ref.current!,value.length);await act(async()=>back());assert.equal(value,'**unfinishe');}finally{await act(async()=>root.unmount());host.remove();}
});
test('cutting a whole marked phrase preserves clipboard formatting and leaves no empty delimiter or rule',async()=>{
 const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLDivElement>();document.body.append(host);let value='**one**';const data=new Map<string,string>(),render=()=>root.render(createElement(VisualBodyEditor,{ref,value,onChange:next=>{value=next;render();}}));
 try{await act(async()=>render());setVisualEditorSelection(ref.current!,2,5);const event=new Event('cut',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{setData:(type:string,text:string)=>data.set(type,text)}});await act(async()=>ref.current!.dispatchEvent(event));assert.equal(data.get('text/plain'),'**one**');assert.equal(value,'');assert.equal(host.querySelector('hr'),null);}finally{await act(async()=>root.unmount());host.remove();}
});
