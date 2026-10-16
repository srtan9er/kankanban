/**
 * 启动冒烟：**真的把入口跑一遍**，看它会不会崩、会不会画出东西。
 *
 * 这个文件补的是一个很实在的空洞：`main.tsx` 的 `boot()` 从写出来那天起就
 * **一次都没执行过**（它一 import 就 `createRoot`，还要 Tauri 环境）。
 * 而它是整个应用唯一没人验证过的一段 —— 其它都是纯逻辑，只有它是接线。
 *
 * 做法：装作"不在 Tauri 里"（`isTauri()` 读 `__TAURI_INTERNALS__`，
 * 测试环境里没有，自然为假），于是入口会退回内存后端 + 示例工作区，
 * 整条路径（注入 FsOps → 开会话 → 决策 → 建卡 → 落盘 → 渲染）都在 jsdom 里跑完。
 *
 * **它验证不了 Tauri IPC 与真实文件系统** —— 那要真跑起来才算。但"接线是否接错"
 * 这类错误它能拦住。
 */

import './dom-setup.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {installModernUI} from './modern-ui-fixture.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {hydrate,toAsync} from '../src/platform/async-fs-ops.ts';
import {createCard,openSession} from '../src/core/workspace.ts';
import {openWorkspace} from '../src/core/storage/workspace-io.ts';
import {emptyViewState,readViewState,windowViewFor,writeViewState} from '../src/core/view-state.ts';
import {windowAnchor} from '../src/core/window-identity.ts';
import {WorkspaceApp} from '../src/webview/WorkspaceApp.tsx';
import {WorkspaceController} from '../src/webview/controller.ts';
installModernUI();

/** 入口是 import 即执行，所以每个用例都得重新加载一次模块（用 query 串破缓存）。 */
async function bootOnce(tag: string, restore = false): Promise<HTMLElement> {
  if(!restore)localStorage.removeItem('kkb-preview-data');
  document.body.innerHTML = '<div id="root"></div>';
  const mount = document.getElementById('root');
  assert.ok(mount !== null);

  await act(async () => {
    await import(`../src/webview/main.tsx?${tag}`);
    // 让 boot() 里的几个 await 走完
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });

  return mount;
}

function previewDisk(){
  const snapshot:Record<string,string>=JSON.parse(localStorage.getItem('kkb-preview-data') ?? '{}');
  const disk=createMemoryFs();
  for(const [path,value] of Object.entries(snapshot)){assert.equal(typeof value,'string');disk.ops.mkdirp(path.slice(0,path.lastIndexOf('/')));disk.ops.writeFile(path,value);}
  return disk;
}
async function doubleClick(element:Element){await act(async()=>{element.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,detail:2}));await new Promise(resolve=>setTimeout(resolve,0));});}

test('入口打开原型式管理器，不再将示例卡当作 main', async () => {
  const mount = await bootOnce('a1');

  const html = mount.innerHTML;
  assert.ok(html.length > 0, '入口没有渲染任何东西');
  assert.match(html, /class="manager-home"/);
  assert.match(html, /新建卡片/);
  assert.doesNotMatch(html, /第一张卡/);
});

test('入口的看板卡片双击建立独立视图，实际卡片窗口展示真实三列', async () => {
  const mount = await bootOnce('a2');
  const board=mount.querySelector<HTMLElement>('.manager-home [data-card-id="001"]');assert.ok(board);
  await act(async()=>board.click());assert.ok(board.classList.contains('selected'));assert.ok(mount.querySelector('.manager-home'));
  await doubleClick(board);
  const disk=previewDisk(),firstView=readViewState('/preview',disk.ops),opened=firstView.openWindows.filter(id=>windowAnchor(id)==='001');assert.equal(opened.length,1);assert.notEqual(opened[0],'001');
  const before=disk.ops.readFile('/preview/.kkb/tree.json');await doubleClick(board);const secondDisk=previewDisk(),secondView=readViewState('/preview',secondDisk.ops);
  assert.equal(secondView.openWindows.filter(id=>windowAnchor(id)==='001').length,2,'再次双击应另开视图');assert.equal(secondDisk.ops.readFile('/preview/.kkb/tree.json'),before,'另开窗口不修改树');assert.ok(mount.querySelector('.manager-home'),'管理器保留树节点列表');
  const buffer=createBufferedFs();await hydrate(buffer.memory,toAsync(secondDisk.ops),'/preview/.kkb');const session=openSession('/preview',{ops:buffer.ops}),controller=new WorkspaceController(session,secondView,buffer,toAsync(secondDisk.ops));
  const windowHost=document.createElement('div');document.body.append(windowHost);const windowRoot=createRoot(windowHost);
  try{await act(async()=>windowRoot.render(createElement(WorkspaceApp,{controller,cardId:'001',windowId:opened[0]!})));assert.equal(windowHost.querySelectorAll('.kanban-column').length,3);for(const title of ['待办','进行中','完成'])assert.ok(windowHost.textContent?.includes(title));}
  finally{await act(async()=>windowRoot.unmount());windowHost.remove();}
});

test('入口里的会话是**可用**的：状态里有卡、没有抛错', async () => {
  const mount = await bootOnce('a3');

  // 状态栏是入口接线是否走通的直接证据（它会显示工作区路径与事件数）
  assert.match(mount.innerHTML, /class="workspace-footer"/);
  assert.match(mount.innerHTML, /已保存/);
});

test('两次启动互不干扰（模块缓存被 query 串破开了）', async () => {
  const first = await bootOnce('b1');
  const firstHtml = first.innerHTML;
  const second = await bootOnce('b2');

  assert.ok(firstHtml.length > 0);
  assert.notEqual(first,second);
  assert.equal(first.innerHTML,firstHtml,'重新启动不能继续写入旧的挂载节点');
  assert.match(second.innerHTML, /class="manager-home"/);
  assert.doesNotMatch(second.innerHTML, /工作区未能打开/);
});

test('浏览器实际保存的快照可再次启动，保留中文正文、扩展格式和独立窗口状态',async()=>{
  const disk=createMemoryFs(),session=openSession('/preview',{ops:disk.ops,clientId:'persisted',newId:()=> 'saved-card'});
  const content='# 中文恢复\n\n正文 **强调** 与 <image_0>\n\n<table name="table_0" layout="inline" columns="80" rows="40" align="left">\n<cell row="0" col="0" rowspan="1" colspan="1">保留表格</cell>\n</table>';
  const id=createCard(session,{parentId:null,title:'中文恢复卡',content}),remembered=emptyViewState(),viewId=`${id}__remembered`;
  remembered.skin='dark';remembered.cardRadius=13;remembered.openWindows=[viewId];remembered.windows[viewId]={...windowViewFor(remembered,viewId),childArea:{width:333,height:166}};writeViewState('/preview',remembered,disk.ops);
  const seed:Record<string,unknown>=Object.fromEntries(Object.entries(disk.snapshot()).map(([path,value])=>[`/${path}`,value]));Object.assign(seed,{'/outside/private.txt':'excluded','preview-else/data.txt':'excluded','/preview/not-text':{unexpected:true}});localStorage.setItem('kkb-preview-data',JSON.stringify(seed));
  const first=await bootOnce('persist-first',true),card=first.querySelector(`[data-card-id="${id}"]`);assert.ok(card);await doubleClick(card);
  const saved=previewDisk(),savedView=readViewState('/preview',saved.ops);assert.equal(saved.ops.exists('/outside/private.txt'),false);assert.equal(saved.ops.exists('/preview-else/data.txt'),false);assert.equal(saved.ops.exists('/preview/not-text'),false);
  assert.deepEqual(openWorkspace('/preview',saved.ops).state.cards.get(id)?.content,content);assert.ok(Object.keys(saved.snapshot()).every(path=>path.startsWith('preview/')),'入口确实通过MemoryFs保存为无前导斜杠的路径');
  const second=await bootOnce('persist-second',true),restored=second.querySelector(`[data-card-id="${id}"]`);assert.ok(restored,'恢复实际写出的快照后必须仍显示原用户卡，不能新建空工作区取代');await doubleClick(restored);
  const reopened=previewDisk(),actualView=readViewState('/preview',reopened.ops);assert.equal(openWorkspace('/preview',reopened.ops).state.cards.get(id)?.content,content);assert.equal(actualView.skin,'dark');assert.equal(actualView.cardRadius,13);assert.deepEqual(actualView.windows[viewId]?.childArea,{width:333,height:166});for(const opened of savedView.openWindows)assert.ok(actualView.openWindows.includes(opened));assert.equal(actualView.openWindows.filter(opened=>windowAnchor(opened)===id).length,3);
});
