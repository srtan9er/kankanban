import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {Markdown} from '../src/webview/Markdown.tsx';
import {EditMode} from '../src/webview/edit-mode.ts';
import {ImageGallery} from '../src/webview/ImageGallery.tsx';
import type {Request} from '../src/webview/controller.ts';
import {parseCardImages} from '../src/core/image-markdown.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:(time:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id),OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:[...text].length*10})};}}});
const assetId='a'.repeat(64)+'.png',image={id:'image',assetId,name:'reference',mime:'image/png' as const,width:160,height:80};
const body=`above\n![explanation](../assets/images/${assetId})\nbelow`;
test('browse mode renders the picture but cannot select, drag, resize or delete it',async()=>{
 const host=document.createElement('div'),root=createRoot(host),requests:Request[]=[];document.body.append(host);
 try{
  await act(async()=>root.render(createElement(EditMode.Provider,{value:{editable:false,busy:false}},createElement(Markdown,{text:body,images:[image],id:'card',send:async request=>{requests.push(request);}}))));
  const frame=host.querySelector('.image-placement')!;assert.equal(frame.querySelector('[role="img"]')!.getAttribute('aria-label'),'explanation');
  await act(async()=>{click(frame);pointer(frame,'pointerdown',20,20);pointer(document,'pointermove',50,50);pointer(document,'pointerup',50,50);});
  assert.notEqual(frame.getAttribute('data-selected'),'true');assert.equal(host.querySelector('.image-resize-grip,.image-remove,.image-layout-toolbar'),null);assert.equal(requests.length,0);
 }finally{await act(async()=>root.unmount());host.remove();}
});
function pointer(target:EventTarget,type:string,x:number,y:number,shiftKey=false){const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y,shiftKey});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);}
function click(target:Element){target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1,button:0}));}
async function fixture(run:(host:HTMLDivElement,requests:Request[])=>Promise<void>,text=body,prepare?:()=>Promise<unknown>){const host=document.createElement('div'),requests:Request[]=[],root=createRoot(host);document.body.append(host);try{await act(async()=>root.render(createElement('div',{className:'preview'},createElement(Markdown,{text,images:[image],id:'card',send:async request=>{requests.push(request);},...(prepare?{prepare}:{})}))));await run(host,requests);}finally{await act(async()=>root.unmount());host.remove();}}
const enter=async(host:HTMLElement)=>{await act(async()=>click(host.querySelector('.image-placement')!));};
test('one picture click enters editing without writes, and four modes are each one click',()=>fixture(async(host,requests)=>{
 const frame=host.querySelector('.image-placement')!;assert.equal(frame.querySelector('button'),null);assert.equal(host.querySelector('.image-layout-toolbar'),null);assert.equal(host.querySelector('figcaption,select,.image-source-editor'),null);
 await enter(host);assert.equal(requests.length,0);assert.equal(frame.getAttribute('data-selected'),'true');assert.equal(host.querySelectorAll('[data-layout-mode]').length,4);const controls=host.querySelector('[data-floating-object-tools]')!;assert.ok(host.querySelector('.image-edit-controls .image-remove'));assert.equal(controls.querySelector('.image-remove'),null);assert.ok(host.querySelector('.image-edit-controls [role="separator"]'));assert.equal(controls.querySelector('[role="separator"]'),null);assert.ok(controls.contains(host.querySelector('.image-layout-toolbar')));assert.ok(!frame.contains(controls));
 await act(async()=>host.querySelector<HTMLButtonElement>('[data-layout-mode="overlay"]')!.click());assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit' && requests[0].before===body && requests[0].value.includes('layout="overlay"'));assert.equal(host.querySelector('.image-layout-select'),null);
 await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(host.querySelector('.image-layout-toolbar'),null);
}));
test('selected flow picture stays in place, previews only an insertion line, and reorders once on drop',()=>fixture(async(host,requests)=>{
 await enter(host);const frame=host.querySelector('.image-placement')!;
 const text=host.textContent,target=[...host.querySelectorAll('[data-source-start]')].find(span=>span.textContent==='below')!,old=(document as any).caretPositionFromPoint;
 (document as any).caretPositionFromPoint=()=>({offsetNode:target.firstChild,offset:2});
 try{await act(async()=>pointer(frame,'pointerdown',10,20));await act(async()=>pointer(window,'pointermove',50,70));assert.equal(requests.length,0);assert.equal(host.querySelector<HTMLElement>('.image-placement')!.style.left,'');assert.equal(frame.getAttribute('data-layout'),'inline');assert.equal(host.textContent,text);assert.equal(host.querySelector<HTMLSpanElement>('.flow-image-caret')!.hidden,false);
 await act(async()=>pointer(window,'pointerup',60,80));assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit');assert.equal(requests[0].value,`above\n\nbe![explanation](../assets/images/${assetId})low`);assert.equal(requests[0].before,body);assert.equal(host.querySelector<HTMLSpanElement>('.flow-image-caret')!.hidden,true);
 await act(async()=>pointer(window,'pointerup',270,190));assert.equal(requests.length,1);
 }finally{if(old)(document as any).caretPositionFromPoint=old;else delete(document as any).caretPositionFromPoint;}
}));
test('first picture press enters editing and the same gesture can move its flow token',()=>fixture(async(host,requests)=>{
 const frame=host.querySelector('.image-placement')!,target=[...host.querySelectorAll('[data-source-start]')].find(span=>span.textContent==='below')!,old=(document as any).caretPositionFromPoint;
 assert.equal(frame.getAttribute('data-selected'),'false');(document as any).caretPositionFromPoint=()=>({offsetNode:target.firstChild,offset:2});
 try{await act(async()=>pointer(frame,'pointerdown',10,20));assert.equal(frame.getAttribute('data-selected'),'true');await act(async()=>pointer(window,'pointermove',50,70));assert.equal(requests.length,0);assert.equal(frame.getAttribute('data-layout'),'inline');assert.equal(host.querySelector<HTMLSpanElement>('.flow-image-caret')!.hidden,false);await act(async()=>{pointer(window,'pointerup',50,70);click(frame);});assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit');assert.equal(requests[0].value,`above\n\nbe![explanation](../assets/images/${assetId})low`);assert.equal(frame.getAttribute('data-selected'),'true');}finally{if(old)(document as any).caretPositionFromPoint=old;else delete(document as any).caretPositionFromPoint;}
}));
test('first simple picture click stays in editing and the next simple click exits',()=>fixture(async(host,requests)=>{
 const frame=host.querySelector('.image-placement')!;
 await act(async()=>{pointer(frame,'pointerdown',10,20);pointer(window,'pointerup',10,20);click(frame);});assert.equal(frame.getAttribute('data-selected'),'true');assert.equal(requests.length,0);
 await act(async()=>{pointer(frame,'pointerdown',10,20);pointer(window,'pointerup',10,20);click(frame);});assert.equal(frame.getAttribute('data-selected'),'false');assert.equal(requests.length,0);
}));
test('free picture dragging still previews its actual position and writes once',()=>fixture(async(host,requests)=>{
 await enter(host);const frame=host.querySelector('.image-placement')!;
 await act(async()=>pointer(frame,'pointerdown',10,20));await act(async()=>pointer(window,'pointermove',50,70));assert.equal(requests.length,0);assert.equal(host.querySelector<HTMLElement>('.image-placement')!.style.left,'40px');
 await act(async()=>pointer(window,'pointerup',60,80));assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit' && requests[0].value.includes('x="50"') && requests[0].value.includes('y="60"'));
 await act(async()=>pointer(window,'pointerup',270,190));assert.equal(requests.length,1);
},`above\n<image src="../assets/images/${assetId}" layout="float" width="160" height="80" x="0" y="0">explanation</image>\nbelow`));
test('flow drop maps Pretext fragments into original CJK and emoji source beside free images',()=>{
 const inline=`<image src="../assets/images/${assetId}" layout="inline" width="80" height="40">explanation</image>`,free=`<image src="../assets/images/${assetId}" layout="float" width="80" height="40" x="100" y="0">free</image>`,text=inline+'\n甲   乙😀丙尾巴\n'+free;
 return fixture(async(host,requests)=>{await enter(host);const target=[...host.querySelectorAll('[data-source-map]')].find(span=>span.textContent?.includes('😀'))!;assert.ok(target);const old=(document as any).caretPositionFromPoint;(document as any).caretPositionFromPoint=()=>({offsetNode:target.firstChild,offset:target.textContent!.indexOf('😀')+2});
 try{const frame=host.querySelector('.image-placement')!;await act(async()=>{pointer(frame,'pointerdown',10,20);pointer(window,'pointermove',60,100);});assert.equal(requests.length,0);assert.equal(frame.getAttribute('data-layout'),'inline');await act(async()=>pointer(window,'pointerup',60,100));assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit');assert.equal(requests[0].value,'\n甲   乙😀'+inline+'丙尾巴\n'+free);}finally{if(old)(document as any).caretPositionFromPoint=old;else delete(document as any).caretPositionFromPoint;}
 },text);
});
test('failed draft preparation cancels a flow drop without saving or moving local layout',()=>fixture(async(host,requests)=>{
 await enter(host);const frame=host.querySelector('.image-placement')!,target=[...host.querySelectorAll('[data-source-start]')].find(span=>span.textContent==='below')!,old=(document as any).caretPositionFromPoint;(document as any).caretPositionFromPoint=()=>({offsetNode:target.firstChild,offset:2});
 try{await act(async()=>{pointer(frame,'pointerdown',10,20);pointer(window,'pointermove',50,70);pointer(window,'pointerup',50,70);});assert.equal(requests.length,0);assert.equal(frame.getAttribute('data-layout'),'inline');assert.equal(host.querySelector<HTMLSpanElement>('.flow-image-caret')!.hidden,true);assert.ok(host.textContent!.includes('draft save failed'));}finally{if(old)(document as any).caretPositionFromPoint=old;else delete(document as any).caretPositionFromPoint;}
},body,async()=>{throw new Error('draft save failed');}));
for(const place of ['image','body'] as const)test(`a click on ${place} only exits and consumes that click, preserving the next click`,()=>fixture(async(host,requests)=>{
 await enter(host);let underlying=0;const external=document.createElement('button');document.body.append(external);external.addEventListener('click',()=>underlying++);const target=place==='image'?host.querySelector('.image-placement')!:host.querySelector('.rich-text-paragraph')!;
 const count=()=>underlying++;target.addEventListener('click',count);
 try{await act(async()=>{pointer(target,'pointerdown',10,20);pointer(window,'pointerup',10,20);click(target);});assert.equal(host.querySelector('.image-layout-toolbar'),null);assert.equal(requests.length,0);assert.equal(underlying,0);
 await act(async()=>{pointer(external,'pointerdown',50,20);pointer(window,'pointerup',50,20);click(external);});assert.equal(underlying,1);
 }finally{external.remove();}
}));
test('body dragging and outside controls retain their original behavior without moving the image',()=>fixture(async(host,requests)=>{
 await enter(host);const text=host.querySelector('.rich-text-paragraph')!;let presses=0,clicks=0;const record=()=>presses++;window.addEventListener('pointerdown',record);
 const external=document.createElement('button');external.addEventListener('click',()=>clicks++);document.body.append(external);
 try{await act(async()=>{pointer(text,'pointerdown',50,20);pointer(window,'pointermove',80,60);pointer(window,'pointerup',80,60);click(text);});assert.equal(presses,1);assert.equal(requests.length,0);
 await act(async()=>{pointer(external,'pointerdown',50,20);pointer(window,'pointerup',50,20);click(external);});assert.equal(clicks,1);assert.equal(host.querySelector('.image-layout-toolbar'),null);
 }finally{window.removeEventListener('pointerdown',record);external.remove();}
}));
test('subthreshold clicks exit without converting flow; cancel and Escape never write',()=>fixture(async(host,requests)=>{
 await enter(host);let frame=host.querySelector('.image-placement')!;await act(async()=>{pointer(frame,'pointerdown',10,20);pointer(window,'pointermove',12,22);pointer(window,'pointerup',12,22);click(frame);});assert.equal(requests.length,0);assert.equal(frame.getAttribute('data-layout'),'inline');assert.equal(host.querySelector('.image-layout-toolbar'),null);
 await enter(host);frame=host.querySelector('.image-placement')!;await act(async()=>{pointer(frame,'pointerdown',10,20);pointer(window,'pointermove',30,40);pointer(window,'pointercancel',30,40);});assert.equal(requests.length,0);assert.equal(host.querySelector('.image-placement')!.getAttribute('data-layout'),'inline');assert.equal(host.querySelector<HTMLSpanElement>('.flow-image-caret')!.hidden,true);
 await act(async()=>{pointer(frame,'pointerdown',10,20);pointer(window,'pointermove',30,40);document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));pointer(window,'pointerup',30,40);});assert.equal(requests.length,0);assert.equal(host.querySelector('.image-layout-toolbar'),null);
}));
test('selected gray separator resizes dimensions once; rejected prepare retains original body',()=>{
 let preparations=0;return fixture(async(host,requests)=>{await enter(host);const grip=host.querySelector('[role="separator"]')!;assert.notEqual(grip.tagName,'BUTTON');await act(async()=>{pointer(grip,'pointerdown',160,80);pointer(window,'pointermove',190,150);});assert.equal(requests.length,0);await act(async()=>pointer(window,'pointerup',190,150));assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit' && requests[0].value.includes('width="190"') && requests[0].value.includes('height="150"'));await act(async()=>host.querySelector<HTMLButtonElement>('[data-layout-mode="overlay"]')!.click());assert.equal(requests.length,1);assert.ok(host.textContent!.includes('draft save failed'));},`<image src="../assets/images/${assetId}" layout="inline" width="160" height="80">explanation</image>`,async()=>{if(++preparations===2)throw new Error('draft save failed');});
});
for(const layout of ['inline','underlay'] as const)test(`Shift locks the original asset ratio rather than its resized display box (${layout})`,()=>fixture(async(host,requests)=>{
 await enter(host);const frame=host.querySelector<HTMLElement>('.image-placement')!,grip=host.querySelector('.image-resize-grip')!;
 const size=()=>({width:parseFloat(frame.style.width),height:parseFloat(frame.style.getPropertyValue('--image-height'))});
 await act(async()=>{pointer(grip,'pointerdown',200,80);pointer(window,'pointermove',230,150);});assert.deepEqual(size(),{width:230,height:150});assert.equal(requests.length,0);assert.ok(host.querySelector('.rich-image-body.image-resizing'));
 await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true,shiftKey:true})));let current=size();assert.ok(Math.abs(current.width/current.height-2)<1e-9);assert.equal(requests.length,0);
 await act(async()=>window.dispatchEvent(new KeyboardEvent('keyup',{key:'Shift',bubbles:true})));assert.deepEqual(size(),{width:230,height:150});
 await act(async()=>pointer(window,'pointermove',210,170,true));current=size();assert.ok(Math.abs(current.width/current.height-2)<1e-9);assert.equal(requests.length,0);
 if(layout==='underlay'){const controls=host.querySelector<HTMLElement>('.image-edit-controls')!;assert.equal(parseFloat(controls.style.width),current.width);assert.equal(parseFloat(controls.style.height),current.height);assert.equal(frame.style.zIndex,'0');}
 await act(async()=>pointer(window,'pointerup',210,170,true));assert.equal(requests.length,1);assert.equal(host.querySelector('.rich-image-body.image-resizing'),null);assert.ok(requests[0]!.kind==='edit');const saved=parseCardImages(requests[0].value)[0]!;assert.equal(saved.layout,layout);assert.ok(Math.abs(saved.width!/saved.height!-2)<1e-9);
},`<image src="../assets/images/${assetId}" layout="${layout}" width="200" height="80"${layout==='underlay'?' x="40" y="30"':''}>explanation</image>`));
test('Shift ratio resize clamps both dimensions to valid bounds and saves once',()=>fixture(async(host,requests)=>{
 await enter(host);const frame=host.querySelector<HTMLElement>('.image-placement')!,grip=host.querySelector('.image-resize-grip')!;
 await act(async()=>{pointer(grip,'pointerdown',160,80,true);pointer(window,'pointermove',1000000,1000000,true);});assert.equal(frame.style.width,'16384px');assert.equal(frame.style.getPropertyValue('--image-height'),'8192px');
 await act(async()=>pointer(window,'pointermove',-1000000,-1000000,true));assert.equal(frame.style.width,'16px');assert.equal(frame.style.getPropertyValue('--image-height'),'8px');assert.equal(requests.length,0);
 await act(async()=>pointer(window,'pointerup',-1000000,-1000000,true));assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit');const saved=parseCardImages(requests[0].value)[0]!;assert.equal(saved.width,16);assert.equal(saved.height,8);
},`<image src="../assets/images/${assetId}" layout="inline" width="160" height="80">explanation</image>`));
test('selected trash deletes only the body token and preserves its asset metadata',()=>fixture(async(host,requests)=>{await enter(host);await act(async()=>click(host.querySelector('.image-remove')!));assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit');assert.equal(requests[0].value,'above\n\nbelow');assert.equal(requests[0].before,body);assert.equal(requests.some(r=>r.kind==='images-update'),false);assert.equal(host.querySelector('.image-asset')!.getAttribute('aria-label'),'explanation');}));
test('native assets defer to intersection and thumbnails have a separate 512 cache',async()=>{
 const observed:{target?:Element;callback:IntersectionObserverCallback}[]=[],commands:{command:string;args:any}[]=[],host=document.createElement('div'),root=createRoot(host);document.body.append(host);const oldObserver=globalThis.IntersectionObserver,native={invoke:async(command:string,args:any)=>{commands.push({command,args});return 'data:image/png;base64,YQ==';}};
 Object.assign(globalThis,{__TAURI_INTERNALS__:native,IntersectionObserver:class{entry:{target?:Element;callback:IntersectionObserverCallback};constructor(callback:IntersectionObserverCallback){this.entry={callback};observed.push(this.entry);}observe(target:Element){this.entry.target=target;}disconnect(){}}});(window as any).__TAURI_INTERNALS__=native;
 try{const other={...image,assetId:'b'.repeat(64)+'.png'};await act(async()=>root.render(createElement('div',null,createElement(ImageGallery,{images:[other],compact:true}),createElement(ImageGallery,{images:[other]}))));assert.equal(commands.length,0);await act(async()=>{for(const entry of observed)entry.callback([{target:entry.target,isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver);await new Promise(resolve=>setTimeout(resolve,0));});assert.deepEqual(commands.map(c=>c.command).sort(),['read_image_asset','read_image_preview']);assert.equal(commands.find(c=>c.command==='read_image_preview')!.args.maxSide,512);assert.equal(host.querySelectorAll('img').length,2);}finally{await act(async()=>root.unmount());host.remove();delete (globalThis as any).__TAURI_INTERNALS__;delete (window as any).__TAURI_INTERNALS__;if(oldObserver)Object.assign(globalThis,{IntersectionObserver:oldObserver});else delete (globalThis as any).IntersectionObserver;}
});
test('free wrapping preserves fenced-code indentation, line breaks and surrounding text once',()=>fixture(async(host)=>{const pre=host.querySelector('pre')!;assert.ok(pre.textContent!.includes('  first'));assert.ok(pre.textContent!.includes('    second'));const lines=pre.querySelectorAll<HTMLElement>('.rich-flow-line');assert.ok(lines.length>=2);assert.ok(parseFloat(lines[lines.length-1]!.style.top)>parseFloat(lines[0]!.style.top));assert.equal((host.textContent!.match(/alpha/g)||[]).length,1);},`alpha\n<image src="../assets/images/${assetId}" layout="float" width="80" height="40" x="100" y="0">reference</image>\n\n\`\`\`text\n  first\n    second\n\`\`\``));

test('underlay can be selected through transparent text boxes without entering the text editor',()=>fixture(async(host,requests)=>{
 const frame=host.querySelector<HTMLElement>('.image-placement')!;frame.getBoundingClientRect=()=>({left:40,top:30,right:200,bottom:110,x:40,y:30,width:160,height:80,toJSON(){}} as DOMRect);
 const text=host.querySelector('.rich-text-paragraph')!;let entered=0;const count=()=>entered++;text.addEventListener('click',count);
 await act(async()=>{pointer(text,'pointerdown',80,60);pointer(window,'pointerup',80,60);click(text);});assert.equal(frame.dataset.selected,'true');assert.ok(host.querySelector('.image-layout-toolbar'));assert.equal(entered,0);assert.equal(requests.length,0);
 await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 await act(async()=>{pointer(text,'pointerdown',300,180);pointer(window,'pointerup',300,180);click(text);});assert.equal(entered,1);assert.equal(host.querySelector('.image-layout-toolbar'),null);
},`Text over the picture\n<image src="../assets/images/${assetId}" layout="underlay" width="160" height="80" x="40" y="30">reference</image>`));
test('selected underlay bitmap stays below text while its editing controls use a separate transparent layer',()=>fixture(async(host,requests)=>{
 const frame=host.querySelector<HTMLElement>('.image-placement')!;frame.getBoundingClientRect=()=>({left:40,top:30,right:200,bottom:110,x:40,y:30,width:160,height:80,toJSON(){}});
 await enter(host);assert.equal(frame.style.zIndex,'0');assert.equal(frame.querySelector('.image-layout-toolbar,.image-remove,.image-resize-grip'),null);
 let controls=host.querySelector<HTMLElement>('.image-edit-controls')!;assert.ok(controls);assert.ok(controls.parentElement===host.querySelector('.rich-image-body'));assert.ok(!frame.contains(controls));assert.equal(controls.dataset.imageControls,'0');assert.equal(controls.style.pointerEvents,'none');assert.equal(controls.style.left,'40px');assert.equal(controls.style.top,'30px');
 const text=host.querySelector('.rich-text-paragraph')!;await act(async()=>{pointer(text,'pointerdown',80,60);pointer(window,'pointermove',120,100);});assert.equal(requests.length,0);assert.equal(frame.style.zIndex,'0');controls=host.querySelector('.image-edit-controls')!;assert.equal(controls.style.left,'80px');assert.equal(controls.style.top,'70px');
 await act(async()=>pointer(window,'pointercancel',120,100));assert.equal(requests.length,0);assert.equal(frame.style.zIndex,'0');
 const grip=host.querySelector('.image-edit-controls .image-resize-grip')!;await act(async()=>{pointer(grip,'pointerdown',200,110);pointer(window,'pointermove',230,140);pointer(window,'pointerup',230,140);});assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit' && requests[0].value.includes('layout="underlay"') && requests[0].value.includes('width="190"') && requests[0].value.includes('height="110"'));assert.equal(frame.style.zIndex,'0');
},`Text over the picture\n<image src="../assets/images/${assetId}" layout="underlay" width="160" height="80" x="40" y="30">reference</image>`));
test('first underlay press through text enters editing and drags without raising the bitmap',()=>fixture(async(host,requests)=>{
 const frame=host.querySelector<HTMLElement>('.image-placement')!;frame.getBoundingClientRect=()=>({left:40,top:30,right:200,bottom:110,x:40,y:30,width:160,height:80,toJSON(){}});
 const text=host.querySelector('.rich-text-paragraph')!;await act(async()=>pointer(text,'pointerdown',80,60));assert.equal(frame.getAttribute('data-selected'),'true');assert.equal(frame.style.zIndex,'0');await act(async()=>pointer(window,'pointermove',120,100));assert.equal(frame.style.left,'80px');assert.equal(frame.style.top,'70px');assert.equal(frame.style.zIndex,'0');assert.equal(requests.length,0);await act(async()=>pointer(window,'pointerup',120,100));assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit' && requests[0].value.includes('layout="underlay"') && requests[0].value.includes('x="80"') && requests[0].value.includes('y="70"'));
},`Text over the picture\n<image src="../assets/images/${assetId}" layout="underlay" width="160" height="80" x="40" y="30">reference</image>`));
test('image hover shows its current zero-based body index including while selected',()=>fixture(async(host,requests)=>{
 const frames=host.querySelectorAll<HTMLElement>('.image-placement');await act(async()=>pointer(frames[1]!,'pointermove',20,20));assert.equal(document.querySelector('.image-hover-hint')?.textContent,'<image_1>');await act(async()=>pointer(frames[1]!,'pointerdown',20,20));assert.equal(frames[1]!.dataset.selected,'true');assert.equal(document.querySelector('.image-hover-hint')?.textContent,'<image_1>');await act(async()=>pointer(window,'pointerup',20,20));assert.equal(requests.length,0);
},`before\n![first](../assets/images/${assetId})\n![second](../assets/images/${assetId})\nafter`));

test('entering a picture immediately replaces the inherited edit-body tooltip with a pointer hint',()=>fixture(async(host)=>{
 host.title='edit body';const body=host.querySelector<HTMLElement>('.rich-image-body')!,frame=host.querySelector<HTMLElement>('.image-placement')!;
 await act(async()=>pointer(frame,'pointerover',20,30));
 assert.equal(body.getAttribute('title'),'');const hint=document.querySelector<HTMLElement>('.image-hover-hint')!;assert.ok(hint);assert.equal(hint.getAttribute('role'),'tooltip');assert.equal(hint.textContent,'<image_0>');assert.equal(hint.style.left,'32px');assert.equal(hint.style.top,'46px');
 await act(async()=>pointer(frame,'pointermove',1010,760));assert.ok(parseFloat(hint.style.left)<=window.innerWidth-84);assert.ok(parseFloat(hint.style.top)<=window.innerHeight-26);
 await act(async()=>pointer(host.querySelector('.rich-text-paragraph')!,'pointermove',300,180));assert.equal(document.querySelector('.image-hover-hint'),null);assert.equal(body.getAttribute('title'),null);
},`before\n![first](../assets/images/${assetId})\nafter`));
test('hovering underlay through text exposes a pointer hint without lifting the bitmap or inheriting the body title',()=>fixture(async(host,requests)=>{
 const frame=host.querySelector<HTMLElement>('.image-placement')!;frame.getBoundingClientRect=()=>({left:40,top:30,right:200,bottom:110,x:40,y:30,width:160,height:80,toJSON(){}});const text=host.querySelector('.rich-text-paragraph')!;
 await act(async()=>pointer(text,'pointermove',80,60));const label=document.querySelector('.image-hover-hint')!;assert.ok(label);assert.equal(label.textContent,'<image_0>');assert.ok(!frame.contains(label));assert.ok(label.parentElement===document.body);assert.equal(host.querySelector('.rich-image-body')!.getAttribute('title'),'');assert.equal(frame.style.zIndex,'0');assert.equal(frame.dataset.selected,'false');assert.equal(requests.length,0);
 await act(async()=>pointer(text,'pointermove',300,180));assert.equal(document.querySelector('.image-hover-hint'),null);
},`Text over the picture\n<image src="../assets/images/${assetId}" layout="underlay" width="160" height="80" x="40" y="30">reference</image>`));
test('image dragging extends past the visible body and keeps the new position',()=>fixture(async(host,requests)=>{
 host.className='preview';const rect=(x:number,y:number,width:number,height:number)=>({x,y,left:x,top:y,right:x+width,bottom:y+height,width,height,toJSON(){}} as DOMRect);
 host.querySelector<HTMLElement>('.preview')!.getBoundingClientRect=()=>rect(0,0,200,120);const body=host.querySelector<HTMLElement>('.rich-image-body')!,frame=host.querySelector<HTMLElement>('.image-placement')!;
 body.getBoundingClientRect=()=>rect(0,0,200,120);frame.getBoundingClientRect=()=>rect(parseFloat(frame.style.left),parseFloat(frame.style.top),160,80);
 await act(async()=>{pointer(frame,'pointerdown',80,60);pointer(window,'pointermove',600,600);});assert.equal(frame.style.left,'560px');assert.equal(frame.style.top,'570px');assert.equal(requests.length,0);assert.ok(body.querySelector('[data-object-drag-paper]'));
 await act(async()=>pointer(window,'pointerup',600,600));assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit');const saved=parseCardImages(requests[0].value)[0]!;assert.equal(saved.x,560);assert.equal(saved.y,570);assert.equal(body.querySelector('[data-object-drag-paper]'),null);
},`<image src="../assets/images/${assetId}" name="image_7" layout="float" width="160" height="80" x="40" y="30">reference</image>`));
test('layer and inline/free controls occupy one group above overlay/underlay controls and save painting order without lifting selection',()=>fixture(async(host,requests)=>{
 const frame=host.querySelector<HTMLElement>('.image-placement')!;assert.equal(frame.style.zIndex,'2');await enter(host);assert.equal(frame.style.zIndex,'2');
 const toolbar=host.querySelector('.image-layout-toolbar')!;assert.equal(toolbar.children[0]!.className,'image-tool-row image-layer-row');assert.equal(toolbar.children[0]!.querySelectorAll('button').length,4);assert.equal(toolbar.children[1]!.querySelectorAll('[data-layout-mode]').length,2);
 const up=toolbar.querySelector<HTMLButtonElement>('[data-image-layer="up"]')!,down=toolbar.querySelector<HTMLButtonElement>('[data-image-layer="down"]')!;assert.equal(up.disabled,false);assert.equal(down.disabled,true);
 await act(async()=>up.click());assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit');const refs=parseCardImages(requests[0].value);assert.deepEqual(refs.map(ref=>ref.name),['image_7','image_3']);assert.deepEqual(refs.map(ref=>ref.layer),[1,0]);assert.ok(refs.every(ref=>ref.layout==='overlay'));
},`<image src="../assets/images/${assetId}" layout="overlay" name="image_7" width="160" height="80" x="0" y="0">first</image>\n<image src="../assets/images/${assetId}" layout="overlay" name="image_3" width="160" height="80" x="0" y="0">second</image>`));
test('a resize that brings an old out-of-bounds position inside saves that position even if size stays the same',()=>fixture(async(host,requests)=>{
 const rect=(x:number,y:number,width:number,height:number)=>({x,y,left:x,top:y,right:x+width,bottom:y+height,width,height,toJSON(){}} as DOMRect);host.querySelector<HTMLElement>('.preview')!.getBoundingClientRect=()=>rect(0,0,200,120);
 const body=host.querySelector<HTMLElement>('.rich-image-body')!,frame=host.querySelector<HTMLElement>('.image-placement')!;body.getBoundingClientRect=()=>rect(0,0,200,120);frame.getBoundingClientRect=()=>rect(parseFloat(frame.style.left),parseFloat(frame.style.top),160,80);
 await enter(host);await act(async()=>{pointer(host.querySelector('.image-resize-grip')!,'pointerdown',149,69,true);pointer(window,'pointermove',149,9,true);});assert.equal(frame.style.left,'0px');assert.equal(frame.style.top,'0px');assert.equal(requests.length,0);
 await act(async()=>pointer(window,'pointerup',149,9,true));assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit');const saved=parseCardImages(requests[0].value)[0]!;assert.equal(saved.x,0);assert.equal(saved.y,0);assert.equal(saved.width,160);assert.equal(saved.height,80);
},`<image src="../assets/images/${assetId}" name="image_7" layout="float" width="160" height="80" x="-10" y="-10">reference</image>`));

test('resizing can grow beyond the card viewport and retains size after release',()=>fixture(async(host,requests)=>{
 const rect=(x:number,y:number,width:number,height:number)=>({x,y,left:x,top:y,right:x+width,bottom:y+height,width,height,toJSON(){}} as DOMRect);
 const pane=host.querySelector<HTMLElement>('.preview')!,body=host.querySelector<HTMLElement>('.rich-image-body')!,frame=host.querySelector<HTMLElement>('.image-placement')!;
 pane.getBoundingClientRect=()=>rect(0,0,200,120);body.getBoundingClientRect=()=>rect(0,0,200,120);frame.getBoundingClientRect=()=>rect(40,30,160,80);
 await enter(host);const grip=host.querySelector('.image-resize-grip')!;
 await act(async()=>{pointer(grip,'pointerdown',200,110);pointer(window,'pointermove',500,400);});
 assert.equal(frame.style.width,'460px');assert.equal(frame.style.getPropertyValue('--image-height'),'370px');assert.equal(requests.length,0);
 await act(async()=>pointer(window,'pointerup',500,400));assert.equal(requests.length,1);assert.ok(requests[0]!.kind==='edit');const saved=parseCardImages(requests[0].value)[0]!;assert.equal(saved.width,460);assert.equal(saved.height,370);assert.equal(body.querySelector('[data-object-drag-paper]'),null);
},`<image src="../assets/images/${assetId}" name="image_7" layout="float" width="160" height="80" x="40" y="30">reference</image>`));

test('Escape clears the extended paper and restores the original object without writing',()=>fixture(async(host,requests)=>{
 const frame=host.querySelector<HTMLElement>('.image-placement')!;
 await act(async()=>{pointer(frame,'pointerdown',10,10);pointer(window,'pointermove',500,600);});assert.ok(host.querySelector('[data-object-drag-paper]'));
 await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'})));
 assert.equal(host.querySelector('[data-object-drag-paper]'),null);assert.equal(frame.style.left,'20px');assert.equal(frame.style.top,'30px');assert.equal(requests.length,0);
},`<image src="../assets/images/${assetId}" name="image_7" layout="float" width="160" height="80" x="20" y="30">reference</image>`));

test('an image reserves 64px beyond both final edges without moving its coordinates',()=>fixture(async(host)=>{
 const extent=host.querySelector<HTMLElement>('[data-body-object-boundary]')!,frame=host.querySelector<HTMLElement>('.image-placement')!;
 assert.ok(extent);assert.equal(extent.style.width,'264px');assert.equal(extent.style.height,'174px');assert.equal(frame.style.left,'40px');assert.equal(frame.style.top,'30px');
},`<image src="../assets/images/${assetId}" name="image_7" layout="float" width="160" height="80" x="40" y="30">reference</image>`));
