import {readFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createConnection} from 'node:net';
import {uiText} from '../i18n/text.ts';
import {validateToolCall} from './tools.ts';
import type {McpContext} from '../core/collaboration.ts';
type Discovery={version:1;host:'127.0.0.1';port:number;token:string;root:string};
function appDirectory():string {
 const home=homedir();
 return join(process.platform==='win32'?process.env.APPDATA ?? join(home,'AppData','Roaming'):process.platform==='darwin'?join(home,'Library','Application Support'):process.env.XDG_DATA_HOME ?? join(home,'.local','share'),'com.kankanban.app');
}
export function desktopWorkspace(explicit?:string):string {
 if(explicit)return resolve(explicit);
 const app=appDirectory();
 try {const saved=readFileSync(join(app,'workspace-path.txt'),'utf8').trim();if(saved)return resolve(saved);}catch{/* Use the app default before its first selection. */}
 return join(app,'workspace');
}
function discovery(explicit?:string):Discovery {
 const root=desktopWorkspace(explicit);
 let data:unknown;
 try {data=JSON.parse(readFileSync(join(root,'.kkb','mcp-bridge.json'),'utf8'));}catch{throw new Error(uiText('mcp/desktop.notRunning'));}
 const value=data as Discovery;
 if(!value || value.version!==1 || value.host!=='127.0.0.1' || !Number.isInteger(value.port) || value.port<1 || value.port>65535 || typeof value.token!=='string' || !/^[a-f0-9]{64}$/.test(value.token) || typeof value.root!=='string')throw new Error(uiText('mcp/desktop.invalidDiscovery'));
 let actual:string,expected:string;
 try {actual=realpathSync(value.root);expected=realpathSync(root);}catch{throw new Error(uiText('mcp/desktop.invalidDiscovery'));}
 if(actual!==expected)throw new Error(uiText('mcp/desktop.workspaceChanged'));
 return value;
}
/** No workspace session or file writes: each call discovers the current desktop endpoint. */
export function desktopToolCaller(explicit?:string):(name:string,args:Record<string,unknown>,context?:McpContext)=>Promise<unknown> {
 return async(name,args,context)=>{
  validateToolCall(name,args);
  const endpoint=discovery(explicit);
  const wire=JSON.stringify({token:endpoint.token,workspace:endpoint.root,tool:name,args,context})+'\n';
  if(Buffer.byteLength(wire)>1_048_576)throw new Error(uiText('native/mcpBridge.invalidRequest'));
  return new Promise((resolve,reject)=>{
   const socket=createConnection({host:endpoint.host,port:endpoint.port});
   let settled=false,bytes=0,buffer='';
   const finish=(error?:Error,result?:unknown)=>{if(settled)return;settled=true;socket.destroy();if(error)reject(error);else resolve(result);};
   socket.setEncoding('utf8');socket.setTimeout(35_000);
   socket.on('connect',()=>socket.end(wire));
   socket.on('timeout',()=>finish(new Error(uiText('mcp/desktop.timeout'))));
   socket.on('error',()=>finish(new Error(uiText('mcp/desktop.connectionLost'))));
   socket.on('close',()=>{if(!settled)finish(new Error(uiText('mcp/desktop.connectionLost')));});
   socket.on('data',(chunk:string)=>{
    bytes+=Buffer.byteLength(chunk);if(bytes>16_777_216){finish(new Error(uiText('mcp/desktop.invalidReply')));return;}
    buffer+=chunk;const newline=buffer.indexOf('\n');if(newline<0)return;
    try {
     const reply=JSON.parse(buffer.slice(0,newline)) as Record<string,unknown>;
     if(!reply || typeof reply!=='object' || Array.isArray(reply))throw new Error();
     if(typeof reply.error==='string')finish(new Error(reply.error));
     else if(Object.hasOwn(reply,'result'))finish(undefined,reply.result);
     else finish(new Error(uiText('mcp/desktop.invalidReply')));
    }catch{finish(new Error(uiText('mcp/desktop.invalidReply')));}
   });
  });
 };
}
