import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {readTextMetrics} from '../src/themes/metrics.ts';
import {Markdown} from '../src/webview/Markdown.tsx';

Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:[...text].length*8})};}}});

function styled(css:string,run:(host:HTMLElement)=>void){
 const style=document.createElement('style');style.textContent=css;document.head.append(style);
 const host=document.createElement('div');host.className='metric-specimen';document.body.append(host);
 try{run(host);}finally{host.remove();style.remove();}
}

test('paragraph flow spacing includes the theme top and bottom borders',()=>styled('.metric-specimen p{font:20px serif;line-height:30px;margin:5px 0 7px;padding:3px 6px 4px;border-top:2px solid;border-bottom:3px solid}',host=>{
 const metric=readTextMetrics(host).paragraphs.p!;
 assert.equal(metric.before,10);assert.equal(metric.after,14);
}));

test('measurement probes match the semantic selectors used by rendered paragraphs',()=>styled('.metric-specimen [data-md-kind=p]{font-size:21px;line-height:34px;letter-spacing:.3px;margin:9px 0}',host=>{
 const metric=readTextMetrics(host).paragraphs.p!;
 assert.equal(metric.size,21);assert.equal(metric.lineHeight,34);assert.equal(metric.letterSpacing,.3);assert.equal(metric.before,9);
}));

test('task and list metrics preserve their paragraph context and own spacing',()=>styled('.metric-specimen p{margin:16px 0}.metric-specimen .md-task{margin:8px 0}.metric-specimen .md-list{margin:4px 0}',host=>{
 const metrics=readTextMetrics(host).paragraphs;
 assert.equal(metrics.task?.before,8);assert.equal(metrics.list?.before,4);assert.equal(metrics.p?.before,16);
}));

test('inline code measures its actual font size, spacing and horizontal box',()=>styled('.metric-specimen p{font:20px serif;line-height:30px}.metric-specimen code{font:400 18px monospace;letter-spacing:.5px;padding:1px 6px;border:1px solid}',host=>{
 const metric=readTextMetrics(host).paragraphs.p!;
 assert.deepEqual(metric.code,{size:18,family:'monospace',weight:'400',letterSpacing:.5,left:7,right:7});
}));

test('task flow reserves the styled checkbox border box and its margins',()=>styled('.metric-specimen .markdown-task-check{box-sizing:border-box;width:24px;height:24px;border:2px solid;padding:0;margin:0 6px 0 2px}',host=>{
 assert.equal(readTextMetrics(host).taskWidth,32);
}));

test('independent top and bottom text insets retain the symmetric legacy fallback',()=>styled('',host=>{
 host.style.setProperty('--md-inset-y','24px');
 let metrics=readTextMetrics(host);assert.equal(metrics.insetY,24);assert.equal(metrics.insetBottom,24);
 host.style.setProperty('--md-inset-top','48px');host.style.setProperty('--md-inset-bottom','96px');
 metrics=readTextMetrics(host);assert.equal(metrics.insetY,48);assert.equal(metrics.insetBottom,96);
}));

test('free image flow renders with the same heading and code fonts that it measures',async()=>{
 const style=document.createElement('style');style.textContent='.rich-image-body{font-family:serif}.rich-image-body h1{font-family:monospace;font-size:30px;line-height:40px;font-weight:700}.rich-image-body p{font:20px serif;line-height:30px}.rich-image-body code{font:400 18px monospace;letter-spacing:.5px;padding:1px 6px;border:1px solid}';document.head.append(style);
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 const assetId='a'.repeat(64)+'.png',image={id:'theme-image',assetId,name:'test',mime:'image/png' as const,width:80,height:40};
 try{
  await act(async()=>root.render(createElement(Markdown,{text:'# Heading\n`code` after\n<image src="../assets/images/'+assetId+'" layout="float" width="80" height="40" x="150" y="0">test</image>',images:[image]})));
  const heading=host.querySelector<HTMLElement>('h1.rich-flow-paragraph')!;
  assert.equal(heading.style.fontFamily,'monospace');assert.equal(heading.style.fontWeight,'700');
  const code=host.querySelector<HTMLElement>('code')!;
  assert.equal(code.style.fontSize,'18px');assert.equal(code.style.letterSpacing,'0.5px');
 }finally{await act(async()=>root.unmount());host.remove();style.remove();}
});

test('inline code chrome is reserved once per wrapped fragment and long code keeps all source text',async()=>{
 const width=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'clientWidth');Object.defineProperty(HTMLElement.prototype,'clientWidth',{configurable:true,get(){return this.classList.contains('rich-image-body')?120:0;}});
 const style=document.createElement('style');style.textContent='.rich-image-body p{font:20px serif;line-height:30px}.rich-image-body code{font:400 18px monospace;letter-spacing:0;padding:1px 6px;border:1px solid}';document.head.append(style);
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 const assetId='b'.repeat(64)+'.png',image={id:'chrome-image',assetId,name:'test',mime:'image/png' as const,width:80,height:40};
 const picture='<image src="../assets/images/'+assetId+'" layout="float" width="80" height="40" x="150" y="0">test</image>';
 try{
  await act(async()=>root.render(createElement(Markdown,{text:'`code` after\n'+picture,images:[image]})));
  assert.equal(host.querySelectorAll('[data-md-kind=p] .rich-flow-line').length,2,'14px code padding and borders move the following word to a new line');
  const long='abcdefghijklmnopqrstuvwx';await act(async()=>root.render(createElement(Markdown,{text:'`'+long+'` after\n'+picture,images:[image]})));
  const codes=[...host.querySelectorAll('code')];assert.ok(codes.length>1);assert.equal(codes.map(node=>node.textContent).join(''),long);
  assert.ok([...host.querySelectorAll<HTMLElement>('.rich-flow-line')].every(line=>line.textContent!.length<=9),'each fragment leaves its own 14px chrome instead of charging every character');
 }finally{await act(async()=>root.unmount());host.remove();style.remove();if(width)Object.defineProperty(HTMLElement.prototype,'clientWidth',width);else delete (HTMLElement.prototype as {clientWidth?:number}).clientWidth;}
});
