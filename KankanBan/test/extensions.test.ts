import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ExtensionHost,GIT_EXTENSION,type ExtensionService} from '../src/extensions/registry.ts';
import {graphRows} from '../src/extensions/git-graph.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession} from '../src/core/workspace.ts';
import {emptyViewState,readViewState} from '../src/core/view-state.ts';
import {WorkspaceController} from '../src/webview/controller.ts';
const stub=():ExtensionService=>({initialize:async()=>{},enable:async()=>{},disable:async()=>{},dispose:async()=>{},configure:async()=>{},invoke:async(method,args)=>({method,args}),status:()=>({})});
test('job polling does not save or broadcast snapshots while a job is running',async()=>{
 const buffer=createBufferedFs(),c=new WorkspaceController(openSession('/poll',{ops:buffer.ops}),emptyViewState(),buffer,toAsync(createMemoryFs().ops));await c.attachExtensions(async(channel)=>channel==='job'?{state:'running'}:{});
 const revision=c.getRevision(),operations=c.journal.operations.length;let flushed=0;buffer.flushTo=async()=>{flushed++;};
 for(let i=0;i<8;i++)await c.execute({kind:'extension-job',jobId:1});
 assert.equal(flushed,0);assert.equal(c.getRevision(),revision);assert.equal(c.journal.operations.length,operations);
});
test('a queued job is not treated as completed by polling',async()=>{
 const buffer=createBufferedFs(),c=new WorkspaceController(openSession('/queued',{ops:buffer.ops}),emptyViewState(),buffer,toAsync(createMemoryFs().ops));await c.attachExtensions(async(channel)=>channel==='start'?{jobId:1}:channel==='job'?{state:'queued'}:{});
 await c.execute({kind:'extension-invoke',id:'git',method:'fetch',args:{}});await c.execute({kind:'extension-job',jobId:1});assert.equal(c.hasExtensionJobs,true);assert.equal(c.journal.operations.filter(o=>o.operation==='extension-result').length,0);
 await c.completeExtension(1,{state:'done'});
});
test('completion arriving before the start response cannot leave an orphan running job',async()=>{
 const buffer=createBufferedFs(),c=new WorkspaceController(openSession('/early',{ops:buffer.ops}),emptyViewState(),buffer,toAsync(createMemoryFs().ops));
 await c.attachExtensions(async(channel)=>{if(channel==='start'){await c.completeExtension(7,{state:'done',id:'git',method:'fetch'});return {jobId:7};}return {};});
 await c.execute({kind:'extension-invoke',id:'git',method:'fetch',args:{}});await c.flush();assert.equal(c.hasExtensionJobs,false);assert.equal(c.journal.operations.filter(o=>o.operation==='extension-result').length,1);
});
test('a second provider uses exactly the same registration, lifecycle, invocation and event interface',async()=>{
 const host=new ExtensionHost();host.register(GIT_EXTENSION,stub());host.register({...GIT_EXTENSION,id:'sample'},stub());const events:unknown[]=[];host.subscribe(e=>events.push(e));
 await assert.rejects(host.invoke('sample','read'),/启用/);await host.initialize('sample',{});await host.enable('sample');assert.deepEqual(await host.invoke('sample','read',{a:1}),{method:'read',args:{a:1}});await host.disable('sample');await assert.rejects(host.invoke('sample','read'));await host.uninstall('sample');assert.equal(host.list().length,1);assert.ok(events.length>=4);assert.throws(()=>host.register({...GIT_EXTENSION,id:'bad',apiVersion:2},stub()),/版本/);
});
test('merge graph retains both parent edges and earlier rows remain identical on pagination',()=>{
 const commit=(id:string,parents:string[])=>({id,parents,author:'a',date:'2026-10-14',subject:id,refs:''});const prefix=[commit('merge',['left','right']),commit('left',['base'])],all=[...prefix,commit('right',['base']),commit('base',[])];
 const graph=graphRows(all);assert.equal(graph[0]!.edges.filter(e=>e.parent).length,2);assert.deepEqual(graph.slice(0,2),graphRows(prefix));assert.ok(graph[2]!.lane!==graph[1]!.lane);
});
test('background service jobs do not block card writes; config persists and disable closes only extension views',async()=>{
 const buffer=createBufferedFs(),disk=createMemoryFs(),session=openSession('/ext',{ops:buffer.ops}),c=new WorkspaceController(session,emptyViewState(),buffer,toAsync(disk.ops));
 let busy=false;await c.attachExtensions(async(channel,args)=>{if(channel==='start'){busy=true;return {jobId:1};}if(channel==='job')return {id:'git',state:'done',result:{}};if(args.method==='disable' && busy)throw new Error('busy');return {enabled:true,root:'/repo'};});
 await c.execute({kind:'extension-control',id:'git',method:'configure',config:{root:'/repo'}});
 await c.execute({kind:'window',id:'ext-git__a',open:true});await c.execute({kind:'window',id:'ext-git__b',open:true});
 await c.execute({kind:'extension-invoke',id:'git',method:'fetch',args:{}});const card=await c.execute({kind:'create',parent:null,title:'Still editable'});assert.ok(card.createdId);
 await assert.rejects(c.execute({kind:'extension-control',id:'git',method:'disable'}),/busy/);busy=false;await c.completeExtension(1,{state:'done'});
 await c.execute({kind:'extension-control',id:'git',method:'disable'});assert.equal(c.view.openWindows.length,0);assert.ok(session.state.cards.has(card.createdId!));assert.equal(readViewState('/ext',disk.ops).extensions?.git?.enabled,false);
 const ops=c.journal.operations.filter(o=>o.operation==='extension-result');assert.equal(ops.length,1);
});
