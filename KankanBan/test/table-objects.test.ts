import {objectToolPlacement} from '../src/webview/object-tool-placement.ts';
import {passedDragThreshold} from '../src/webview/pointer-gesture.ts';
import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {markdownEditorParts} from '../src/webview/markdown-editor-model.ts';
import {mixedPreview} from '../src/core/image-markdown.ts';
import {Markdown} from '../src/webview/Markdown.tsx';
import type {Request} from '../src/webview/controller.ts';
import {parseTables,serializeTable,ensureTables,mergeTable,splitTable,insertTableTrack,resizeTableTracks,deleteTableSelection,nameInsertedTables,validTable} from '../src/core/table-markdown.ts';
import {parseBodyObjects,shiftBodyLayer,objectStack} from '../src/core/body-objects.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {executeAction} from '../src/core/actions.ts';
import {buildSharePackage,shareAssetIds,parseSharePackage,importSharePackage} from '../src/core/share-package.ts';
import {parseCardImages} from '../src/core/image-markdown.ts';
import {PrototypeNote} from '../src/webview/PrototypeNote.tsx';
Object.assign(globalThis,{requestAnimationFrame:(fn:(time:number)=>void)=>setTimeout(()=>fn(0),0),cancelAnimationFrame:(id:ReturnType<typeof setTimeout>)=>clearTimeout(id),ResizeObserver:class{observe(){}disconnect(){}},OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:[...text].length*8})};}}});
const body='before\n| A | B |\n| --- | --- |\n| C | D |\nafter';
test('a table minus button folds to its accent marker, saves state and expands on click',()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());
 const collapse=host.querySelector<HTMLButtonElement>('.table-collapse');assert.ok(collapse);assert.ok(collapse.parentElement===host.querySelector('.image-remove')!.parentElement);
 await act(async()=>collapse.click());assert.equal(requests.length,1);assert.equal(host.querySelector('.editable-table'),null);
 const marker=host.querySelector<HTMLButtonElement>('.table-collapsed-label')!;assert.ok(marker);assert.equal(marker.textContent,'<table_0>');assert.ok(parseTables(content())[0]!.collapsed);assert.equal(host.dataset.leaked,undefined);
 await act(async()=>marker.click());assert.equal(requests.length,2);assert.ok(host.querySelector('.editable-table'));assert.ok(!parseTables(content())[0]!.collapsed);assert.equal(host.dataset.leaked,undefined);
}));
test('new table tracks use 80px columns and 40px rows',()=>{
 const table=parseTables(body)[0]!;assert.deepEqual(table.data.columns,[80,80]);assert.deepEqual(table.data.rows,[40,40]);
 const shrunk=parseTables(serializeTable(table,{width:1,height:1}))[0]!;assert.deepEqual(shrunk.data.columns,[80,80]);assert.deepEqual(shrunk.data.rows,[40,40]);
});
for(const axis of ['rows','columns'] as const)test(`inline table ${axis} insertion keeps an independent top-left anchored flow block`,()=>interactive(async(host,content,requests)=>{
 const frame=host.querySelector<HTMLElement>('[data-object-type="table"]')!,block=frame.parentElement!;
 assert.ok(block.classList.contains('table-flow-block'));assert.equal(block.textContent,'ABCD');
 const previous=block.previousElementSibling!.textContent,next=block.nextElementSibling!.textContent;
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());
 await act(async()=>host.querySelectorAll<HTMLButtonElement>('.table-tool-buttons button')[axis==='rows'?2:3]!.click());
 assert.ok(frame.parentElement===block);assert.equal(block.previousElementSibling!.textContent,previous);assert.equal(block.nextElementSibling!.textContent,next);assert.equal(requests.length,1);assert.equal(parseTables(content())[0]!.layout,'inline');
},'before '+serializeTable(parseTables(body)[0]!)+' after'));
for(const axis of ['rows','columns'] as const)test(`border selection deletes populated ${axis} in two steps`,()=>interactive(async(host,content,requests)=>{
 const edge=host.querySelector<HTMLElement>(`[data-select-axis="${axis}"][data-track="0"]`);assert.ok(edge);
 await act(async()=>edge.click());assert.equal(host.querySelector('textarea'),null);assert.equal(host.querySelectorAll('[data-cell-selected="true"]').length,2);
 const table=host.querySelector<HTMLElement>('.table-object')!;
 await act(async()=>table.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Delete'})));assert.equal(requests.length,1);
 let data=parseTables(content())[0]!.data;assert.equal(data[axis].length,2);assert.ok(data.cells.filter(cell=>axis==='rows'?cell.row===0:cell.col===0).every(cell=>cell.text===''));
 await act(async()=>table.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Delete'})));assert.equal(requests.length,2);data=parseTables(content())[0]!.data;assert.equal(data[axis].length,1);assert.ok(validTable(data));
 assert.deepEqual(data.cells.map(cell=>cell.text),axis==='rows'?['C','D']:['B','D']);assert.equal(host.dataset.leaked,undefined);
}));
test('Shift resizing uses the larger horizontal/vertical scale instead of averaging them',()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());const grip=host.querySelector('.image-resize-grip')!;
 await act(async()=>{pointer(grip,'pointerdown',510,180,true);pointer(window,'pointermove',510,360,true);});
 assert.deepEqual([...host.querySelectorAll<HTMLElement>('.editable-table col')].map(col=>Number.parseFloat(col.style.width)),[340,680]);
 assert.deepEqual([...host.querySelectorAll<HTMLElement>('.editable-table tr')].map(row=>Number.parseFloat(row.style.height)),[120,240]);assert.equal(requests.length,0);
 await act(async()=>pointer(window,'pointerup',510,360,true));assert.equal(requests.length,1);assert.deepEqual(parseTables(content())[0]!.data.columns,[340,680]);
},serializeTable(parseTables(body)[0]!,{data:{...parseTables(body)[0]!.data,columns:[170,340],rows:[60,120]}})));
test('the last free table reserves exactly 64px beyond its right and bottom edges',()=>interactive(async(host)=>{
 const extent=host.querySelector<HTMLElement>('[data-body-object-boundary]');assert.ok(extent);assert.equal(extent.style.width,'244px');assert.equal(extent.style.height,'174px');
},serializeTable(parseTables(body)[0]!,{layout:'float',x:20,y:30})));
test('whole-table shrinking clamps each track independently during preview and after save',()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());
 const grip=host.querySelector('.image-resize-grip')!;
 await act(async()=>{pointer(grip,'pointerdown',420,160);pointer(window,'pointermove',210,80);});
 const columns=[...host.querySelectorAll<HTMLElement>('.editable-table col')].map(col=>Number.parseFloat(col.style.width));
 const rows=[...host.querySelectorAll<HTMLElement>('.editable-table tr')].map(row=>Number.parseFloat(row.style.height));
 assert.deepEqual(columns,[80,170]);assert.equal(rows[0],40);assert.ok(Math.abs(rows[1]!-120*80/160)<.001);assert.equal(requests.length,0);
 await act(async()=>pointer(window,'pointerup',210,80));assert.equal(requests.length,1);
 const data=parseTables(content())[0]!.data;assert.deepEqual(data.columns,columns);assert.deepEqual(data.rows,rows);
 const savedColumns=[...host.querySelectorAll<HTMLElement>('.editable-table col')].map(col=>Number.parseFloat(col.style.width));assert.deepEqual(savedColumns,columns);
},serializeTable(parseTables(body)[0]!,{data:{...parseTables(body)[0]!.data,columns:[80,340],rows:[40,120]}})));
for(const axis of ['rows','columns'] as const)test(`insert ${axis} immediately after the selected cell, not at the table end`,()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());
 const buttons=host.querySelectorAll<HTMLButtonElement>('.table-tool-buttons button');
 await act(async()=>buttons[axis==='rows'?2:3]!.click());
 const table=parseTables(content())[0]!;
 assert.equal(requests.length,1);
 assert.equal(table.data[axis].length,3);
 const at=(r:number,c:number)=>table.data.cells.find(cell=>cell.row===r && cell.col===c)?.text;
 if(axis==='rows'){assert.equal(at(1,0),'');assert.equal(at(2,0),'C');assert.equal(at(2,1),'D');}
 else{assert.equal(at(0,1),'');assert.equal(at(0,2),'B');assert.equal(at(1,2),'D');}
 assert.ok(validTable(table.data));
}));
test('table tracks retain their configured minimum dimensions when shrinking',()=>{
 const table=parseTables(body)[0]!;
 assert.ok(table.data.columns.every(width=>width>=80));
 const shrunk=parseTables(serializeTable(table,{width:1,height:1}))[0]!;
 assert.ok(shrunk.data.columns.every(width=>width>=80));
 assert.ok(shrunk.data.rows.every(height=>height>=40));
});
test('a Markdown table is one named atomic editor object',()=>{
 const parts=markdownEditorParts(body),atom=parts.find(part=>part.atomic);assert.ok(atom?.atomic);assert.equal(atom.name,'table_0');assert.ok(atom.text.includes('| A | B |'));assert.equal(parts.map(part=>part.text).join(''),body);
});
test('child preview uses stable image names instead of the generic image marker',()=>{
 const tag=`<image src="../assets/images/${'a'.repeat(64)}.png" name="image_8">picture</image>`;assert.equal(mixedPreview(`before ${tag} after`),'before <image_8> after');
});
test('a table preview cell opens its own editor with one click',async()=>{
 const host=document.createElement('div'),root=createRoot(host),requests:Request[]=[];document.body.append(host);
 try{await act(async()=>root.render(createElement(Markdown,{text:body,id:'card',send:async request=>requests.push(request)})));const cell=host.querySelector<HTMLElement>('[data-table-cell]');assert.ok(cell);await act(async()=>cell.click());assert.ok(host.querySelector('textarea.table-cell-editor'));assert.equal(requests.length,0);}finally{await act(async()=>root.unmount());host.remove();}
});
test('table names, track dimensions and cell content round-trip in the body without losing literal markup',()=>{
 const original=parseTables(body)[0]!,data={...original.data,columns:[190,280],rows:[68,70],cells:original.data.cells.map(cell=>({...cell,text:cell.row===0 && cell.col===0?'**value** & <cell> literal </cell>\n\\*escaped*':cell.text}))};
 const text=serializeTable(original,{data,x:10,y:20,layout:'float',layer:2});assert.deepEqual(parseTables(text)[0]!.data,data);assert.equal(ensureTables(text),text);
 const second=serializeTable(original,{name:'table_7'});assert.deepEqual(parseTables(ensureTables(text+'\n'+second)).map(table=>table.name),['table_0','table_7']);assert.equal(nameInsertedTables(second,second).includes('name="table_8"'),true);assert.equal(nameInsertedTables(second,''),second);
 assert.equal(parseTables('```\n'+body+'\n```').length,0);assert.equal(parseTables('`'+text.replaceAll('\n','')+'`').length,0);assert.equal(parseTables(text.replace('layout="float"','onclick="bad"')).length,0);
});
test('rectangular merges retain every cell in reading order and reject partial intersections',()=>{
 const data=parseTables(body)[0]!.data,merged=mergeTable(data,{row:0,col:0},{row:1,col:1});assert.equal(merged.cells.length,1);assert.equal(merged.cells[0]!.text,'A\nB\nC\nD');assert.equal(validTable(merged),true);
 assert.throws(()=>mergeTable(mergeTable(data,{row:0,col:0},{row:1,col:0}),{row:0,col:0},{row:0,col:1}),/矩形/);
 const split=splitTable(merged,merged.cells[0]!);assert.equal(split.cells.length,4);assert.equal(split.cells[0]!.text,'A\nB\nC\nD');assert.equal(split.cells[1]!.text,'');assert.equal(validTable(split),true);
 assert.equal(validTable({...data,cells:[...data.cells,data.cells[0]!]}),false);
});
test('table and picture layer order is shared while text-underlay remains separate',()=>{
 const picture=`<image src="../assets/images/${'a'.repeat(64)}.png" name="image_3" layout="overlay">picture</image>`,text=ensureTables(body)+'\n'+picture;
 const moved=shiftBodyLayer(text,0,'up'),objects=parseBodyObjects(moved);assert.deepEqual(objectStack(objects),[3,2]);assert.deepEqual(objects.map(object=>object.displayName),['table_0','image_3']);assert.equal(objects[0]!.table!.layout,'inline');assert.equal(shiftBodyLayer(moved,0,'up'),moved);
});
function pointer(target:EventTarget,type:string,x:number,y:number,shiftKey=false){const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y,shiftKey});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);}
async function interactive(run:(host:HTMLElement,content:()=>string,requests:Request[])=>Promise<void>,text=body){
 const fs=createMemoryFs(),session=openSession('/tables',{ops:fs.ops}),id=createCard(session,{parentId:null,content:text}),host=document.createElement('div'),root=createRoot(host),requests:Request[]=[];document.body.append(host);
 const content=()=>session.state.cards.get(id)!.content,render=()=>root.render(createElement('div',{onClick:()=>host.dataset.leaked='true'},createElement(Markdown,{text:content(),id,send:async(request:Request)=>{requests.push(request);assert.ok(request.kind==='edit');executeAction(session,request);render();}})));
 try{await act(async()=>render());await run(host,content,requests);}finally{await act(async()=>root.unmount());host.remove();}
}
test('a physical cell click edits and saves only that cell, without opening the body editor',()=>interactive(async(host,content,requests)=>{
 const cell=host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!;await act(async()=>{pointer(cell,'pointerdown',10,10);pointer(window,'pointerup',10,10);cell.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));});
 const input=host.querySelector<HTMLTextAreaElement>('textarea.table-cell-editor')!;assert.ok(input);assert.equal(input.value,'A');assert.equal(host.dataset.leaked,undefined);
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'edited');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',ctrlKey:true})));assert.equal(requests.length,1);assert.equal(parseTables(content())[0]!.data.cells[0]!.text,'edited');assert.equal(parseTables(content())[0]!.data.cells[1]!.text,'B');assert.equal(host.querySelector('textarea'),null);
}));
test('Shift selects a rectangular area; merge and split each save once',()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());await act(async()=>host.querySelector('[data-table-cell="1:1"]')!.dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true,detail:0})));
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="合并选中的矩形单元格"]')!.click());assert.equal(requests.length,1);assert.equal(parseTables(content())[0]!.data.cells[0]!.text,'A\nB\nC\nD');assert.equal(host.querySelectorAll('[data-table-cell]').length,1);
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="拆分单元格"]')!.click());assert.equal(requests.length,2);assert.equal(host.querySelectorAll('[data-table-cell]').length,4);
}));
test('row and column boundary dragging preview continuously and save once on release',()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());await act(async()=>host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'})));
 const grip=host.querySelector('.table-column-grip')!;await act(async()=>{pointer(grip,'pointerdown',120,20);pointer(window,'pointermove',160,20);});assert.equal(requests.length,0);assert.equal(host.querySelector<HTMLElement>('[data-object-type="table"]')!.style.width,'200px');
 await act(async()=>pointer(window,'pointerup',160,20));assert.equal(requests.length,1);assert.equal(parseTables(content())[0]!.data.columns[0],120);
 const row=host.querySelector('.table-row-grip')!;await act(async()=>{pointer(row,'pointerdown',20,36);pointer(window,'pointermove',20,54);pointer(window,'pointerup',20,54);});assert.equal(requests.length,2);assert.equal(parseTables(content())[0]!.data.rows[0],58);
}));
test('table layout controls expose only inline/free, and use the same insertion caret and image layers',()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());await act(async()=>host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'})));
 assert.deepEqual([...host.querySelectorAll('[data-layout-mode]')].map(node=>node.getAttribute('data-layout-mode')),['inline','float']);
 await act(async()=>host.querySelector<HTMLButtonElement>('[data-layout-mode="float"]')!.click());assert.equal(parseTables(content())[0]!.layout,'float');assert.equal(requests.length,1);
 const frame=host.querySelector('.image-placement[data-object-type="table"]')!;await act(async()=>{pointer(frame,'pointerdown',10,10);pointer(window,'pointermove',40,50);pointer(window,'pointerup',40,50);});assert.equal(requests.length,2);const table=parseTables(content())[0]!;assert.equal(table.x,30);assert.equal(table.y,40);
}));
test('table state and pictures inside its cells survive save, reopen, share and undo',()=>{
 const fs=createMemoryFs(),session=openSession('/source-tables',{ops:fs.ops}),assetId='a'.repeat(64)+'.png',image={id:'photo',assetId,name:'photo',mime:'image/png' as const,width:40,height:20},id=createCard(session,{parentId:null,content:body,images:[image]});
 const before=session.state.cards.get(id)!.content,table=parseTables(before)[0]!,data={...table.data,cells:table.data.cells.map(cell=>cell.row===1 && cell.col===1?{...cell,text:`<image src="../assets/images/${assetId}" name="image_9">photo &amp; text</image>`}:cell)};
 executeAction(session,{kind:'edit',id,field:'content',before,value:before.slice(0,table.start)+serializeTable(table,{data,layout:'float',x:20,y:30,layer:1})+before.slice(table.end)});
 const content=session.state.cards.get(id)!.content;assert.equal(parseTables(content)[0]!.data.cells[3]!.text,data.cells[3]!.text);assert.equal(openSession('/source-tables',{ops:fs.ops}).state.cards.get(id)!.content,content);assert.deepEqual(shareAssetIds(session.state,id),[assetId]);
 const pkg=buildSharePackage(session.state,id,new Map([[assetId,'aW1hZ2U=']])),copy=parseSharePackage(JSON.parse(JSON.stringify(pkg)));assert.equal(copy.cards[0]!.content,content);
 const destination=openSession('/dest-tables',{ops:createMemoryFs().ops}),imported=importSharePackage(destination,copy,null);assert.equal(destination.state.cards.get(imported.rootId)!.content,content);assert.equal(parseCardImages(content)[0]!.name,'image_9');
 executeAction(session,{kind:'undo'});assert.equal(session.state.cards.get(id)!.content,before);
});
test('malformed table objects stay literal and overlapping or missing cells cannot be serialized',()=>{
 const table=parseTables(body)[0]!,tag=serializeTable(table);
 for(const bad of [tag.replace('columns="80,80"','columns="NaN,80"'),tag.replace('rows="40,40"','rows="0,40"'),tag.replace('rowspan="1"','rowspan="99"'),tag.replace('name="table_0"','name="table_00"'),tag.replace('layout="inline"','layout="underlay"'),tag.replace('<table ','<table style="color:red" ')])assert.equal(parseTables(bad).length,0);
 assert.throws(()=>serializeTable(table,{data:{...table.data,cells:table.data.cells.slice(1)}}),/无效/);
});
test('a rejected cell save retains its text for correction and does not clear the editor',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{await act(async()=>root.render(createElement(Markdown,{text:body,id:'card',send:async()=>{throw new Error('blocked');}})));await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());
  const input=host.querySelector<HTMLTextAreaElement>('textarea')!;await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'keep draft');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',ctrlKey:true})));assert.equal(host.querySelector<HTMLTextAreaElement>('textarea')!.value,'keep draft');assert.match(host.querySelector('[role=alert]')!.textContent!,/blocked/);
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('ordinary card tools stay outside the table while clicks edit cells directly',async()=>{
 const session=openSession('/table-dock',{ops:createMemoryFs().ops}),id=createCard(session,{parentId:null,content:body}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{await act(async()=>root.render(createElement(PrototypeNote,{card:session.state.cards.get(id)!,send:async()=>({}),children:null,breadcrumb:null,add:()=>undefined})));
  await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());
  const dock=host.querySelector('[data-floating-object-tools]')!,table=host.querySelector('.table-object')!,preview=host.querySelector('.preview')!;
  assert.ok(dock.querySelector('.table-tools'));assert.ok(dock.querySelector('.image-layout-toolbar'));assert.equal(dock.querySelector('.image-remove,.image-resize-grip'),null);assert.ok(host.querySelector('.image-edit-controls .image-remove'));assert.ok(host.querySelector('.image-edit-controls .image-resize-grip'));assert.equal(dock.querySelector('.table-track-fields'),null);assert.equal(dock.querySelector('.table-tool-buttons')!.children.length,4);assert.equal(dock.querySelector('.image-tool-row')!.children.length,4);assert.ok(!table.contains(dock));assert.ok(preview.contains(dock));assert.ok(host.querySelector('textarea.table-cell-editor'));
  await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:1"]')!.click());assert.equal(host.querySelector<HTMLTextAreaElement>('textarea.table-cell-editor')!.value,'B');assert.ok(dock.querySelector('.table-tools'));assert.ok(dock.querySelector('.image-layout-toolbar'));assert.ok(host.querySelector('.table-surface'));
  assert.ok(host.querySelector('[data-visual-editor]'),'the shared body remains mounted while a cell is edited');assert.notEqual(host.querySelector('[data-visual-editor]')?.getAttribute('contenteditable'),'true');assert.equal(host.querySelector('.table-object .image-layout-toolbar,.table-object .table-tools'),null);
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('the bottom-right size tool can resize a table while a cell editor stays open',()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());
 const tool=host.querySelector('.image-edit-controls .image-resize-grip')!,surface=host.querySelector('.table-object')!;assert.ok(tool);assert.ok(!surface.contains(tool));assert.ok(host.querySelector('textarea.table-cell-editor'));
 await act(async()=>{pointer(tool,'pointerdown',10,10);pointer(window,'pointermove',30,20);pointer(window,'pointerup',30,20);});
 const table=parseTables(content())[0]!;assert.equal(requests.length,1);assert.equal(table.data.columns.reduce((a,b)=>a+b,0),180);assert.equal(table.data.rows.reduce((a,b)=>a+b,0),90);assert.ok(host.querySelector('textarea.table-cell-editor'));assert.ok(host.querySelector('.table-tools'));
}));
for(const action of ['resize','move'] as const)test(`${action}: release click cannot leak into the body editor`,()=>interactive(async(host,_content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());await act(async()=>host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'})));
 const target=action==='resize'?host.querySelector('.image-edit-controls .image-resize-grip')!:host.querySelector('[data-object-type="table"]')!,bodyRoot=host.querySelector('.rich-image-body')!;
 await act(async()=>{pointer(target,'pointerdown',10,10);pointer(window,'pointermove',40,40);pointer(window,'pointerup',40,40);bodyRoot.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));});assert.equal(host.dataset.leaked,undefined);
}));
test('the entire currently edited cell is excluded from dragging, and clicks do not capture',()=>interactive(async(host,_content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());const cell=host.querySelector('[data-table-cell="0:0"]')!,bodyRoot=host.querySelector<HTMLElement>('.rich-image-body')!;let captures=0;bodyRoot.setPointerCapture=()=>{captures++;};
 await act(async()=>{pointer(cell,'pointerdown',10,10);pointer(window,'pointermove',50,50);pointer(window,'pointerup',50,50);});assert.equal(captures,0);assert.equal(requests.length,0);assert.ok(host.querySelector('textarea.table-cell-editor'));
}));

test('external tool placement prefers the right and only falls below when it cannot fit',()=>{
 const object={left:20,top:30,right:260,bottom:110},tools={width:180,height:60};
 assert.deepEqual(objectToolPlacement(object,tools,{left:10,right:600}),{side:'right',left:268,top:30});
 const below=objectToolPlacement(object,tools,{left:10,right:320});assert.deepEqual(below,{side:'below',left:20,top:118});assert.ok(below.top>=object.bottom);
 assert.equal(passedDragThreshold({clientX:10,clientY:10},{clientX:15,clientY:10}),false);assert.equal(passedDragThreshold({clientX:10,clientY:10},{clientX:16,clientY:10}),true);
});
test('object tools follow a scrolled viewport rather than disappearing below or beside it',()=>{
 const clip={left:100,right:400,top:80,bottom:280},tools={width:100,height:60};
 const position=objectToolPlacement({left:10,right:500,top:-200,bottom:600},tools,clip);
 assert.ok(position.left>=clip.left && position.left+tools.width<=clip.right);
 assert.ok(position.top>=clip.top && position.top+tools.height<=clip.bottom);
});
test('selected object controls recompute against the viewport after horizontal and vertical scrolling',()=>interactive(async(host)=>{
 host.className='preview';const rect=(x:number,y:number,w:number,h:number)=>({x,y,left:x,top:y,right:x+w,bottom:y+h,width:w,height:h,toJSON(){}} as DOMRect);
 host.getBoundingClientRect=()=>rect(10,20,300,200);const bodyRoot=host.querySelector<HTMLElement>('.rich-image-body')!,frame=host.querySelector<HTMLElement>('[data-object-type="table"]')!;
 let offset=0;bodyRoot.getBoundingClientRect=()=>rect(10-offset,20-offset,300,200);frame.getBoundingClientRect=()=>rect(30-offset,50-offset,340,120);
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());const dock=host.querySelector<HTMLElement>('[data-floating-object-tools]')!;
 dock.getBoundingClientRect=()=>rect(0,0,100,60);await act(async()=>window.dispatchEvent(new Event('resize')));
 const before=dock.style.top;offset=500;await act(async()=>host.dispatchEvent(new Event('scroll')));assert.notEqual(dock.style.top,before);
 const x=Number.parseFloat(dock.style.left)+10-offset,y=Number.parseFloat(dock.style.top)+20-offset;
 assert.ok(x>=10 && x+100<=310);assert.ok(y>=20 && y+60<=220);
},serializeTable(parseTables(body)[0]!,{layout:'float',x:20,y:30})));
test('a non-edited table cell only captures after the same window movement threshold',()=>interactive(async(host,_content,requests)=>{
 const bodyRoot=host.querySelector<HTMLElement>('.rich-image-body')!,cell=host.querySelector('[data-table-cell="0:0"]')!;let captures=0;bodyRoot.setPointerCapture=()=>{captures++;};
 await act(async()=>pointer(cell,'pointerdown',10,10));assert.equal(captures,0);
 await act(async()=>pointer(window,'pointermove',15,10));assert.equal(captures,0);
 await act(async()=>pointer(window,'pointermove',16,10));assert.equal(captures,1);
 await act(async()=>pointer(window,'pointercancel',16,10));assert.equal(requests.length,0);
}));

test('text insets do not move free table coordinates, and compact cells receive no document inset',()=>interactive(async(host,content,requests)=>{
 const frame=host.querySelector<HTMLElement>('[data-object-type="table"]')!;
 assert.equal(frame.style.left,'20px');assert.equal(frame.style.top,'40px');
 const root=host.querySelector<HTMLElement>('.rich-image-body')!;assert.equal(root.style.padding,'');
 const line=root.querySelector<HTMLElement>(':scope > .rich-image-flow .rich-flow-line')!;
 assert.ok(Number.parseFloat(line.style.left)>=16);
 assert.equal(requests.length,0);
 assert.equal(parseTables(content())[0]!.x,20);assert.equal(parseTables(content())[0]!.y,40);
},'text above\n'+serializeTable(parseTables(body)[0]!,{layout:'float',x:20,y:40})+'\ntext below'));
test('track shrinking stops at the configured width and height minima',()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());
 await act(async()=>host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'})));
 const col=host.querySelector('.table-column-grip')!;
 await act(async()=>{pointer(col,'pointerdown',170,20);pointer(window,'pointermove',0,20);pointer(window,'pointerup',0,20);});
 assert.equal(parseTables(content())[0]!.data.columns[0],80);
 const row=host.querySelector('.table-row-grip')!;
 await act(async()=>{pointer(row,'pointerdown',20,36);pointer(window,'pointermove',20,0);pointer(window,'pointerup',20,0);});
 assert.equal(parseTables(content())[0]!.data.rows[0],40);
}));

for(const axis of ['rows','columns'] as const)test(`insert ${axis} preserves spanning merges and other tracks`,()=>{
 const original=parseTables('| A | B | C |\n| --- | --- | --- |\n| D | E | F |\n| G | H | I |')[0]!;
 const data=mergeTable(original.data,axis==='rows'?{row:0,col:1}:{row:1,col:0},axis==='rows'?{row:2,col:1}:{row:1,col:2});
 const next=insertTableTrack(data,axis,{row:0,col:0});assert.ok(validTable(next));
 const merged=next.cells.find(cell=>axis==='rows'?cell.col===1 && cell.row===0:cell.row===1 && cell.col===0)!;
 assert.equal(axis==='rows'?merged.rowSpan:merged.colSpan,4);
 assert.equal(merged.text,axis==='rows'?'B\nE\nH':'D\nE\nF');
 assert.equal(next.cells.find(cell=>cell.row===0 && cell.col===0)!.text,'A');
 assert.deepEqual(parseTables(serializeTable(original,{data:next}))[0]!.data,next);
 const afterMerge=insertTableTrack(data,axis,merged);
 assert.ok(validTable(afterMerge));assert.equal(afterMerge[axis].length,4);
 assert.equal(afterMerge.cells.find(cell=>axis==='rows'?cell.col===1 && cell.row===0:cell.row===1 && cell.col===0)![axis==='rows'?'rowSpan':'colSpan'],3);
 assert.throws(()=>insertTableTrack(data,axis,{row:99,col:99}),/变化|更改|修改/);
});

for(const resize of [false,true])test(`free table ${resize?'resize':'move'} extends past viewport and removes only temporary space`,()=>interactive(async(host,content,requests)=>{
 const rect=(x:number,y:number,w:number,h:number)=>({x,y,left:x,top:y,right:x+w,bottom:y+h,width:w,height:h,toJSON(){}} as DOMRect);
 const bodyRoot=host.querySelector<HTMLElement>('.rich-image-body')!,frame=host.querySelector<HTMLElement>('[data-object-type="table"]')!;
 bodyRoot.getBoundingClientRect=()=>rect(0,0,200,120);frame.getBoundingClientRect=()=>rect(Number.parseFloat(frame.style.left),Number.parseFloat(frame.style.top),340,120);
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());await act(async()=>host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'})));
 const target=resize?host.querySelector('.image-resize-grip')!:frame;
 await act(async()=>{pointer(target,'pointerdown',10,10);pointer(window,'pointermove',510,610);});assert.equal(requests.length,0);assert.ok(bodyRoot.querySelector('[data-object-drag-paper]'));
 await act(async()=>pointer(window,'pointerup',510,610));assert.equal(requests.length,1);const saved=parseTables(content())[0]!;
 if(resize){assert.equal(saved.data.columns.reduce((a,b)=>a+b,0),660);assert.equal(saved.data.rows.reduce((a,b)=>a+b,0),680);}
 else{assert.equal(saved.x,520);assert.equal(saved.y,630);assert.equal(saved.data.columns.reduce((a,b)=>a+b,0),160);}
 assert.equal(bodyRoot.querySelector('[data-object-drag-paper]'),null);
},serializeTable(parseTables(body)[0]!,{layout:'float',x:20,y:30})));

test('unequal table tracks stop independently at minima and remain reversible without changing merges',()=>{
 const table=parseTables(body)[0]!,original=mergeTable({...table.data,columns:[80,340],rows:[40,120]},{row:0,col:0},{row:1,col:0});
 const reduced=resizeTableTracks(original,210,80);assert.deepEqual(reduced.columns,[80,170]);assert.deepEqual(reduced.rows,[40,60]);assert.deepEqual(reduced.cells,original.cells);
 const heightOnly=resizeTableTracks(original,undefined,80);assert.deepEqual(heightOnly.columns,original.columns);assert.deepEqual(heightOnly.rows,[40,60]);
 const grown=resizeTableTracks(original,840,320);assert.deepEqual(grown.columns,[160,680]);assert.deepEqual(grown.rows,[80,240]);assert.ok(validTable(grown));
 assert.deepEqual(resizeTableTracks(original,420,160),original);
});
test('whole-table resize can shrink to every minimum and cancel without changing the original unequal tracks',()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());const grip=host.querySelector('.image-resize-grip')!;
 await act(async()=>{pointer(grip,'pointerdown',510,180);pointer(window,'pointermove',0,0);});
 assert.deepEqual([...host.querySelectorAll<HTMLElement>('.editable-table col')].map(col=>Number.parseFloat(col.style.width)),[80,80]);
 assert.deepEqual([...host.querySelectorAll<HTMLElement>('.editable-table tr')].map(row=>Number.parseFloat(row.style.height)),[40,40]);
 await act(async()=>pointer(window,'pointercancel',0,0));assert.equal(requests.length,0);assert.deepEqual(parseTables(content())[0]!.data.columns,[170,340]);
 assert.deepEqual([...host.querySelectorAll<HTMLElement>('.editable-table col')].map(col=>Number.parseFloat(col.style.width)),[170,340]);
},serializeTable(parseTables(body)[0]!,{data:{...parseTables(body)[0]!.data,columns:[170,340],rows:[60,120]}})));

for(const axis of ['rows','columns'] as const)test(`delete ${axis} preserves crossing merges, text outside the selection and track alignment`,()=>{
 const original=parseTables('| A | B | C |\n| --- | --- | --- |\n| D | E | F |\n| G | H | I |')[0]!;
 const data=mergeTable({...original.data,alignment:['left','right','center']},axis==='rows'?{row:0,col:0}:{row:0,col:0},axis==='rows'?{row:2,col:0}:{row:0,col:2});
 const a=axis==='rows'?{row:1,col:0}:{row:0,col:1},b=axis==='rows'?{row:1,col:2}:{row:2,col:1};
 const cleared=deleteTableSelection(data,a,b,axis);assert.equal(cleared[axis].length,3);assert.ok(validTable(cleared));
 const removed=deleteTableSelection(cleared,a,b,axis);assert.equal(removed[axis].length,2);assert.ok(validTable(removed));
 const merged=removed.cells.find(cell=>cell.row===0 && cell.col===0)!;assert.equal(merged[axis==='rows'?'rowSpan':'colSpan'],2);assert.equal(merged.text,'');
 assert.ok(removed.cells.some(cell=>cell.text==='I'));assert.deepEqual(removed.alignment,axis==='rows'?['left','right','center']:['left','center']);
 assert.deepEqual(parseTables(serializeTable(original,{data:removed}))[0]!.data,removed);
});
test('individual cells only clear; deleting all empty rows or columns retains a valid minimum table',()=>{
 const data=parseTables(body)[0]!.data,one=deleteTableSelection(data,{row:0,col:0},{row:0,col:0});assert.equal(one.cells[0]!.text,'');assert.equal(one.cells[1]!.text,'B');assert.deepEqual(one.columns,data.columns);assert.deepEqual(one.rows,data.rows);
 const empty=deleteTableSelection(data,{row:0,col:0},{row:1,col:1}),row=deleteTableSelection(empty,{row:0,col:0},{row:1,col:1},'rows');assert.equal(row.rows.length,1);assert.ok(validTable(row));
 const col=deleteTableSelection(row,{row:0,col:0},{row:0,col:1},'columns');assert.equal(col.columns.length,1);assert.ok(validTable(col));assert.ok(deleteTableSelection(col,{row:0,col:0},{row:0,col:0},'rows')===col);
});
test('Delete remains text editing inside a cell, and Escape then Delete clears only the selected cell',()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());const input=host.querySelector('textarea')!,event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Delete'});
 await act(async()=>input.dispatchEvent(event));assert.equal(event.defaultPrevented,false);assert.equal(requests.length,0);
 await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'})));const table=host.querySelector('.table-object')!;assert.ok(document.activeElement===table);
 await act(async()=>table.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Delete'})));assert.equal(requests.length,1);const data=parseTables(content())[0]!.data;assert.equal(data.cells[0]!.text,'');assert.equal(data.cells[1]!.text,'B');assert.equal(data.rows.length,2);
}));
test('physical border clicks select tracks without dragging; Shift extends whole-row selection',()=>interactive(async(host,_content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());await act(async()=>host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'})));
 const first=host.querySelector<HTMLElement>('[data-select-axis="rows"][data-track="0"]')!,last=host.querySelector<HTMLElement>('[data-select-axis="rows"][data-track="1"]')!;
 await act(async()=>{pointer(first,'pointerdown',1,20);pointer(window,'pointerup',1,20);first.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));});assert.equal(host.querySelectorAll('[data-cell-selected=true]').length,2);
 await act(async()=>last.dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true})));assert.equal(host.querySelectorAll('[data-cell-selected=true]').length,4);assert.equal(requests.length,0);assert.equal(host.querySelector('textarea'),null);assert.equal(host.dataset.leaked,undefined);
}));

for(const axis of ['rows','columns'] as const)test(`inline table ${axis} expansion keeps its computed top-left in free-wrapped text`,()=>interactive(async(host)=>{
 const block=host.querySelector<HTMLElement>('.table-flow-block')!;assert.equal(block.style.left,'0px');const top=block.style.top;
 const width=Number.parseFloat(block.style.width),height=Number.parseFloat(block.style.height);
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());await act(async()=>host.querySelectorAll<HTMLButtonElement>('.table-tool-buttons button')[axis==='rows'?2:3]!.click());
 assert.equal(block.style.left,'0px');assert.equal(block.style.top,top);
 if(axis==='rows'){assert.equal(Number.parseFloat(block.style.height),height+40);assert.equal(Number.parseFloat(block.style.width),width);}
 else{assert.equal(Number.parseFloat(block.style.width),width+80);assert.equal(Number.parseFloat(block.style.height),height);}
},'before '+serializeTable(parseTables(body)[0]!)+' after\n'+serializeTable(parseTables(body)[0]!,{name:'table_1',layout:'float',x:600,y:0})));
for(const axis of ['rows','columns'] as const)test(`free table ${axis} insertion preserves saved top-left coordinates`,()=>interactive(async(host,content)=>{
 const frame=host.querySelector<HTMLElement>('[data-object-type="table"]')!;await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());await act(async()=>host.querySelectorAll<HTMLButtonElement>('.table-tool-buttons button')[axis==='rows'?2:3]!.click());
 const table=parseTables(content())[0]!;assert.equal(table.x,80);assert.equal(table.y,90);assert.equal(frame.style.left,'80px');assert.equal(frame.style.top,'90px');assert.equal(table.layout,'float');
},serializeTable(parseTables(body)[0]!,{layout:'float',x:80,y:90})));

test('fold state round-trips independently per table and survives reopen, share and undo',async()=>{
 const table=parseTables(body)[0]!,folded=serializeTable(table,{collapsed:true,layout:'float',x:80,y:90,layer:2}),expanded=serializeTable(table,{name:'table_1'});
 const fs=createMemoryFs(),session=openSession('/folded',{ops:fs.ops}),id=createCard(session,{parentId:null,content:folded+'\n'+expanded});
 const parsed=parseTables(session.state.cards.get(id)!.content);assert.ok(parsed[0]!.collapsed);assert.ok(!parsed[1]!.collapsed);assert.deepEqual(parsed[0]!.data,table.data);assert.equal(parsed[0]!.x,80);assert.equal(parsed[0]!.y,90);
 assert.ok(parseTables(openSession('/folded',{ops:fs.ops}).state.cards.get(id)!.content)[0]!.collapsed);
 const pkg=parseSharePackage(buildSharePackage(session.state,id,new Map())),destination=openSession('/folded-target',{ops:createMemoryFs().ops}),result=importSharePackage(destination,pkg,null);assert.ok(parseTables(destination.state.cards.get(result.rootId)!.content)[0]!.collapsed);
 const before=session.state.cards.get(id)!.content;executeAction(session,{kind:'edit',id,field:'content',before,value:serializeTable(parsed[0]!,{collapsed:false})+'\n'+expanded});assert.ok(!parseTables(session.state.cards.get(id)!.content)[0]!.collapsed);
 executeAction(session,{kind:'undo'});assert.ok(parseTables(session.state.cards.get(id)!.content)[0]!.collapsed);
 assert.equal(parseTables(folded.replace('collapsed="true"','collapsed="maybe"')).length,0);
});
test('folded read-only previews can expand without changing the stored body',async()=>{
 const text=serializeTable(parseTables(body)[0]!,{collapsed:true}),host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{await act(async()=>root.render(createElement(Markdown,{text})));const label=host.querySelector<HTMLButtonElement>('.table-collapsed-label')!;assert.ok(label);assert.equal(host.querySelector('.editable-table'),null);await act(async()=>label.click());assert.ok(host.querySelector('.editable-table'));assert.ok(parseTables(text)[0]!.collapsed);}finally{await act(async()=>root.unmount());host.remove();}
});

test('folding saves a pending cell draft before remembering the collapsed state',()=>interactive(async(host,content,requests)=>{
 await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());const input=host.querySelector<HTMLTextAreaElement>('textarea')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'saved draft');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>host.querySelector<HTMLButtonElement>('.table-collapse')!.click());const table=parseTables(content())[0]!;assert.ok(table.collapsed);assert.equal(table.data.cells[0]!.text,'saved draft');assert.equal(requests.length,2);
}));
test('a rejected fold save keeps the table visible and reports the failure',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{await act(async()=>root.render(createElement(Markdown,{text:body,id:'card',send:async()=>{throw new Error('blocked');}})));await act(async()=>host.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.click());await act(async()=>host.querySelector<HTMLButtonElement>('.table-collapse')!.click());assert.ok(host.querySelector('.editable-table'));assert.equal(host.querySelector('.table-collapsed-label'),null);assert.match(host.querySelector('[role=alert]')!.textContent!,/blocked/);}finally{await act(async()=>root.unmount());host.remove();}
});
