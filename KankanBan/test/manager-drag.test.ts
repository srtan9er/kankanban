import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {useManagerDrag} from '../src/webview/useManagerDrag.ts';

type Command={command:string;args:Record<string,unknown>};
type Hit='textarea'|'source'|'button'|'text';
function pointer(target:EventTarget,type:string,button:number,x:number,y:number,buttons=type==='pointerup'?0:button===2?2:1){const event=new MouseEvent(type,{bubbles:true,cancelable:true,button,buttons,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);}
async function fixture(hit:Hit,active:boolean,run:(f:{target:HTMLElement;shell:HTMLElement;commands:Command[];errors:string[];mouse:(x:number,y:number)=>void;frame:()=>Promise<void>})=>Promise<void>){
 const globalRecord=globalThis as unknown as Record<string,unknown>,windowRecord=window as unknown as Record<string,unknown>,previousGlobal=globalRecord.__TAURI_INTERNALS__,previousWindow=windowRecord.__TAURI_INTERNALS__,previousRaf=globalRecord.requestAnimationFrame,previousCancel=globalRecord.cancelAnimationFrame,previousCustom=globalRecord.CustomEvent;
 const commands:Command[]=[],errors:string[]=[],frames=new Map<number,FrameRequestCallback>();let nextFrame=0,mouse={x:500,y:600};
 const native={metadata:{currentWindow:{label:'main'}},invoke:async(command:string,args:Record<string,unknown>={})=>{
  commands.push({command,args});if(command==='plugin:window|cursor_position')return {...mouse};if(command==='plugin:window|outer_position')return {x:100,y:200};if(command==='drag_mouse_buttons')return null;if(command==='move_note')return null;throw new Error(`Unexpected command: ${command}`);
 }};
 globalRecord.__TAURI_INTERNALS__=native;windowRecord.__TAURI_INTERNALS__=native;globalRecord.CustomEvent=window.CustomEvent;globalRecord.requestAnimationFrame=(fn:FrameRequestCallback)=>{const id=++nextFrame;frames.set(id,fn);return id;};globalRecord.cancelAnimationFrame=(id:number)=>frames.delete(id);
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 function Harness(){const drag=useManagerDrag(true,error=>errors.push(error)),props={className:'drag-hit',onPointerDown:(event:{stopPropagation:()=>void})=>event.stopPropagation()};
  const content=hit==='textarea'?createElement('textarea',{...props,defaultValue:'Editing cell'}):hit==='source'?createElement('div',{...props,'data-markdown-editor':'true',contentEditable:true,suppressContentEditableWarning:true},'Source'):hit==='button'?createElement('button',props,'Tool'):createElement('span',{...props,className:'drag-hit rich-image-text'},'Body text');
  return createElement('div',{className:'manager-shell',onPointerDownCapture:drag,onPointerMoveCapture:drag},createElement('section',{className:'ordinary-document'},createElement('div',{className:'card-regions'},createElement('div',{className:'card-body-editor','data-body-editing':active},content))));
 }
 try{
  await act(async()=>root.render(createElement(Harness)));const shell=host.querySelector<HTMLElement>('.manager-shell')!,captured=new Set<number>();shell.setPointerCapture=id=>{captured.add(id);};shell.hasPointerCapture=id=>captured.has(id);shell.releasePointerCapture=id=>{captured.delete(id);};
  const frame=async()=>act(async()=>{const current=[...frames.values()];frames.clear();for(const callback of current)callback(0);await new Promise<void>(resolve=>setTimeout(resolve,0));});
  await run({target:host.querySelector<HTMLElement>('.drag-hit')!,shell,commands,errors,mouse:(x,y)=>{mouse={x,y};},frame});
 }finally{
  await act(async()=>root.unmount());host.remove();document.documentElement.classList.remove('card-dragging');
  for(const [record,key,value] of [[globalRecord,'__TAURI_INTERNALS__',previousGlobal],[windowRecord,'__TAURI_INTERNALS__',previousWindow],[globalRecord,'requestAnimationFrame',previousRaf],[globalRecord,'cancelAnimationFrame',previousCancel],[globalRecord,'CustomEvent',previousCustom]] as const){if(value===undefined)delete record[key];else record[key]=value;}
 }
}

for(const hit of ['textarea','source','button'] as const)test(`manager right drag starts from an active ${hit} through capture and moves only after six pixels`,()=>fixture(hit,true,async f=>{
 await act(async()=>pointer(f.target,'pointerdown',2,10,10));await act(async()=>pointer(document,'pointermove',2,15,10));await f.frame();assert.equal(f.commands.filter(call=>call.command==='move_note').length,0);
 f.mouse(520,630);await act(async()=>pointer(document,'pointermove',2,16,10));await f.frame();const moves=f.commands.filter(call=>call.command==='move_note');assert.equal(moves.length,1,'right press must reach the manager capture despite an interactive target');assert.deepEqual(moves[0]!.args,{x:120,y:230,finish:false});assert.equal(document.documentElement.classList.contains('card-dragging'),true);
 await act(async()=>pointer(window,'pointerup',2,16,10));await f.frame();assert.equal(f.commands.filter(call=>call.command==='move_note'&&call.args.finish===true).length,1);assert.equal(document.documentElement.classList.contains('card-dragging'),false);assert.deepEqual(f.errors,[]);
}));
test('manager left drag can move an idle ordinary body without changing its input state',()=>fixture('text',false,async f=>{
 await act(async()=>pointer(f.target,'pointerdown',0,10,10));await act(async()=>pointer(document,'pointermove',0,15,10));await f.frame();assert.equal(f.commands.some(call=>call.command==='move_note'),false);
 f.mouse(530,640);await act(async()=>pointer(document,'pointermove',0,16,10));await f.frame();const moves=f.commands.filter(call=>call.command==='move_note');assert.equal(moves.length,1);assert.deepEqual(moves[0]!.args,{x:130,y:240,finish:false});assert.equal(f.target.closest<HTMLElement>('.card-body-editor')!.dataset.bodyEditing,'false');await act(async()=>pointer(window,'pointerup',0,16,10));await f.frame();assert.deepEqual(f.errors,[]);
}));
test('manager left drag leaves an active body to native text selection',()=>fixture('text',true,async f=>{
 await act(async()=>{pointer(f.target,'pointerdown',0,10,10);pointer(document,'pointermove',0,40,50);pointer(window,'pointerup',0,40,50);});await f.frame();assert.equal(f.commands.some(call=>call.command==='move_note'),false);assert.equal(document.documentElement.classList.contains('card-dragging'),false);assert.deepEqual(f.errors,[]);
}));
test('a right chord can arm from pointermove without restarting when left joins the same pointer',()=>fixture('source',true,async f=>{
 await act(async()=>pointer(f.target,'pointermove',2,10,10,3));await f.frame();assert.equal(f.commands.filter(call=>call.command==='move_note').length,0);
 f.mouse(520,630);await act(async()=>pointer(f.target,'pointermove',-1,16,10,3));await f.frame();assert.deepEqual(f.commands.filter(call=>call.command==='move_note').map(call=>call.args),[{x:120,y:230,finish:false}]);
 f.mouse(540,650);await act(async()=>pointer(f.target,'pointermove',0,20,10,3));await f.frame();assert.equal(f.commands.filter(call=>call.command==='plugin:window|outer_position').length,1,'the same pointer retains its original window origin');assert.deepEqual(f.commands.filter(call=>call.command==='move_note').map(call=>call.args),[{x:120,y:230,finish:false},{x:140,y:250,finish:false}]);
 await act(async()=>pointer(window,'pointerup',0,20,10,2));await f.frame();assert.equal(f.commands.filter(call=>call.command==='move_note'&&call.args.finish===true).length,0,'an ordinary right drag continues when only the left button releases');
 await act(async()=>pointer(window,'pointerup',2,20,10,0));await f.frame();assert.equal(f.commands.filter(call=>call.command==='move_note'&&call.args.finish===true).length,1);assert.equal(document.documentElement.classList.contains('card-dragging'),false);assert.deepEqual(f.errors,[]);
}));
