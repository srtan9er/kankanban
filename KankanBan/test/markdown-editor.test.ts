import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {markdownEditorParts,getMarkdownEditorRange,getMarkdownEditorSelection,normalizeMarkdownEditorSelection,readMarkdownEditor,renderMarkdownEditor,setMarkdownEditorSelection} from '../src/webview/markdown-editor-model.ts';
import {MarkdownEditor,type MarkdownEditorProps} from '../src/webview/MarkdownEditor.tsx';
import * as markdownEditorApi from '../src/webview/MarkdownEditor.tsx';
import {act,createElement,useState} from 'react';
import {createRoot} from 'react-dom/client';
const assetId='a'.repeat(64)+'.png',tag=`<image src="../assets/images/${assetId}" layout="float" width="160" x="40">a caption</image>`;
test('only valid controlled image tags become atomic editor parts, preserving original source',()=>{
 const value=`before ${tag} after\n![normal](../assets/images/${assetId})\n\`\`\`html\n${tag}\n\`\`\``,parts=markdownEditorParts(value);
 assert.equal(parts.filter(part=>part.atomic).length,1);assert.equal(parts.find(part=>part.atomic)!.text,tag);assert.equal(parts.map(part=>part.text).join(''),value);
});
test('editor numbering follows all local references while folding only controlled tags outside code',()=>{
 const md=`![normal](../assets/images/${assetId})`,value=`${md}\n${tag}\n\`\`\`html\n${tag}\n\`\`\`\n${md}\n${tag}`;
 const parts=markdownEditorParts(value),atoms=parts.filter(part=>part.atomic);assert.deepEqual(atoms.map(part=>(part as {index?:number}).index),[1,3]);assert.equal(parts.map(part=>part.text).join(''),value);
});

async function fixture(value:string,run:(editor:HTMLDivElement,changes:string[],rerender:(value:string)=>Promise<void>)=>Promise<void>,props:Partial<MarkdownEditorProps>={}){
 const host=document.createElement('div'),root=createRoot(host),changes:string[]=[];document.body.append(host);
 const Harness=({initial}:{initial:string})=>{const [text,setText]=useState(initial);return createElement(MarkdownEditor,{value:text,onChange:next=>{changes.push(next);setText(next);},...props});};
 try{await act(async()=>root.render(createElement(Harness,{initial:value})));const editor=host.querySelector<HTMLDivElement>('[data-markdown-editor]')!;editor.focus();await run(editor,changes,async next=>{await act(async()=>root.render(createElement(MarkdownEditor,{value:next,onChange:text=>changes.push(text),...props})));});}
 finally{await act(async()=>root.unmount());host.remove();}
}
function clipboard(editor:HTMLDivElement,type:string,data:Record<string,string>={}){const result={...data},event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:(format:string)=>result[format] ?? '',setData:(format:string,value:string)=>{result[format]=value;}}});editor.dispatchEvent(event);return result;}

test('editor shows emphasized atomic labels and source offsets count the full hidden token',()=>fixture('before '+tag+' after',async editor=>{
 const atom=editor.querySelector<HTMLElement>('[data-markdown-token]')!;assert.equal(atom.textContent,'<image_0>');assert.equal(atom.getAttribute('contenteditable'),'false');assert.equal(atom.getAttribute('data-markdown-token'),tag);assert.equal(editor.querySelector('image'),null);assert.equal(readMarkdownEditor(editor),'before '+tag+' after');
 setMarkdownEditorSelection(editor,7+tag.length);assert.deepEqual(getMarkdownEditorSelection(editor),{beforeContent:'before '+tag+' after',offset:7+tag.length});
}));
test('deleting an earlier Markdown image renumbers atomic labels without changing source tags, and undo restores the numbering',()=>fixture(`![normal](../assets/images/${assetId})\n${tag}\n${tag}`,async editor=>{
 assert.deepEqual([...editor.querySelectorAll('[data-markdown-token]')].map(atom=>atom.textContent),['<image_1>','<image_2>']);
 const prefix=editor.firstChild as Text;prefix.deleteData(0,prefix.length);setMarkdownEditorSelection(editor,0);await act(async()=>editor.dispatchEvent(new Event('input',{bubbles:true})));
 assert.deepEqual([...editor.querySelectorAll('[data-markdown-token]')].map(atom=>atom.textContent),['<image_0>','<image_1>']);assert.equal(readMarkdownEditor(editor),tag+'\n'+tag);
 await act(async()=>shortcut(editor,'z'));assert.deepEqual([...editor.querySelectorAll('[data-markdown-token]')].map(atom=>atom.textContent),['<image_1>','<image_2>']);
}));
test('partial token selection expands to the whole field and copy retains every original attribute',()=>fixture('before '+tag+' after',async editor=>{
 const label=editor.querySelector('[data-markdown-token]')!.firstChild!,range=document.createRange();range.setStart(label,2);range.setEnd(label,3);const selection=document.getSelection()!;selection.removeAllRanges();selection.addRange(range);
 document.dispatchEvent(new Event('selectionchange'));const expanded=getMarkdownEditorRange(editor);assert.equal(expanded.start,7);assert.equal(expanded.end,7+tag.length);
 let copied:Record<string,string>={};await act(async()=>{copied=clipboard(editor,'copy');});assert.equal(copied['text/plain'],tag);assert.equal(readMarkdownEditor(editor),'before '+tag+' after');
}));
test('cut and Backspace remove a complete token without retaining a broken path',async()=>{
 await fixture('before '+tag+' after',async(editor,changes)=>{setMarkdownEditorSelection(editor,7,7+tag.length);let cut:Record<string,string>={};await act(async()=>{cut=clipboard(editor,'cut');});assert.equal(cut['text/plain'],tag);assert.equal(changes.at(-1),'before  after');assert.equal(editor.querySelector('[data-markdown-token]'),null);});
 await fixture('before '+tag+' after',async(editor,changes)=>{setMarkdownEditorSelection(editor,7+tag.length);await act(async()=>editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true})));assert.equal(changes.at(-1),'before  after');assert.equal(getMarkdownEditorSelection(editor).offset,7);});
});
test('normal input keeps existing text nodes and caret while emitting complete Markdown',()=>fixture('before '+tag+' after',async(editor,changes)=>{
 const first=editor.firstChild as Text;first.insertData(3,'X');setMarkdownEditorSelection(editor,4);await act(async()=>editor.dispatchEvent(new Event('input',{bubbles:true})));
 assert.equal(editor.firstChild,first);assert.equal(document.getSelection()!.anchorNode,first);assert.equal(document.getSelection()!.anchorOffset,4);assert.equal(changes.at(-1),'befXore '+tag+' after');
}));
test('Enter and plain paste keep newlines, sanitize HTML and fold only valid pasted tokens',()=>fixture('start',async(editor,changes)=>{
 setMarkdownEditorSelection(editor,5);await act(async()=>editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));assert.equal(changes.at(-1),'start\n');
 await act(async()=>clipboard(editor,'paste',{'text/plain':tag+'\r\nnext','text/html':'<img src="https://evil.test/x"><script>bad()</script>'}));
 const named=tag.replace('layout="float"','layout="float" name="image_0"');assert.equal(changes.at(-1),'start\n'+named+'\nnext');assert.equal(editor.querySelectorAll('[data-markdown-token]').length,1);assert.equal(editor.querySelector('img,script'),null);assert.equal(getMarkdownEditorSelection(editor).offset,('start\n'+named+'\nnext').length);
}));
test('one Enter exposes a caret line immediately without adding a second source newline',()=>fixture('start',async(editor,changes)=>{
 setMarkdownEditorSelection(editor,5);await act(async()=>editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
 assert.equal(changes.at(-1),'start\n');assert.equal(readMarkdownEditor(editor),'start\n');assert.equal(getMarkdownEditorSelection(editor).offset,6);
 const tail=editor.lastChild;assert.ok(tail instanceof HTMLElement && tail.tagName==='BR','a terminal source newline needs a visible empty caret line');
 assert.equal(tail.getAttribute('data-markdown-caret-tail'),'true');
 await act(async()=>clipboard(editor,'paste',{'text/plain':'next'}));assert.equal(readMarkdownEditor(editor),'start\nnext');assert.equal(editor.querySelector('[data-markdown-caret-tail]'),null);
 await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),'start\n');assert.equal(editor.lastElementChild?.getAttribute('data-markdown-caret-tail'),'true');
}));
test('caret-only trailing breaks never change source offsets or atomic image selection',()=>{
 const editor=document.createElement('div');document.body.append(editor);
 try{for(const value of ['\n','first\n','first\n\n',tag+'\n']){
  renderMarkdownEditor(editor,value);assert.equal(readMarkdownEditor(editor),value);assert.equal(editor.querySelectorAll('br[data-markdown-caret-tail]').length,1);
  setMarkdownEditorSelection(editor,value.length);assert.equal(getMarkdownEditorSelection(editor).offset,value.length);
  if(value.startsWith(tag)){setMarkdownEditorSelection(editor,0,tag.length);assert.deepEqual(getMarkdownEditorRange(editor),{start:0,end:tag.length,backward:false,inside:true});}
 }}finally{editor.remove();}
});
test('ordinary typing and deleting the final newline reconcile only the caret placeholder',()=>fixture('start\n',async(editor,changes)=>{
 const text=editor.firstChild as Text;text.appendData('next');setMarkdownEditorSelection(editor,10);await act(async()=>editor.dispatchEvent(new Event('input',{bubbles:true})));
 assert.equal(changes.at(-1),'start\nnext');assert.equal(getMarkdownEditorSelection(editor).offset,10);assert.equal(editor.querySelector('[data-markdown-caret-tail]'),null);
 const typed=editor.firstChild as Text;typed.deleteData(5,5);setMarkdownEditorSelection(editor,5);await act(async()=>editor.dispatchEvent(new Event('input',{bubbles:true})));
 assert.equal(changes.at(-1),'start');assert.equal(readMarkdownEditor(editor),'start');assert.equal(editor.querySelector('[data-markdown-caret-tail]'),null);
}));
test('external values preserve focused source selection, and parent shortcuts/paste intercept first',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);const props={onChange:()=>undefined};
 try{await act(async()=>root.render(createElement(MarkdownEditor,{value:'before '+tag+' after',...props})));const editor=host.querySelector<HTMLDivElement>('[data-markdown-editor]')!;editor.focus();setMarkdownEditorSelection(editor,7+tag.length,9+tag.length);
 await act(async()=>root.render(createElement(MarkdownEditor,{value:'before '+tag+' after updated',...props})));assert.equal(document.activeElement,editor);assert.deepEqual({...getMarkdownEditorRange(editor),inside:true},{start:7+tag.length,end:9+tag.length,backward:false,inside:true});
 const longer=tag.replace('width="160"','width="1600"');await act(async()=>root.render(createElement(MarkdownEditor,{value:'before '+longer+' after updated',...props})));assert.deepEqual(getMarkdownEditorRange(editor),{start:7+longer.length,end:9+longer.length,backward:false,inside:true});
 }finally{await act(async()=>root.unmount());host.remove();}
 let keys=0,pastes=0;await fixture('text',async(editor,changes)=>{setMarkdownEditorSelection(editor,4);await act(async()=>{editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));clipboard(editor,'paste',{'text/plain':'ignored'});});assert.equal(changes.length,0);assert.equal(keys,1);assert.equal(pastes,1);},{onKeyDown:event=>{keys++;event.preventDefault();},onPaste:event=>{pastes++;event.preventDefault();}});
});
test('collapsed label caret becomes whole-field selection and backward selections survive updates',()=>fixture('before '+tag+' after',async editor=>{
 const label=editor.querySelector('[data-markdown-token]')!.firstChild!,range=document.createRange();range.setStart(label,3);range.collapse(true);const selection=document.getSelection()!;selection.removeAllRanges();selection.addRange(range);assert.equal(normalizeMarkdownEditorSelection(editor),true);assert.deepEqual(getMarkdownEditorRange(editor),{start:7,end:7+tag.length,inside:true,backward:false});
 setMarkdownEditorSelection(editor,7,7+tag.length,true);assert.equal(getMarkdownEditorRange(editor).backward,true);
}));
test('Delete at the front edge removes the token, while disabled paste and cut cannot modify it',async()=>{
 await fixture('before '+tag+' after',async(editor,changes)=>{setMarkdownEditorSelection(editor,7);await act(async()=>editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true})));assert.equal(changes.at(-1),'before  after');assert.equal(getMarkdownEditorSelection(editor).offset,7);});
 await fixture(tag,async(editor,changes)=>{setMarkdownEditorSelection(editor,0,tag.length);let copied:Record<string,string>={};await act(async()=>{clipboard(editor,'paste',{'text/plain':'bad'});copied=clipboard(editor,'cut');});assert.equal(changes.length,0);assert.equal(copied['text/plain'],tag);assert.equal(readMarkdownEditor(editor),tag);},{disabled:true});
});
test('browser-created paragraph and BR nodes serialize as ordinary newlines',()=>{
 const editor=document.createElement('div'),a=document.createElement('div'),b=document.createElement('div');a.textContent='first';b.textContent='second';editor.append(a,b);assert.equal(readMarkdownEditor(editor),'first\nsecond');const br=document.createElement('br');b.append(br,document.createTextNode('third'));assert.equal(readMarkdownEditor(editor),'first\nsecond\nthird');
});
function shortcut(editor:HTMLDivElement,key:string,shiftKey=false):KeyboardEvent{const event=new KeyboardEvent('keydown',{key,ctrlKey:true,shiftKey,bubbles:true,cancelable:true});editor.dispatchEvent(event);return event;}
test('local undo/redo restore Enter and a cut atomic image without invoking global undo',async()=>{
 await fixture('before '+tag+' after',async(editor,changes)=>{setMarkdownEditorSelection(editor,7,7+tag.length);await act(async()=>clipboard(editor,'cut'));assert.equal(changes.at(-1),'before  after');let globalUndo=0;const global=()=>globalUndo++;window.addEventListener('keydown',global);
 try{await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),'before '+tag+' after');assert.equal(editor.querySelector('[data-markdown-token]')!.getAttribute('data-markdown-token'),tag);assert.deepEqual(getMarkdownEditorRange(editor),{start:7,end:7+tag.length,backward:false,inside:true});assert.equal(globalUndo,0);
 await act(async()=>shortcut(editor,'z',true));assert.equal(readMarkdownEditor(editor),'before  after');assert.equal(globalUndo,0);
 }finally{window.removeEventListener('keydown',global);}
 });
 await fixture('start',async editor=>{setMarkdownEditorSelection(editor,5);await act(async()=>editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));assert.equal(readMarkdownEditor(editor),'start\n');await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),'start');assert.equal(getMarkdownEditorSelection(editor).offset,5);await act(async()=>shortcut(editor,'y'));assert.equal(readMarkdownEditor(editor),'start\n');});
});
test('ordinary typing is undoable with its source caret, while disabled editors ignore local history',()=>fixture('before '+tag+' after',async editor=>{
 setMarkdownEditorSelection(editor,3);editor.dispatchEvent(new Event('beforeinput',{bubbles:true,cancelable:true}));(editor.firstChild as Text).insertData(3,'X');setMarkdownEditorSelection(editor,4);await act(async()=>editor.dispatchEvent(new Event('input',{bubbles:true})));await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),'before '+tag+' after');assert.equal(getMarkdownEditorSelection(editor).offset,3);await act(async()=>shortcut(editor,'y'));assert.equal(readMarkdownEditor(editor),'befXore '+tag+' after');assert.equal(getMarkdownEditorSelection(editor).offset,4);
}));
test('new edits discard redo and an IME composition is undone as one complete source change',async()=>{
 await fixture('a',async editor=>{setMarkdownEditorSelection(editor,1);await act(async()=>clipboard(editor,'paste',{'text/plain':'b'}));await act(async()=>clipboard(editor,'paste',{'text/plain':'c'}));await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),'ab');await act(async()=>clipboard(editor,'paste',{'text/plain':'X'}));await act(async()=>shortcut(editor,'y'));assert.equal(readMarkdownEditor(editor),'abX');});
 await fixture('a',async editor=>{setMarkdownEditorSelection(editor,1);await act(async()=>editor.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true})));(editor.firstChild as Text).appendData('你');setMarkdownEditorSelection(editor,2);await act(async()=>editor.dispatchEvent(new Event('input',{bubbles:true})));(editor.firstChild as Text).appendData('好');setMarkdownEditorSelection(editor,3);await act(async()=>editor.dispatchEvent(new Event('input',{bubbles:true})));await act(async()=>editor.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true,data:'你好'})));await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),'a');assert.equal(getMarkdownEditorSelection(editor).offset,1);await act(async()=>shortcut(editor,'y'));assert.equal(readMarkdownEditor(editor),'a你好');});
});
test('true external source changes reset history; disabled history keys cannot leak into core undo',async()=>{
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);let value='a',disabled=false;const render=()=>root.render(createElement(MarkdownEditor,{value,disabled,onChange:next=>{value=next;render();}}));
 try{await act(async()=>render());const editor=host.querySelector<HTMLDivElement>('[data-markdown-editor]')!;editor.focus();setMarkdownEditorSelection(editor,1);await act(async()=>clipboard(editor,'paste',{'text/plain':'b'}));value='external';await act(async()=>render());await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),'external');
 setMarkdownEditorSelection(editor,value.length);await act(async()=>clipboard(editor,'paste',{'text/plain':' edit'}));disabled=true;await act(async()=>render());let core=0;const global=()=>core++;window.addEventListener('keydown',global);try{await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),'external edit');assert.equal(core,0);}finally{window.removeEventListener('keydown',global);}
 }finally{await act(async()=>root.unmount());host.remove();}
});
test('copy-pasting a named image retains the original name, names the copy and undoes as one step',()=>fixture(tag.replace('layout="float"','layout="float" name="image_7"'),async(editor)=>{
 const named=readMarkdownEditor(editor);setMarkdownEditorSelection(editor,0);await act(async()=>clipboard(editor,'paste',{'text/plain':named+'\n'}));assert.deepEqual([...editor.querySelectorAll('[data-markdown-token]')].map(atom=>atom.textContent),['<image_8>','<image_7>']);
 await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),named);assert.equal(editor.querySelector('[data-markdown-token]')!.textContent,'<image_7>');
}));

test('source formatting shortcuts wrap and toggle selected text using local history',async()=>{
 for(const {key,shift,mark} of [{key:'b',shift:false,mark:'**'},{key:'i',shift:false,mark:'*'},{key:'x',shift:true,mark:'~~'}])await fixture('before text after',async editor=>{
  setMarkdownEditorSelection(editor,7,11);await act(async()=>shortcut(editor,key,shift));assert.equal(readMarkdownEditor(editor),`before ${mark}text${mark} after`);
  assert.deepEqual(getMarkdownEditorRange(editor),{start:7+mark.length,end:11+mark.length,backward:false,inside:true});
  await act(async()=>shortcut(editor,key,shift));assert.equal(readMarkdownEditor(editor),'before text after');
  await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),`before ${mark}text${mark} after`);
  await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),'before text after');assert.deepEqual(getMarkdownEditorRange(editor),{start:7,end:11,backward:false,inside:true});
 });
});
test('empty selection inserts paired formatting with a middle caret and italic toggling preserves bold',async()=>{
 await fixture('word',async editor=>{setMarkdownEditorSelection(editor,2);await act(async()=>shortcut(editor,'b'));assert.equal(readMarkdownEditor(editor),'wo****rd');assert.equal(getMarkdownEditorSelection(editor).offset,4);await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),'word');assert.equal(getMarkdownEditorSelection(editor).offset,2);});
 await fixture('**word**',async editor=>{setMarkdownEditorSelection(editor,2,6);await act(async()=>shortcut(editor,'i'));assert.equal(readMarkdownEditor(editor),'***word***');await act(async()=>shortcut(editor,'i'));assert.equal(readMarkdownEditor(editor),'**word**');});
});
test('public source insertion uses the selected position and the same naming and undo transaction',()=>fixture('before after',async editor=>{
 assert.equal(typeof markdownEditorApi.insertMarkdownEditorMarkup,'function','source insertion API must be exported');
 setMarkdownEditorSelection(editor,7);let inserted=false;await act(async()=>{inserted=markdownEditorApi.insertMarkdownEditorMarkup(editor,tag);});assert.equal(inserted,true);
 const named=tag.replace('layout="float"','layout="float" name="image_0"');assert.equal(readMarkdownEditor(editor),'before '+named+'after');assert.equal(getMarkdownEditorSelection(editor).offset,7+named.length);
 await act(async()=>shortcut(editor,'z'));assert.equal(readMarkdownEditor(editor),'before after');assert.equal(getMarkdownEditorSelection(editor).offset,7);
}));
test('source insertion rejects disabled, composing and unmounted editors, and parent handlers still run first',async()=>{
 assert.equal(typeof markdownEditorApi.insertMarkdownEditorMarkup,'function','source insertion API must be exported');
 await fixture('text',async(editor,changes)=>{setMarkdownEditorSelection(editor,0,4);await act(async()=>{assert.equal(markdownEditorApi.insertMarkdownEditorMarkup(editor,'bad'),false);shortcut(editor,'b');});assert.equal(changes.length,0);assert.equal(readMarkdownEditor(editor),'text');},{disabled:true});
 await fixture('text',async(editor,changes)=>{setMarkdownEditorSelection(editor,2);await act(async()=>editor.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true})));assert.equal(markdownEditorApi.insertMarkdownEditorMarkup(editor,'bad'),false);assert.equal(changes.length,0);});
 await fixture('text',async(editor,changes)=>{setMarkdownEditorSelection(editor,0,4);await act(async()=>shortcut(editor,'b'));assert.equal(changes.length,0);assert.equal(readMarkdownEditor(editor),'text');},{onKeyDown:event=>event.preventDefault()});
 assert.equal(markdownEditorApi.insertMarkdownEditorMarkup(document.createElement('div'),'bad'),false);
});
