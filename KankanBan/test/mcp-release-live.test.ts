import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {toolListPayload} from '../src/mcp/tools.ts';
const command=resolve('src-mcp/target/x86_64-pc-windows-msvc/release/kankanban-mcp.exe');

// Runs a real headless release executable, never a GUI or real workspace.
test('release executable speaks MCP and forwards identity, review, screenshots and workspace switches',{timeout:15000,skip:process.platform!=='win32'||!existsSync(command)},async()=>{
 const temp=mkdtempSync(join(tmpdir(),'kkb-release-'));const app=join(temp,'com.kankanban.app');mkdirSync(app);
 const roots=[join(temp,'first'),join(temp,'second')];for(const root of roots)mkdirSync(join(root,'.kkb'),{recursive:true});
 const requests:any[]=[];const token='a'.repeat(64);
 const bridge=createServer(socket=>{let wire='';socket.on('data',chunk=>{wire+=chunk; if(!wire.includes('\n'))return;const req=JSON.parse(wire.trim());requests.push(req);const result=req.tool==='read_operations'?{operations:[],reviewToken:'reviewed'}:req.tool==='capture_window'?{data:'aGVsbG8=',mimeType:'image/png',windowLabel:'main'}:{root:req.workspace,context:req.context};socket.end(JSON.stringify({result})+'\n');});});
 await new Promise<void>(r=>bridge.listen(0,'127.0.0.1',r));const port=(bridge.address() as {port:number}).port;
 const discovery=(root:string,host='127.0.0.1')=>writeFileSync(join(root,'.kkb/mcp-bridge.json'),JSON.stringify({version:1,host,port,token,root}));for(const root of roots)discovery(root);
 writeFileSync(join(app,'workspace-path.txt'),roots[0]!);
 const transport=new StdioClientTransport({command,args:[],env:{...Object.fromEntries(Object.entries(process.env).filter((p):p is [string,string]=>typeof p[1]==='string')),APPDATA:temp,XDG_DATA_HOME:temp,HOME:temp}});
 const client=new Client({name:'release-test',version:'1'},{capabilities:{}});
 try {
  await client.connect(transport);assert.deepEqual((await client.listTools()).tools,toolListPayload());
  const call=(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
  assert.equal((await call('identify_actor',{id:'codex',name:'Codex'})).isError,undefined);
  await call('read_operations');await call('get_workspace');assert.equal(requests.at(-1).context.reviewToken,'reviewed');assert.equal(requests.at(-1).context.actor.name,'Codex');
  const capture=await call('capture_window',{windowLabel:'main'});assert.equal((capture.content as any[])[0].type,'image');assert.equal((capture.content as any[])[0].data,'aGVsbG8=');assert.ok(!(capture.content as any[])[1].text.includes('aGVsbG8='));
  writeFileSync(join(app,'workspace-path.txt'),roots[1]!);await call('get_workspace');assert.equal(requests.at(-1).workspace,roots[1]);
  await call('identify_actor',{id:'another',name:'Another'});await call('get_workspace');assert.equal(requests.at(-1).context.reviewToken,undefined);
  discovery(roots[1]!,'192.0.2.1');const count=requests.length;assert.equal((await call('get_workspace')).isError,true);assert.equal(requests.length,count);
  rmSync(join(roots[1]!,'.kkb/mcp-bridge.json'));assert.equal((await call('get_workspace')).isError,true);
  assert.equal((await call('identify_actor',{id:'bad/id',name:'Bad'})).isError,true);
 }finally{await client.close();await new Promise<void>(r=>bridge.close(()=>r()));rmSync(temp,{recursive:true,force:true});}
});
