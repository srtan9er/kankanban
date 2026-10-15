import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
test('persistent CLI reuses identity and review receipt across calls and never retries a failed write',{timeout:12000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'kkb-agent-')),token=randomBytes(32).toString('hex'),calls:Record<string,any>[]=[];
 mkdirSync(join(root,'.kkb'));const host=createServer(socket=>{let input='';socket.setEncoding('utf8');socket.on('data',chunk=>{input+=chunk;if(!input.includes('\n'))return;const call=JSON.parse(input);calls.push(call);assert.equal(call.token,token);socket.end(JSON.stringify(call.tool==='read_operations'?{result:{operations:[],sourceCount:0,through:1,reviewToken:'receipt'}}:call.tool==='set_field'?{error:'write denied'}:{result:{path:root}})+'\n');});});
 await new Promise<void>(resolve=>host.listen(0,'127.0.0.1',resolve));
 writeFileSync(join(root,'.kkb','mcp-bridge.json'),JSON.stringify({version:1,host:'127.0.0.1',port:(host.address() as {port:number}).port,token,root}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/mcp-agent.mjs',import.meta.url)),'--id','test-ai','--name','Test AI','--workspace',root],{stdio:['pipe','pipe','pipe']});
 const rows:Record<string,any>[]=[];let buffer='',wake=()=>{},stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',value=>stderr+=value);
 child.stdout.on('data',(chunk:string)=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){rows.push(JSON.parse(buffer.slice(0,n)));buffer=buffer.slice(n+1);}wake();});
 const until=async(count:number)=>{while(rows.length<count)await new Promise<void>(resolve=>{wake=resolve;});};
 const exited=new Promise<void>((resolve,reject)=>{child.on('exit',code=>code===0?resolve():reject(new Error(stderr)));child.on('error',reject);});
 try{
  await until(1);assert.equal(rows[0]!.ready,true);
  child.stdin.write(JSON.stringify({name:'read_operations'})+'\n'+JSON.stringify({name:'set_field',arguments:{cardId:'a',path:'/title',value:'x'}})+'\n'+JSON.stringify({name:'get_workspace'})+'\n');
  await until(4);assert.equal(rows[2]!.ok,false);assert.equal(rows[3]!.result.path,root);assert.equal(calls.length,3);
  assert.ok(calls.every(call=>call.context.actor.id==='test-ai'));assert.equal(calls[1]!.context.reviewToken,'receipt');
  child.stdin.end(JSON.stringify({name:'disconnect'})+'\n');await exited;
 }finally{child.kill();await new Promise<void>(resolve=>host.close(()=>resolve()));assert.equal(dirname(realpathSync(root)),realpathSync(tmpdir()));rmSync(root,{recursive:true,force:true});}
});
