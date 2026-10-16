import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'postcss';
import {act,createElement,createRef} from 'react';
import {createRoot} from 'react-dom/client';
import {CardBodyEditor} from '../src/webview/CardBodyEditor.tsx';
import {emptyTableMarkup} from '../src/core/table-markdown.ts';
import {readTextMetrics} from '../src/themes/metrics.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(s:string)=>({width:s.length*8})};}},requestAnimationFrame:(f:(t:number)=>void)=>setTimeout(()=>f(0),0),cancelAnimationFrame:clearTimeout});

const cardCss=readFileSync(new URL('../src/webview/card-body-editor.css',import.meta.url),'utf8'),defaultsCss=readFileSync(new URL('../src/themes/defaults.css',import.meta.url),'utf8');
function declarations(css:string,selector:string){const result:Record<string,string>={};parse(css).walkRules(rule=>{if(rule.selectors.includes(selector))rule.walkDecls(declaration=>{result[declaration.prop]=declaration.value;});});return result;}
function themeStyle(){const style=document.createElement('style');style.textContent=defaultsCss+'\n'+cardCss+'\n#root .rich-image-body{--md-inset-x:31px;--md-inset-top:17px;--md-inset-bottom:37px;}';document.head.append(style);return style;}
function computedText(element:Element){const style=getComputedStyle(element);return {fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,color:style.color,margin:style.margin,padding:style.padding};}

test('shared rendered content has no second visual typography or inset system',()=>{
 parse(cardCss).walkRules(rule=>{
  if(!/visual/.test(rule.selector))return;
  rule.walkDecls(declaration=>assert.ok(!/^(?:font(?:-|$)|line-height$|color$|margin(?:-|$)|--md-)/.test(declaration.prop),`visual state must reuse renderer/theme metrics: ${rule.selector} ${declaration.prop}`));
 });
 assert.doesNotMatch(cardCss,/visual-body-content|ProseMirror|visual-body-object/);
 const host=declarations(cardCss,'.card-body-editor .body-visual-surface');assert.equal(host.padding,'0');assert.equal(host.background,'transparent');assert.equal(host.overflow,'visible');
 const source=declarations(cardCss,'.card-body-editor .markdown-editor.content');assert.equal(source.overflow,'visible');assert.equal(source['min-height'],'100%');
 assert.equal(declarations(defaultsCss,'.rich-image-flow > .rich-text-inset')['margin-inline'],'var(--md-inset-x)');
 assert.equal(declarations(defaultsCss,'.rich-image-flow > .rich-text-inset:first-child')['margin-top'],'var(--md-inset-top,var(--md-inset-y))');
 assert.equal(declarations(defaultsCss,'.rich-image-flow > .rich-text-inset:last-child')['margin-bottom'],'var(--md-inset-bottom,var(--md-inset-y))');
});

test('the same themed Markdown nodes survive inactive to active to inactive without typography or inset changes',async()=>{
 const host=document.createElement('div'),root=createRoot(host),editorRef=createRef<HTMLDivElement>(),style=themeStyle();host.id='root';document.body.append(host);let editing=false,writes=0;
 const render=()=>root.render(createElement(CardBodyEditor,{id:'card',content:'# Heading\n\nA **bold** line.',images:[],editing,editorRef,onChange:()=>{writes++;},onBlur:()=>{},onRequestEdit:()=>{},flush:async()=>{},prepare:async()=>{},send:async()=>{}}));
 try{
  await act(async()=>render());const visual=host.querySelector('[data-visual-editor]')!,body=visual.querySelector<HTMLElement>('.kkb-markdown.rich-image-body')!,heading=body.querySelector('h1')!,paragraph=body.querySelector('[data-md-kind="p"]')!,inset=body.querySelector('.rich-image-flow > .rich-text-inset');
  assert.ok(body,'ordinary viewing uses the shared renderer');assert.ok(inset,'ordinary text keeps the existing theme inset structure');assert.equal(visual.classList.contains('content'),false);assert.equal(host.querySelector('.ProseMirror'),null);
  const before={body:computedText(body),heading:computedText(heading),paragraph:computedText(paragraph),style:body.getAttribute('style')},metric=readTextMetrics(body);assert.equal(metric.insetX,31);assert.equal(metric.insetY,17);assert.equal(metric.insetBottom,37);
  for(const active of [true,false]){editing=active;await act(async()=>render());assert.ok(host.querySelector('[data-visual-editor]')===visual);assert.ok(visual.querySelector('.rich-image-body')===body);assert.ok(body.querySelector('h1')===heading);assert.ok(body.querySelector('[data-md-kind="p"]')===paragraph);assert.deepEqual({body:computedText(body),heading:computedText(heading),paragraph:computedText(paragraph),style:body.getAttribute('style')},before);const next=readTextMetrics(body);assert.equal(next.insetX,metric.insetX);assert.equal(next.insetY,metric.insetY);assert.equal(next.insetBottom,metric.insetBottom);}
  assert.equal(writes,0);
 }finally{await act(async()=>root.unmount());host.remove();style.remove();}
});

test('shared floating image and table frames keep their saved coordinates through visual activation',async()=>{
 const image=`<image src="../assets/images/${'a'.repeat(64)}.png" layout="overlay" name="image_0" x="77" y="63" width="80" height="40">Picture</image>`,table=emptyTableMarkup('').replace('layout="inline"','layout="float" x="180" y="140"');
 const host=document.createElement('div'),root=createRoot(host),editorRef=createRef<HTMLDivElement>(),style=themeStyle();host.id='root';document.body.append(host);let editing=false;
 const render=()=>root.render(createElement(CardBodyEditor,{id:'card',content:'Text\n\n'+image+'\n\n'+table,images:[],editing,editorRef,onChange:()=>{throw new Error('activation cannot rewrite coordinates');},onBlur:()=>{},onRequestEdit:()=>{},flush:async()=>{},prepare:async()=>{},send:async()=>{}}));
 try{
  await act(async()=>render());const body=host.querySelector('.kkb-markdown.rich-image-body')!,frames=[...body.querySelectorAll<HTMLElement>('.image-placement')];assert.equal(frames.length,2);
  const snapshot=()=>frames.map(frame=>({name:frame.dataset.objectName,left:frame.style.left,top:frame.style.top,width:frame.style.width,height:frame.style.height,transform:frame.style.transform})),before=snapshot();assert.ok(before.some(frame=>frame.name==='image_0' && frame.left==='77px' && frame.top==='63px'));assert.ok(before.some(frame=>frame.name==='table_0' && frame.left==='180px' && frame.top==='140px'));
  for(const active of [true,false]){editing=active;await act(async()=>render());assert.ok(host.querySelector('.kkb-markdown.rich-image-body')===body);for(const frame of frames)assert.ok(body.contains(frame));assert.deepEqual(snapshot(),before);}
 }finally{await act(async()=>root.unmount());host.remove();style.remove();}
});

test('Markdown source keeps its existing content styling when selected from shared viewing',async()=>{
 const host=document.createElement('div'),root=createRoot(host),editorRef=createRef<HTMLDivElement>();host.id='root';document.body.append(host);
 try{
  await act(async()=>root.render(createElement(CardBodyEditor,{id:'card',content:'# Heading\n\nText',images:[],editing:true,editorRef,onChange:()=>{},onBlur:()=>{},onRequestEdit:()=>{},flush:async()=>{},prepare:async()=>{},send:async()=>{}})));
  await act(async()=>host.querySelector<HTMLButtonElement>('.body-mode-toggle')!.click());const source=host.querySelector('[data-markdown-editor]:not([data-visual-editor])')!;assert.ok(source.classList.contains('content'));
 }finally{await act(async()=>root.unmount());host.remove();}
});
