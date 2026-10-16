import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileTheme} from '../src/themes/compiler.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession} from '../src/core/workspace.ts';
import {emptyViewState,readViewState} from '../src/core/view-state.ts';
import {WorkspaceController} from '../src/webview/controller.ts';
import {ThemeRuntime,connectThemeRuntime,themeRuntime} from '../src/themes/runtime.ts';
import {readTextMetrics} from '../src/themes/metrics.ts';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {ThemeSettings} from '../src/webview/ThemeSettings.tsx';
import {uiText} from '../src/i18n/text.ts';
test('settings preview and cancel never save; Apply is the only write, with no embedded CSS editor',async()=>{
 Object.assign(globalThis,{ResizeObserver:class{observe(){}disconnect(){}}});
 const buffer=createBufferedFs(),disk=createMemoryFs(),c=new WorkspaceController(openSession('/preview-theme',{ops:buffer.ops}),{...emptyViewState(),theme:'saved.css'},buffer,toAsync(disk.ops));const mounted:string[]=[],requests:unknown[]=[];
 const stop=connectThemeRuntime(error=>{throw error;},{catalog:async()=>({directory:'',themes:[]}),compile:async id=>id,mount:async css=>{mounted.push(css);return null;}});await themeRuntime.set('saved.css','light');const unsubscribe=c.subscribe(()=>{void themeRuntime.set(c.view.theme ?? '',c.view.skin ?? 'light');});
 const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 try{await act(async()=>root.render(createElement(ThemeSettings,{controller:c,send:async request=>{requests.push(request);return c.execute(request);}})));
  const select=host.querySelector('select')!;await act(async()=>{select.value='';select.dispatchEvent(new Event('change',{bubbles:true}));});
  const click=async(key:'preview'|'cancel'|'apply')=>act(async()=>{[...host.querySelectorAll('button')].find(button=>button.textContent===uiText(`themes.${key}`))!.click();});
  await click('preview');assert.equal(requests.length,0);assert.equal(c.view.theme,'saved.css');await click('cancel');assert.equal(mounted.at(-1),'saved.css');
  await click('apply');assert.deepEqual(requests,[{kind:'theme',theme:''}]);assert.equal(c.view.theme,'');assert.equal(host.querySelector('textarea,[contenteditable=true]'),null);
 }finally{await act(async()=>root.unmount());await new Promise(resolve=>setImmediate(resolve));unsubscribe();stop();host.remove();}
});
test('a late failure from an obsolete theme cannot remove a newer successful selection',async()=>{
 let rejectOld:((error:Error)=>void)|undefined;const runtime=new ThemeRuntime(()=>{assert.fail('obsolete error');},{catalog:async()=>({directory:'',themes:[]}),compile:async id=>id==='old.css'?new Promise<string>((_,reject)=>{rejectOld=reject;}):id,mount:async()=>document.createElement('style')});
 const old=runtime.set('old.css','light');await new Promise(resolve=>setImmediate(resolve));await runtime.set('new.css','dark');rejectOld!(new Error('late failure'));await old;assert.equal(document.documentElement.dataset.theme,'dark');
});
test('a missing saved theme falls back once and can be retried with explicit reload',async()=>{
 let calls=0,errors=0;const runtime=new ThemeRuntime(()=>{errors++;},{catalog:async()=>({directory:'',themes:[]}),compile:async()=>{calls++;throw new Error('missing');},mount:async()=>null});
 await runtime.set('missing.css','light');await runtime.set('missing.css','light');assert.equal(calls,1);assert.equal(errors,1);assert.equal(document.documentElement.dataset.theme,'light');await assert.rejects(runtime.reload());assert.equal(calls,2);
});
test('theme previews restore the saved theme, retain the old style on failure and honor dark metadata',async()=>{
 const mounted:string[]=[];const runtime=new ThemeRuntime(()=>{},{catalog:async()=>({directory:'',themes:[{id:'night.css',name:'Night',mode:'dark'}]}),compile:async id=>{if(id==='bad.css')throw new Error('invalid CSS');return id;},mount:async(css)=>{mounted.push(css);return document.createElement('style');}});
 await runtime.set('saved.css','light');await runtime.show('night.css');assert.equal(document.documentElement.dataset.theme,'dark');
 await runtime.set('saved.css','light');assert.equal(mounted.length,2);await assert.rejects(runtime.show('bad.css'));assert.equal(document.documentElement.dataset.theme,'dark');
 await runtime.restore();assert.deepEqual(mounted,['saved.css','night.css','saved.css']);assert.equal(document.documentElement.dataset.theme,'light');
});
test('text metrics read actual CSS including headings, spacing, weights and monospace fonts',()=>{
 const style=document.createElement('style');style.textContent='.theme-test p{font-size:18px;line-height:32px;font-family:serif;letter-spacing:1px;margin:7px 0}.theme-test h1{font-size:36px;line-height:48px}.theme-test strong{font-weight:800}.theme-test code{font-family:monospace}';document.head.append(style);
 const host=document.createElement('div');host.className='theme-test';document.body.append(host);try{const result=readTextMetrics(host);assert.equal(result.paragraphs.p!.size,18);assert.equal(result.paragraphs.p!.lineHeight,32);assert.equal(result.paragraphs.p!.letterSpacing,1);assert.equal(result.paragraphs.h1!.size,36);assert.equal(result.paragraphs.p!.strongWeight,'800');assert.equal(result.paragraphs.p!.mono,'monospace');assert.equal(host.childElementCount,0);}finally{host.remove();style.remove();}
});
test('local CSS imports and resources are bundled with deterministic user override order',async()=>{
 const files:Record<string,string>={'forest/theme.css':'@import "base.css" screen; h1{color:green;background:url("leaf.png")}','forest/base.css':':root{--md-font-size:16px}','base.user.css':'p{color:blue}','forest/theme.user.css':'p{color:orange}','forest/leaf.png':'data:image/png;base64,YQ=='};
 const css=decodeURIComponent(await compileTheme('forest/theme.css',async path=>path in files?{kind:path.endsWith('.css')?'css':'asset',content:files[path]!}:null));
 assert.match(css,/@import url\("data:text\/css/);assert.match(css,/data:image\/png;base64,YQ==/);assert.ok(css.indexOf('color:blue')<css.indexOf('color:orange'));
});
test('invalid imports cannot escape the folder, load remote URLs or loop forever',async()=>{
 for(const css of ['@import "../escape.css";','p{background:url(https://remote.test/a)}','@IMPORT "https://remote.test/a.css";','p{background:u\\72l("https://remote.test/a")}','p{background:image-set("https://remote.test/a" 1x)}','@import "loop.css";','p{color:red'])await assert.rejects(compileTheme('loop.css',async()=>({kind:'css',content:css})),css);
});
test('a theme selection persists as private view preference without changing card content',async()=>{
 const buffer=createBufferedFs(),disk=createMemoryFs(),c=new WorkspaceController(openSession('/themes',{ops:buffer.ops}),emptyViewState(),buffer,toAsync(disk.ops));
 const previous=c.journal.operations.length;await c.execute({kind:'theme',theme:'forest/theme.css'});assert.equal(readViewState('/themes',disk.ops).theme,'forest/theme.css');assert.equal(c.journal.operations.length,previous);
 await assert.rejects(c.execute({kind:'theme',theme:'../bad.css'}));
});
