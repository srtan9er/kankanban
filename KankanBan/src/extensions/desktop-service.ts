import type {ExtensionService} from './registry.ts';
export type ExtensionTransport=(channel:'control'|'start'|'job',args:Record<string,unknown>)=>Promise<any>;
export class DesktopExtensionService implements ExtensionService {
 private value:Record<string,unknown>={};
 readonly id:string;
 private call:ExtensionTransport;
 constructor(id:string,call:ExtensionTransport){this.id=id;this.call=call;}
 async initialize(config:Record<string,unknown>){this.value=await this.call('control',{id:this.id,method:'initialize',args:config});}
 async enable(){this.value=await this.call('control',{id:this.id,method:'enable',args:{}});}
 async disable(){this.value=await this.call('control',{id:this.id,method:'disable',args:{}});}
 async dispose(){await this.call('control',{id:this.id,method:'dispose',args:{}});this.value={};}
 async configure(config:Record<string,unknown>){this.value=await this.call('control',{id:this.id,method:'configure',args:config});}
 async invoke(method:string,args:Record<string,unknown>){const result=await this.call('start',{id:this.id,method,args});this.value={...this.value,running:true,jobId:result.jobId,method};return result;}
 complete(reply:unknown){this.value={...this.value,running:false,lastResult:reply};}
 status(){const {lastResult:_,...status}=this.value;return status;}
}
