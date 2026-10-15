import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession} from '../src/core/workspace.ts';
import {emptyViewState,readViewState} from '../src/core/view-state.ts';
import {WorkspaceController} from '../src/webview/controller.ts';
import type {McpContext} from '../src/core/collaboration.ts';
import {createServer} from '../src/mcp/server.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const fixture=()=>{const buffer=createBufferedFs(),disk=createMemoryFs(),s=openSession('/w',{ops:buffer.ops});return {disk,c:new WorkspaceController(s,emptyViewState(),buffer,toAsync(disk.ops))};};
test('desktop refuses unnamed/unread AI, records user edits and undo independently, preserves signature',async()=>{
 const {c,disk}=fixture();
 await c.execute({kind:'signature',name:'我的署名'});
 assert.equal(readViewState('/w',disk.ops).userSignature,'我的署名');
 await assert.rejects(c.execute({kind:'mcp',tool:'create_card',args:{title:'Bad'}}),/署名/);
 let context:McpContext={actor:{kind:'ai',id:'codex',name:'Codex'}};
 await assert.rejects(c.execute({kind:'mcp',tool:'create_card',args:{title:'Unread'},context}),/read_operations/);
 const read=await c.execute({kind:'mcp',tool:'read_operations',args:{},context});
 const feed=read.toolResult as {reviewToken:string;operations:unknown[]};assert.ok(feed.operations.length);
 context={...context,reviewToken:feed.reviewToken};
 const made=await c.execute({kind:'mcp',tool:'create_card',args:{title:'Card'},context});const id=(made.toolResult as {id:string}).id;
 assert.deepEqual(c.session.events.at(-1)?.actor,context.actor);
 await c.execute({kind:'edit',id,field:'title',value:'人改的'});
 assert.equal(c.session.events.at(-1)?.actor?.name,'我的署名');
 await assert.rejects(c.execute({kind:'mcp',tool:'delete_card',args:{cardId:id},context}),/read_operations/);
 await c.flush();const before=c.journal.operations.length;await c.execute({kind:'undo'});
 assert.equal(c.journal.operations.length,before+1);assert.equal(c.journal.operations.at(-1)?.operation,'undo');
 const delta=await c.execute({kind:'mcp',tool:'read_operations',args:{},context});
 assert.deepEqual((delta.toolResult as {operations:{operation:string}[]}).operations.map(o=>o.operation),['edit','undo']);
  assert.ok(disk.ops.readFile('/w/.kkb/operations.jsonl').includes('我的署名'));
 const count=c.journal.operations.length;c.journal.importEvents(c.session.events);assert.equal(c.journal.operations.length,count);
});
test('MCP connection declares identity, exposes others changes, carries receipt and invalidates it',async()=>{
 const {c}=fixture();await c.execute({kind:'signature',name:'设计者'});await c.execute({kind:'create',parent:null,title:'设计草稿'});
 const server=createServer(async(tool,args,context)=>(await c.execute({kind:'mcp',tool,args,context})).toolResult);
 const client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 const call=(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
 try{
  assert.equal((await call('create_card',{title:'No name'})).isError,true);
  await call('identify_actor',{id:'codex',name:'Codex'});
  assert.equal((await call('create_card',{title:'Unread'})).isError,true);
  const feed=await call('read_operations');assert.ok(JSON.parse((feed.content as {text:string}[])[0]!.text).operations.some((op:{actor:{name:string}})=>op.actor.name==='设计者'));
  const made=await call('create_card',{title:'New'});assert.ok(!made.isError);const id=JSON.parse((made.content as {text:string}[])[0]!.text).id;
  await c.execute({kind:'delete',id});
  assert.equal((await call('set_field',{cardId:id,path:'/title',value:'Revive'})).isError,true);
  const delta=await call('read_operations');assert.deepEqual(JSON.parse((delta.content as {text:string}[])[0]!.text).operations.map((op:{operation:string})=>op.operation),['delete']);
 }finally{await client.close();await server.close();}
});
test('undo and a new edit reusing a core sequence number retain distinct audit records',async()=>{
 const {c}=fixture();await c.execute({kind:'create',parent:null,title:'First'});const first=c.session.events.at(-1)!;
 await c.execute({kind:'undo'});await c.execute({kind:'create',parent:null,title:'Second'});const second=c.session.events.at(-1)!;
 assert.equal(first.id,second.id);const n=c.journal.operations.length;c.journal.importEvents(c.session.events);assert.equal(c.journal.operations.length,n);
 assert.deepEqual(c.journal.operations.slice(-3).map(o=>o.operation),['create','undo','create']);
});
