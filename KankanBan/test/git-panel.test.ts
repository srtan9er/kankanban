import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {ExtensionWindow} from '../src/webview/ExtensionWindow.tsx';
import {WorkspaceController,type Request} from '../src/webview/controller.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession} from '../src/core/workspace.ts';
import {emptyViewState} from '../src/core/view-state.ts';
import {uiText} from '../src/i18n/text.ts';
import {GitPanel} from '../src/webview/GitPanel.tsx';

test('development-source repository explains blocked worktree writes while keeping stage controls available',async()=>{
 const buffer=createBufferedFs(),c=new WorkspaceController(openSession('/source-ui',{ops:buffer.ops}),emptyViewState(),buffer,toAsync(createMemoryFs().ops)),host=document.createElement('div'),root=createRoot(host);let next=0;const jobs=new Map<number,unknown>();
 const send=async(r:Request):Promise<{createdId?:string;toolResult?:unknown}>=>{if(r.kind==='extension-invoke'){jobs.set(++next,r.method==='status'?{repository:true,developmentSource:true,root:'/source',branch:'main',refs:['main','feature'],files:[{path:'file.txt',index:' ',worktree:'M',original:null,conflict:false}]}:r.method==='graph'?{commits:[],nextOffset:null}:{text:'patch'});return {toolResult:{jobId:next}};}if(r.kind==='extension-job')return {toolResult:{state:'done',result:jobs.get(r.jobId)}};return {};};
 try{await act(async()=>root.render(createElement(GitPanel,{controller:c,send})));assert.ok(host.querySelector('.git-dev-warning')?.textContent?.includes(uiText('git.developmentSourceWarning')));await act(async()=>host.querySelector<HTMLButtonElement>('[data-git-trigger=branch]')!.click());const switchButton=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===uiText('git.switchBranch'))!;assert.equal(switchButton.disabled,true);assert.equal(switchButton.title,uiText('git.developmentSourceWarning'));
  await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.git-tabs button')].find(b=>b.textContent?.includes(uiText('git.changes')))!.click());assert.equal(host.querySelector<HTMLInputElement>('.git-file-row input')!.disabled,false);await act(async()=>host.querySelector<HTMLButtonElement>('.git-file-row button')!.click());const actions=[...host.querySelectorAll<HTMLButtonElement>('.git-changes-workspace button')];assert.equal(actions.find(b=>b.textContent===uiText('git.discard'))!.disabled,true);assert.equal(actions.find(b=>b.textContent===uiText('git.stage'))!.disabled,false);
 }finally{await act(async()=>root.unmount());}
});

test('stage and unstage refresh the selected diff and discard clears vanished file actions',async()=>{
 const buffer=createBufferedFs(),c=new WorkspaceController(openSession('/files-ui',{ops:buffer.ops}),emptyViewState(),buffer,toAsync(createMemoryFs().ops)),host=document.createElement('div'),root=createRoot(host);let staged=false,present=true,next=0;const jobs=new Map<number,unknown>(),confirm=window.confirm;window.confirm=()=>true;
 const send=async(r:Request):Promise<{createdId?:string;toolResult?:unknown}>=>{
  if(r.kind==='extension-invoke'){if(r.method==='stage')staged=true;if(r.method==='unstage')staged=false;if(r.method==='discard')present=false;const result=r.method==='status'?{repository:true,root:'/repo',branch:'main',refs:['main'],files:present?[{path:'note.txt',original:null,index:staged?'M':' ',worktree:staged?' ':'M',conflict:false}]:[]}:r.method==='graph'?{commits:[],nextOffset:null}:r.method==='diff'?{text:r.args.staged?'staged patch':'working patch'}:{};jobs.set(++next,result);return {toolResult:{jobId:next}};}
  if(r.kind==='extension-job')return {toolResult:{state:'done',result:jobs.get(r.jobId)}};return {};
 };
 const action=(label:string)=>[...host.querySelectorAll<HTMLButtonElement>('.git-changes-workspace button')].find(b=>b.textContent===label);
 try{
  await act(async()=>root.render(createElement(GitPanel,{controller:c,send})));await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.git-tabs button')].find(b=>b.textContent?.includes(uiText('git.changes')))!.click());await act(async()=>host.querySelector<HTMLButtonElement>('.git-file-row button')!.click());assert.ok(host.textContent?.includes('working patch'));
  await act(async()=>host.querySelector<HTMLInputElement>('.git-file-row input')!.click());assert.ok(action(uiText('git.unstage')),'selected file must follow its new staged state');assert.ok(host.textContent?.includes('staged patch'),'diff must refresh after staging');assert.ok(!action(uiText('git.discard')));
  await act(async()=>action(uiText('git.unstage'))!.click());assert.ok(action(uiText('git.stage')));assert.ok(host.textContent?.includes('working patch'));
  await act(async()=>action(uiText('git.discard'))!.click());assert.ok(!action(uiText('git.discard')),'clean/deleted file must not leave stale destructive actions');assert.ok(!host.textContent?.includes('working patch'));assert.ok(host.textContent?.includes(uiText('git.clean')));
 }finally{await act(async()=>root.unmount());window.confirm=confirm;}
});

test('refresh is manual with no interval; a requested refresh preserves paths and queues actions',async()=>{
 const buffer=createBufferedFs(),c=new WorkspaceController(openSession('/refresh-ui',{ops:buffer.ops}),emptyViewState(),buffer,toAsync(createMemoryFs().ops)),host=document.createElement('div'),root=createRoot(host);
 const interval=globalThis.setInterval,clear=globalThis.clearInterval;let timers=0,polling=false,release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let next=0;const jobs=new Map<number,string>(),calls:string[]=[];
 globalThis.setInterval=(()=>{timers++;return 1;}) as unknown as typeof setInterval;globalThis.clearInterval=(()=>{}) as typeof clearInterval;
 const send=async(r:Request):Promise<{createdId?:string;toolResult?:unknown}>=>{
  if(r.kind==='extension-invoke'){jobs.set(++next,r.method);calls.push(r.method);return {toolResult:{jobId:next}};}
  if(r.kind==='extension-job'){const method=jobs.get(r.jobId);if(polling && method==='status')await wait;return {toolResult:{state:'done',result:method==='status'?{repository:true,root:'/first',branch:'main',files:[],refs:[],remotes:['origin']}:{commits:[],nextOffset:null}}};}return {};
 };
 try{await act(async()=>root.render(createElement(GitPanel,{controller:c,send})));assert.equal(timers,0,'opening the panel must not start periodic refresh');assert.ok(host.querySelector('.git-history-workspace .git-graph'),'graph is the default main workspace');assert.equal(host.querySelector('[aria-label="'+uiText('git.branchName')+'"]'),null,'branch forms are hidden until requested');await act(async()=>host.querySelector<HTMLButtonElement>('[data-git-trigger=repository]')!.click());const path=host.querySelector<HTMLInputElement>('.git-repository-panel input')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(path,'/typed-repo');path.dispatchEvent(new Event('input',{bubbles:true}));});polling=true;await act(async()=>{[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.getAttribute('aria-label')===uiText('git.refresh'))!.click();});
  const fetch=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.getAttribute('aria-label')===uiText('git.fetch'))!;assert.equal(fetch.disabled,false,'automatic reads must not disable user actions');
  await act(async()=>fetch.click());assert.ok(!calls.includes('fetch'),'action waits for the pending read');await act(async()=>{polling=false;release();});assert.ok(calls.includes('fetch'),'user action is not silently dropped');assert.equal(path.value,'/typed-repo');
 }finally{release();await act(async()=>root.unmount());globalThis.setInterval=interval;globalThis.clearInterval=clear;}
});

test('Git extension shell renders job results, stages files and clears old detail when changing repository',async()=>{
 const buffer=createBufferedFs(),c=new WorkspaceController(openSession('/git-ui',{ops:buffer.ops}),emptyViewState(),buffer,toAsync(createMemoryFs().ops)),host=document.createElement('div'),root=createRoot(host);
 let repository='/first',next=0;const jobs=new Map<number,unknown>(),calls:string[]=[];
 const send=async(r:Request):Promise<{createdId?:string;toolResult?:unknown}>=>{
  if(r.kind==='extension-control'){repository=String(r.config?.root);return {};}
  if(r.kind==='extension-invoke'){
   calls.push(r.method);let result:unknown={};
   if(r.method==='status')result={repository:true,root:repository,branch:'main',head:repository,refsState:'main',files:[{path:'note.txt',original:null,index:' ',worktree:'M',conflict:false}],refs:['main'],remotes:['origin']};
   if(r.method==='graph')result={commits:[{id:repository,parents:[],author:'Test',date:'2026-10-15',subject:repository,refs:'main'}],nextOffset:null};
   if(r.method==='commitDetail')result={description:'Old repository details',files:['old.txt']};
   jobs.set(++next,result);return {toolResult:{jobId:next}};
  }
  if(r.kind==='extension-job')return {toolResult:{state:'done',result:jobs.get(r.jobId)}};
  return {};
 };
 const button=(label:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!;
 try{
  await act(async()=>root.render(createElement(ExtensionWindow,{controller:c,windowId:'ext-git__test',send,close:()=>{},startDrag:undefined})));
  assert.ok(host.querySelector('.extension-note .window-resize-handle'));assert.equal(host.querySelector('.reparent-grip'),null);assert.ok(host.querySelector('.git-commit-row')?.textContent?.includes('/first'));
  await act(async()=>host.querySelector<HTMLButtonElement>('.git-commit-row')!.click());assert.ok(host.textContent?.includes('Old repository details'));
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-git-trigger=repository]')!.click());const path=host.querySelector<HTMLInputElement>('.git-repository-panel input')!;await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(path,'/second');path.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>button(uiText('git.bind')).click());assert.ok(!host.textContent?.includes('Old repository details'));assert.ok(host.querySelector('.git-commit-row')?.textContent?.includes('/second'));
  await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.git-tabs button')].find(b=>b.textContent?.startsWith(uiText('git.changes')))!.click());await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.git-file-row button')].find(b=>b.textContent?.includes('note.txt'))!.click());await act(async()=>button(uiText('git.stage')).click());assert.ok(calls.includes('stage'));
 }finally{await act(async()=>root.unmount());}
});

test('Desktop-style menus retain branch, remote and commit actions in their own contexts',async()=>{
 const buffer=createBufferedFs(),c=new WorkspaceController(openSession('/desktop-ui',{ops:buffer.ops}),emptyViewState(),buffer,toAsync(createMemoryFs().ops)),host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 let next=0;const jobs=new Map<number,unknown>(),calls:{method:string;args:Record<string,unknown>}[]=[];
 const send=async(r:Request):Promise<{createdId?:string;toolResult?:unknown}>=>{
  if(r.kind==='extension-invoke'){calls.push({method:r.method,args:r.args});jobs.set(++next,r.method==='status'?{repository:true,root:'/repo',branch:'main',files:[{path:'new.txt',original:null,index:'A',worktree:' ',conflict:false}],refs:['main','feature'],remotes:['origin'],ahead:1}:r.method==='graph'?{commits:[],nextOffset:null}:{});return {toolResult:{jobId:next}};}
  if(r.kind==='extension-job')return {toolResult:{state:'done',result:jobs.get(r.jobId)}};return {};
 };
 const click=async(selector:string)=>act(async()=>host.querySelector<HTMLButtonElement>(selector)!.click());
 const fill=async(label:string,value:string)=>{const field=host.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[aria-label="${label}"]`)!;await act(async()=>{Object.getOwnPropertyDescriptor(field.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));});};
 const named=(label:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!;
 try{
  await act(async()=>root.render(createElement(GitPanel,{controller:c,send})));assert.equal(host.querySelector('.git-commit-inspector'),null);assert.equal(host.querySelector('.git-commit-composer'),null);assert.ok(host.querySelector('.git-sync-main')!.textContent?.includes(uiText('git.push')));
  await click('[data-git-trigger=branch]');assert.ok(host.querySelector('[role=dialog]'));await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.git-branch-options button')].find(b=>b.textContent==='feature')!.click());await act(async()=>named(uiText('git.switchBranch')).click());assert.ok(calls.some(c=>c.method==='switch'&&c.args.ref==='feature'));assert.equal(host.querySelector('[role=dialog]'),null);
  await click('[data-git-trigger=remote]');assert.ok(named(uiText('git.fetch')));assert.ok(named(uiText('git.pull')));await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(host.querySelector('[role=dialog]'),null);
  await act(async()=>[...host.querySelectorAll<HTMLButtonElement>('.git-tabs button')].find(b=>b.textContent?.includes(uiText('git.changes')))!.click());assert.ok(host.querySelector('.git-sidebar .git-commit-composer'));assert.equal(host.querySelector('.git-history-workspace'),null);
  await fill(uiText('git.commitSummary'),'A summary');await fill(uiText('git.commitDescription'),'More detail');await act(async()=>host.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));assert.ok(calls.some(c=>c.method==='commit'&&c.args.message==='A summary\n\nMore detail'));
 }finally{await act(async()=>root.unmount());host.remove();}
});
