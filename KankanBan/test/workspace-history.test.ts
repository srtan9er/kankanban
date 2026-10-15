import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceHistoryButton,recentWorkspaces,workspaceFolderName} from '../src/webview/WorkspaceHistoryButton.tsx';
test('manager workspace label is a history button, and current path aligns right',()=>{
 const source=readFileSync(new URL('../src/webview/WorkspaceApp.tsx',import.meta.url),'utf8');
 const css=readFileSync(new URL('../src/webview/workspace.css',import.meta.url),'utf8');
 assert.ok(source.includes('<WorkspaceHistoryButton'));
 assert.match(css,/\.workspace-path\s*\{[^}]*text-align:right/);
});
test('recent roots deduplicate Windows paths and retain only five most recently opened folders',()=>{
 assert.deepEqual(recentWorkspaces('C:\\Work\\Now',['c:/work/now/','C:\\Work\\One','C:\\Work\\Two',null,'','C:\\Work\\Three','C:\\Work\\Four','C:\\Work\\Five']),['C:\\Work\\Now','C:\\Work\\One','C:\\Work\\Two','C:\\Work\\Three','C:\\Work\\Four']);
 assert.equal(workspaceFolderName('C:\\Work\\Now\\'),'Now');
 assert.equal(workspaceFolderName('/home/user/project/'),'project');
 assert.deepEqual(recentWorkspaces('C:\\Current',{}),['C:\\Current']);
});
test('workspace menu keeps history across remount, exposes full paths and switches the selected folder',async()=>{
 const key='kkb-recent-workspaces',host=document.createElement('div'),root=createRoot(host),switched:string[]=[];
 window.localStorage.setItem(key,JSON.stringify(['C:\\Previous','C:\\Other']));document.body.append(host);
 const render=async(current:string)=>{await act(async()=>root.render(createElement(WorkspaceHistoryButton,{current,busy:false,switchTo:async path=>{switched.push(path);}})));};
 const toggle=()=>host.querySelector<HTMLButtonElement>('.workspace-history-toggle')!;
 try{
  await render('C:\\Current');await act(async()=>toggle().click());
  const buttons=host.querySelectorAll<HTMLButtonElement>('.workspace-history-list button');
  assert.deepEqual([...buttons].map(button=>button.textContent),['Current','Previous','Other']);assert.equal(buttons[1]!.title,'C:\\Previous');
  await act(async()=>buttons[1]!.click());assert.deepEqual(switched,['C:\\Previous']);assert.equal(host.querySelector('.workspace-history-list'),null);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!),['C:\\Current','C:\\Previous','C:\\Other']);
  await render('C:\\Previous');assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!),['C:\\Previous','C:\\Current','C:\\Other']);
  await act(async()=>toggle().click());await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));assert.equal(host.querySelector('.workspace-history-list'),null);
  await act(async()=>toggle().click());await act(async()=>document.body.dispatchEvent(new Event('pointerdown',{bubbles:true})));assert.equal(host.querySelector('.workspace-history-list'),null);
 }finally{await act(async()=>root.unmount());host.remove();window.localStorage.removeItem(key);}
});
