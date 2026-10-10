import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import texts from '../src/i18n/zh-CN.json' with {type:'json'};
const root=fileURLToPath(new URL('../',import.meta.url));
const address='http://localhost:5183';
const sameProject=async()=>{
 try {
  const response=await fetch(`${address}/__kkb_dev`,{signal:AbortSignal.timeout(1000)});
  const identity=await response.json();
  return response.ok && typeof identity.root==='string' && resolve(identity.root)===resolve(root);
 } catch {return false;}
};
if(await sameProject()){
 console.log(texts['scripts/dev'].reuse.replace('{arg0}',address));
 let checking=false;
 const timer=setInterval(async()=>{if(checking)return;checking=true;try{if(!await sameProject()){console.error(texts['scripts/dev'].lost);clearInterval(timer);process.exitCode=1;}}finally{checking=false;}},2000);
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);process.exit(0);});
}else{
 const child=spawn(process.execPath,[fileURLToPath(new URL('../node_modules/vite/bin/vite.js',import.meta.url))],{cwd:root,stdio:'inherit'});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
 child.on('error',error=>{console.error(error);process.exitCode=1;});
 child.on('exit',code=>{process.exitCode=code ?? 1;});
}
