import {uiText,type TextKey} from '../i18n/text.ts';
import {validExtensionTutorial,type ExtensionTutorial} from '../core/tutorial-schema.ts';
import {gitTutorial} from './git/tutorial.ts';
export const EXTENSION_API_VERSION=2;
export type ExtensionConfig={installed:boolean;enabled:boolean;config:Record<string,unknown>};
export type ExtensionManifest={id:string;version:string;apiVersion:number;nameKey:TextKey;descriptionKey:TextKey;capabilities:readonly string[];tutorial:ExtensionTutorial};
export type ExtensionEvent={id:string;kind:'state'|'result';requestId?:string;value:unknown};
export interface ExtensionService {
 initialize(config:Record<string,unknown>):Promise<void>;
 enable():Promise<void>;disable():Promise<void>;dispose():Promise<void>;
 configure(config:Record<string,unknown>):Promise<void>;
 invoke(method:string,args:Record<string,unknown>):Promise<unknown>;
 status():unknown;
}
export class ExtensionHost {
 private entries=new Map<string,{manifest:ExtensionManifest;service:ExtensionService;enabled:boolean}>();
 private listeners=new Set<(event:ExtensionEvent)=>void>();
 register(manifest:ExtensionManifest,service:ExtensionService):void{
  if(manifest.apiVersion!==EXTENSION_API_VERSION)throw new Error(uiText('extensions.unsupported'));
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id))throw new Error(uiText('extensions.invalid'));
  if(!validExtensionTutorial(manifest.tutorial))throw new Error(uiText('extensions.invalidTutorial'));
  if(this.entries.has(manifest.id))throw new Error(uiText('extensions.duplicate'));
  this.entries.set(manifest.id,{manifest,service,enabled:false});
 }
 list(){return [...this.entries.values()].map(e=>({...e.manifest,enabled:e.enabled,status:e.service.status()}));}
 subscribe(listener:(event:ExtensionEvent)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 publish(event:ExtensionEvent){for(const listener of this.listeners)listener(event);}
 private entry(id:string){const e=this.entries.get(id);if(!e)throw new Error(uiText('extensions.missing'));return e;}
 async initialize(id:string,config:Record<string,unknown>){await this.entry(id).service.initialize(config);}
 async enable(id:string){const e=this.entry(id);await e.service.enable();e.enabled=true;this.publish({id,kind:'state',value:e.service.status()});}
 async disable(id:string){const e=this.entry(id);await e.service.disable();e.enabled=false;this.publish({id,kind:'state',value:e.service.status()});}
 async configure(id:string,config:Record<string,unknown>){await this.entry(id).service.configure(config);this.publish({id,kind:'state',value:this.entry(id).service.status()});}
 async uninstall(id:string){await this.disable(id);await this.entry(id).service.dispose();this.entries.delete(id);this.publish({id,kind:'state',value:null});}
 async invoke(id:string,method:string,args:Record<string,unknown>={}){const e=this.entry(id);if(!e.enabled)throw new Error(uiText('extensions.notEnabled'));const result=await e.service.invoke(method,args);this.publish({id,kind:'result',value:result});return result;}
}
export const GIT_EXTENSION:ExtensionManifest={id:'git',version:'0.2.0',apiVersion:EXTENSION_API_VERSION,nameKey:'extensions.git',descriptionKey:'extensions.gitDescription',capabilities:['project-git'],tutorial:gitTutorial};
export const AVAILABLE_EXTENSIONS:readonly ExtensionManifest[]=[GIT_EXTENSION];
export const extensionAnchor=(id:string)=>`ext-${id}`;
export const extensionId=(anchor:string)=>anchor.startsWith('ext-')?anchor.slice(4):null;
export function extensionAvailable(anchor:string,preferences?:Record<string,ExtensionConfig>):boolean{
 const id=extensionId(anchor);return id!==null && AVAILABLE_EXTENSIONS.some(e=>e.id===id) && (preferences?.[id]?.installed ?? true) && (preferences?.[id]?.enabled ?? true);
}
