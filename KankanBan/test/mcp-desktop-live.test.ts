import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer as createTcpServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import '../src/node/bootstrap.ts';
import {desktopToolCaller} from '../src/mcp/desktop-client.ts';
import {createServer as createMcpServer} from '../src/mcp/server.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {createBufferedFs} from '../src/platform/buffered-fs-ops.ts';
import {toAsync} from '../src/platform/async-fs-ops.ts';
import {openSession,readCard} from '../src/core/workspace.ts';
import {emptyViewState} from '../src/core/view-state.ts';
import {WorkspaceController} from '../src/webview/controller.ts';
function controller(){const buffer=createBufferedFs(),disk=createMemoryFs(),session=openSession('/workspace',{ops:buffer.ops});const c=new WorkspaceController(session,emptyViewState(),buffer,toAsync(disk.ops)),execute=c.execute.bind(c),actor={kind:'ai' as const,id:'mcp',name:'Test AI'};
 c.execute=(request,before,desktop)=>execute(request.kind==='mcp'?{...request,context:{actor,reviewToken:c.journal.read(actor).reviewToken!}}:request,before,desktop);
 return {c,disk};}
test('desktop queue serializes MCP writes and returns current persisted state',async()=>{
 const {c,disk}=controller();let changed=0;c.subscribe(()=>changed++);
 const created=await c.execute({kind:'mcp',tool:'create_card',args:{title:'Live',content:'Initial'}});
 const id=(created.toolResult as {id:string}).id;assert.equal(readCard(c.session,id).createdBy,'mcp');
 await Promise.all(['first','latest'].map(value=>c.execute({kind:'mcp',tool:'set_field',args:{cardId:id,path:'/content',value}})));
 const result=await c.execute({kind:'mcp',tool:'read_card',args:{cardId:id}});
 assert.equal((result.toolResult as {content:string}).content,'latest');assert.ok(changed>0);assert.ok(disk.ops.exists(`/workspace/.kkb/cards/${id}.md`));
 const seq=c.session.events.length;await c.execute({kind:'mcp',tool:'search',args:{query:'Live'}});assert.equal(c.session.events.length,seq);
});
test('desktop MCP enforces board and argument rules before mutation',async()=>{
 const {c}=controller();const board=await c.execute({kind:'mcp',tool:'create_card',args:{title:'Board',layout:'columns'}});
 const id=(board.toolResult as {id:string}).id;assert.equal(c.session.state.children.get(id)?.length,3);
 const count=c.session.state.cards.size;await assert.rejects(c.execute({kind:'mcp',tool:'create_card',args:{title:'Fourth',parentId:id}}));assert.equal(c.session.state.cards.size,count);
 await assert.rejects(c.execute({kind:'mcp',tool:'create_card',args:{title:'Invalid presentation',type:'missing-source'}}));assert.equal(c.session.state.cards.size,count);
 await assert.rejects(c.execute({kind:'mcp',tool:'read_tree',args:{scope:'unsupported'}}));
 await assert.rejects(c.execute({kind:'mcp',tool:'set_layout',args:{cardId:id,layout:'plane',placements:[{x:NaN,y:0,w:1,h:1,z:0}]}}));
 await assert.rejects(c.execute({kind:'mcp',tool:'fs_write_file',args:{}}));
});
test('MCP protocol forwards to desktop transport, rediscovers endpoint and never takes writer lock',async()=>{
 const root=mkdtempSync(join(tmpdir(),'kkb-desktop-client-'));mkdirSync(join(root,'.kkb'));
 const {c}=controller();let token=randomBytes(32).toString('hex');let calls=0;
 const host=createTcpServer(socket=>{
  let data='';socket.setEncoding('utf8');socket.on('data',chunk=>{data+=chunk;if(!data.includes('\n'))return;calls++;
   const wire=JSON.parse(data);if(wire.token!==token){socket.end(JSON.stringify({error:'denied'})+'\n');return;}
   void c.execute({kind:'mcp',tool:wire.tool,args:wire.args,context:wire.context}).then(reply=>socket.end(JSON.stringify({result:reply.toolResult})+'\n')).catch(error=>socket.end(JSON.stringify({error:String(error)})+'\n'));
  });
 });
 await new Promise<void>(resolve=>host.listen(0,'127.0.0.1',resolve));
 const port=(host.address() as {port:number}).port;
 const publish=()=>writeFileSync(join(root,'.kkb','mcp-bridge.json'),JSON.stringify({version:1,host:'127.0.0.1',port,token,root}));publish();
 // A live desktop already owns this lock; the adapter must leave it untouched.
 mkdirSync(join(root,'.kkb','writer.lock'));writeFileSync(join(root,'.kkb','writer.lock','pid'),String(process.pid));
 const caller=desktopToolCaller(root),server=createMcpServer(caller),client=new Client({name:'live-test',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await server.connect(serverTransport);await client.connect(clientTransport);
 try{
  const result=await client.callTool({name:'create_card',arguments:{title:'From MCP'}});
  assert.ok(Array.isArray(result.content));const id=JSON.parse((result.content as {text:string}[])[0]!.text).id;assert.equal(readCard(c.session,id).title,'From MCP');
  token=randomBytes(32).toString('hex');publish();const read=await caller('read_card',{cardId:id});assert.equal((read as {title:string}).title,'From MCP');
  const before=calls;await assert.rejects(caller('unknown_tool',{}));assert.equal(calls,before);
  writeFileSync(join(root,'.kkb','mcp-bridge.json'),JSON.stringify({version:1,host:'0.0.0.0',port,token,root}));await assert.rejects(caller('read_card',{cardId:id}));assert.equal(calls,before);
 }finally{await client.close();await server.close();await new Promise<void>(resolve=>host.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});

test('expired queued desktop request cannot mutate after waiting for the writer',async()=>{
 const {c}=controller();let release!:()=>void;
 const blocker=new Promise<void>(resolve=>release=resolve);
 const first=c.execute({kind:'mcp',tool:'create_card',args:{title:'first'}},()=>blocker);
 let active=true;
 const next=c.execute({kind:'mcp',tool:'create_card',args:{title:'expired'}},async()=>{if(!active)throw new Error('expired');});
 active=false;release();await first;await assert.rejects(next,/expired/);
 assert.equal([...c.session.state.cards.values()].filter(card=>card.title==='expired').length,0);
});

test('MCP layout changes use the same child-area reset as desktop actions',async()=>{
 const {c}=controller();const created=await c.execute({kind:'mcp',tool:'create_card',args:{title:'Layout'}});
 const id=(created.toolResult as {id:string}).id;
 await c.execute({kind:'view',id,childArea:{width:400,height:400}});
 await c.execute({kind:'mcp',tool:'set_layout',args:{cardId:id,layout:'ordered'}});
 assert.equal(c.view.windows[id]?.childArea?.width,178);
 assert.equal(c.view.windows[id]?.childArea?.height,9999);
});
