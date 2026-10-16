import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CardBodyEditor} from '../src/webview/CardBodyEditor.tsx';
import {bodyTextHit} from '../src/webview/body-text-hit.ts';
import {readMarkdownEditor,setMarkdownEditorSelection} from '../src/webview/markdown-editor-model.ts';
import {readFileSync} from 'node:fs';

Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:text.length*8})};}}});
Object.defineProperties(window.Range.prototype,{getClientRects:{configurable:true,value:()=>[]},getBoundingClientRect:{configurable:true,value:()=>new window.DOMRect()}});

async function fixture(){
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);let requests=0,presses=0,setEditing!:(value:boolean)=>void;
 function Harness(){const [text,change]=useState('**Select** this text'),[editing,edit]=useState(false),editor=useRef<HTMLDivElement>(null);setEditing=edit;return createElement('div',{onPointerDown:()=>{presses++;}},createElement(CardBodyEditor,{id:'card',content:text,images:[],editing,editorRef:editor,onChange:change,onBlur:()=>{},onRequestEdit:()=>{requests++;edit(true);},flush:async()=>{},prepare:async()=>{},send:async()=>{}}));}
 await act(async()=>root.render(createElement(Harness)));
 return {host,get requests(){return requests;},get presses(){return presses;},edit:async(value:boolean)=>act(async()=>setEditing(value)),close:async()=>{await act(async()=>root.unmount());host.remove();}};
}

test('idle formatted text press leaves editing inactive and bubbles to the window mover',async()=>{
 const f=await fixture();try{
  const flow=f.host.querySelector('.rich-image-flow'),text=f.host.querySelector('strong')!,press=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1});
  await act(async()=>text.dispatchEvent(press));
  assert.equal(f.requests,0,'pressing text must wait for click-versus-drag classification');assert.equal(f.presses,1);assert.equal(press.defaultPrevented,true,'idle text must not start a native selection');
  assert.equal(f.host.querySelector<HTMLElement>('.card-body-editor')!.dataset.bodyEditing,'false');assert.equal(f.host.querySelector('[data-visual-editor]')!.getAttribute('contenteditable'),null);assert.ok(f.host.querySelector('.rich-image-flow')===flow);
  await f.edit(true);assert.equal(bodyTextHit(text),true);await act(async()=>text.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,buttons:1})));assert.equal(f.presses,1,'active text owns its native selection gesture');
 }finally{await f.close();}
});

test('idle source press and its native focus bubble without activating; actual keyboard input still activates',async()=>{
 const f=await fixture();try{
  await act(async()=>document.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());await f.edit(false);const source=f.host.querySelector<HTMLElement>('[data-markdown-editor]:not([data-visual-editor])')!,before=f.requests;
  const press=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,buttons:1});await act(async()=>source.dispatchEvent(press));await act(async()=>source.dispatchEvent(new window.FocusEvent('focusin',{bubbles:true})));
  assert.equal(f.requests,before,'a mouse press followed by browser focus must remain idle');assert.equal(f.presses,1);assert.equal(source.getAttribute('contenteditable'),'false');assert.equal(bodyTextHit(source),false);
  setMarkdownEditorSelection(source,readMarkdownEditor(source).length);await act(async()=>source.dispatchEvent(new KeyboardEvent('keydown',{key:'x',bubbles:true,cancelable:true})));
  assert.equal(f.requests,before+1);assert.equal(readMarkdownEditor(source),'**Select** this textx');assert.equal(bodyTextHit(source),true);
 }finally{await f.close();}
});

test('body text drag exclusion requires an active editable text surface and excludes objects',()=>{
 const host=document.createElement('div');host.innerHTML='<div class="card-body-editor" data-body-editing="false"><div data-markdown-editor data-visual-editor contenteditable="true"><p class="rich-text-paragraph"><span data-source-start="0">text</span></p><div class="image-placement"><span data-source-start="0">cell</span></div><button>tool</button></div></div>';document.body.append(host);
 try{const body=host.firstElementChild as HTMLElement,text=host.querySelector('[data-source-start]')!,editor=host.querySelector('[data-visual-editor]')!;assert.equal(bodyTextHit(text),false);body.dataset.bodyEditing='true';assert.equal(bodyTextHit(text),true);assert.equal(bodyTextHit(host.querySelector('.image-placement span')!),false);assert.equal(bodyTextHit(host.querySelector('button')!),false);editor.setAttribute('contenteditable','false');assert.equal(bodyTextHit(text),false);}finally{host.remove();}
});

test('input state changes selection and a palette-derived background without changing layout styling',()=>{
 const css=readFileSync(new URL('../src/webview/card-body-editor.css',import.meta.url),'utf8'),style=document.createElement('style');style.textContent=css;document.head.append(style);
 const host=document.createElement('div');host.innerHTML='<div class="preview card-body-editor" data-body-editing="false"><div data-markdown-editor class="visual-body-editor"><p>Text</p><div class="image-placement"><div contenteditable="true">Cell</div></div></div></div>';document.body.append(host);
 try{
  const body=host.firstElementChild as HTMLElement,editor=host.querySelector('[data-markdown-editor]') as HTMLElement,cell=host.querySelector('[contenteditable]') as HTMLElement;
  assert.equal(getComputedStyle(editor).userSelect,'none');const before=getComputedStyle(body);const shape=[before.padding,before.margin,before.borderWidth,before.width,before.height,before.fontSize,before.lineHeight];
  body.dataset.bodyEditing='true';editor.setAttribute('contenteditable','true');const after=getComputedStyle(body);assert.equal(getComputedStyle(editor).userSelect,'text');assert.equal(getComputedStyle(cell).userSelect,'text');assert.deepEqual([after.padding,after.margin,after.borderWidth,after.width,after.height,after.fontSize,after.lineHeight],shape);
  // JSDOM drops color-mix() with custom properties, so inspect that unsupported declaration directly.
  const stateRule=css.match(/\.card-body-editor\[data-body-editing="true"\]\s*\{([^}]+)\}/)?.[1];assert.ok(stateRule);const declarations=stateRule.split(';').map(value=>value.trim()).filter(Boolean);assert.equal(declarations.length,1,'the state cue must not add borders, padding or typography');assert.match(declarations[0]!,/^background-color:\s*color-mix\(in srgb,\s*var\(--palette-accent\)/);
 }finally{host.remove();style.remove();}
});

test('title input state uses a background-only palette cue and preserves its geometry',()=>{
 const css=readFileSync(new URL('../src/webview/workspace.css',import.meta.url),'utf8'),style=document.createElement('style');style.textContent=css;document.head.append(style);
 const host=document.createElement('div');host.id='root';host.innerHTML='<div class="proto-note"><div class="card"><div class="note-title-row"><input class="title" value="Title"></div></div></div>';document.body.append(host);
 try{
  const title=host.querySelector('input')!,card=host.querySelector('.card')!,before=getComputedStyle(title),shape=[before.padding,before.width,before.height,before.fontSize,before.lineHeight,before.borderWidth];card.classList.add('editing-mode','editing-title');const after=getComputedStyle(title);assert.deepEqual([after.padding,after.width,after.height,after.fontSize,after.lineHeight,after.borderWidth],shape);assert.ok(!after.boxShadow||after.boxShadow==='none','the title must not acquire an inset editing frame');
  const rule=css.match(/\.proto-note \.editing-title \.title\s*\{([^}]+)\}/)?.[1];assert.ok(rule);const declarations=rule.split(';').map(value=>value.trim()).filter(Boolean);assert.equal(declarations.length,1);assert.match(declarations[0]!,/^background(?:-color)?:\s*color-mix\(in srgb,\s*var\(--palette-accent\)/);
 }finally{host.remove();style.remove();}
});
