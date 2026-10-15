import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceApp} from '../src/webview/WorkspaceApp.tsx';
import {WorkspaceController} from '../src/webview/controller.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {executeAction} from '../src/core/actions.ts';
import {emptyViewState} from '../src/core/view-state.ts';
Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:(time:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id)});
const image={id:'image1',assetId:`${'a'.repeat(64)}.png`,name:'shot.png',mime:'image/png' as const,width:20,height:10};
const markdown=`![shot](../assets/images/${image.assetId})`;
for(const layout of ['plain','ordered','grid','plane','columns'] as const)test(`image-only children use multi-image grid in ${layout}; mixed children keep text`,async()=>{
 const buffer=createBufferedFs(),s=openSession('/ui-images',{ops:buffer.ops}),anchor=executeAction(s,{kind:'create',parent:null,title:'Anchor',layout}).createdId!,parent=layout==='columns'?s.state.children.get(anchor)![0]!.id:anchor;
 const pure=createCard(s,{parentId:parent,title:'Pure',content:`${markdown}\n${markdown}`,images:[image],...(layout==='plane'?{plane:{x:0,y:0,w:190,h:112,z:0}}:{})});
 const mixed=createCard(s,{parentId:parent,title:'Mixed',content:`Text remains\n${markdown}`,images:[image],...(layout==='plane'?{plane:{x:200,y:0,w:190,h:112,z:0}}:{})});
 const c=new WorkspaceController(s,emptyViewState(),buffer,toAsync(createMemoryFs().ops)),host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{await act(async()=>root.render(createElement(WorkspaceApp,{controller:c,cardId:anchor})));
  const tile=host.querySelector(`[data-card-id="${pure}"]`)!;assert.equal(tile.querySelectorAll('.image-thumbnails .card-image').length,2);assert.ok(tile.querySelector('.image-thumbnails .child-delete'));
  assert.equal(document.querySelector('.image-hover-hint'),null);
  for(const [index,figure] of [...tile.querySelectorAll('.image-thumbnails .card-image')].entries()){
   await act(async()=>figure.dispatchEvent(new MouseEvent('pointerover',{bubbles:true,clientX:20,clientY:30})));
   const hint=document.querySelector<HTMLElement>('.image-hover-hint')!;assert.ok(hint);assert.equal(hint.textContent,`<image_${index}>`);assert.equal(hint.getAttribute('role'),'tooltip');assert.equal(hint.style.left,'32px');assert.equal(figure.getAttribute('title'),'');
  }
  const other=host.querySelector(`[data-card-id="${mixed}"]`)!;assert.ok(other.textContent!.includes('Text remains'));assert.ok(other.textContent!.includes('<image_0>'));assert.equal(other.querySelector('.image-thumbnails'),null);
 }finally{await act(async()=>root.unmount());host.remove();}
});
