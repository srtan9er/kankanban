import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {validateActor} from '../src/core/collaboration.ts';
import {uiText} from '../src/i18n/text.ts';
// Keep one SDK/stdio connection for all JSON lines; never replay failed requests.
const flags=new Map();
for(let i=2;i<process.argv.length;i++){
 const flag=process.argv[i];
 if(flag==='--help'){process.stdout.write(uiText('mcp/client.help')+'\n');process.exit(0);}
 if(!['--id','--name','--workspace'].includes(flag)||!process.argv[i+1])throw new Error(uiText('mcp/client.invalidArguments'));
 flags.set(flag,process.argv[++i]);
}
const actor=validateActor({kind:'ai',id:flags.get('--id'),name:flags.get('--name')},'ai');
const client=new Client({name:'kankanban-agent',version:'1'}),lines=createInterface({input:process.stdin,terminal:false});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp/main.ts',import.meta.url)),...(flags.has('--workspace')?[flags.get('--workspace')]:[])],stderr:'pipe'});
const send=async(name,args)=>{
 const reply=await client.callTool({name,arguments:args});
 const text=reply.content.find(block=>block.type==='text')?.text;
 if(reply.isError)return {ok:false,error:text};
 if(reply.content.some(block=>block.type!=='text'))return {ok:true,content:reply.content};
 return {ok:true,result:text?JSON.parse(text):null};
};
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
process.once('SIGINT',()=>lines.close());process.once('SIGTERM',()=>lines.close());
try{
 await client.connect(transport);
 const identified=await send('identify_actor',{id:actor.id,name:actor.name});if(!identified.ok)throw new Error(identified.error);
 output({ready:true,actor});
 for await(const line of lines){
  if(!line.trim())continue;
  try{
   let call;try{call=JSON.parse(line);}catch{throw new Error(uiText('mcp/client.invalidCall'));}
   if(!call || typeof call.name!=='string' || (call.arguments!==undefined && (!call.arguments || typeof call.arguments!=='object'||Array.isArray(call.arguments))))throw new Error(uiText('mcp/client.invalidCall'));
   if(call.name==='disconnect')break;
   output(await send(call.name,call.arguments ?? {}));
  }catch(error){output({ok:false,error:error instanceof Error?error.message:String(error)});}
 }
}finally{lines.close();await client.close();}
