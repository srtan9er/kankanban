import {invoke} from '@tauri-apps/api/core';
import {isTauri} from '../webview/tauri-backend.ts';
import {compileTheme,type ThemeEntry,type ThemeAsset} from './compiler.ts';
import {uiText} from '../i18n/text.ts';
export type ThemeCatalog={directory:string;themes:ThemeEntry[]};
export const themeCatalog=():Promise<ThemeCatalog>=>isTauri()?invoke('theme_catalog'):Promise.resolve({directory:'',themes:[]});
export const themeSource=(path:string):Promise<ThemeAsset|null>=>invoke('theme_read',{path});
type Preference={id:string;skin:string};
type ThemeServices={catalog:()=>Promise<ThemeCatalog>;compile:(id:string)=>Promise<string>;mount:(css:string,id:string)=>Promise<HTMLElement|null>};
async function mountCss(css:string,id:string):Promise<HTMLElement|null>{
 if(!css)return null;const next=document.createElement('link');next.rel='stylesheet';next.dataset.kkbTheme=id;next.href=`data:text/css;charset=utf-8,${encodeURIComponent(css)}`;
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{next.remove();reject(new Error(uiText('themes.invalidCss',{arg0:id})));},8000);next.onload=()=>{clearTimeout(timer);resolve();};next.onerror=()=>{clearTimeout(timer);next.remove();reject(new Error(uiText('themes.invalidCss',{arg0:id})));};document.head.append(next);});return next;
}
const nativeServices:ThemeServices={catalog:themeCatalog,compile:id=>isTauri()?compileTheme(id,themeSource):Promise.resolve(''),mount:mountCss};
/** One per webview. A preview never changes persisted workspace preferences. */
export class ThemeRuntime {
 private saved:Preference={id:'',skin:'light'};
 private preview:string|null=null;
 private active:string|null=null;private activeMode:string|undefined;private revision=0;private element:HTMLElement|null=null;private pending:Promise<void>|null=null;
 private report:(error:unknown)=>void;
 private services:ThemeServices;
 private refresh=()=>{void this.load(this.preview ?? this.saved.id,true).catch(error=>this.report(error));};
 constructor(report:(error:unknown)=>void=()=>{},services:ThemeServices=nativeServices){this.report=report;this.services=services;}
 async set(id:string,skin:string):Promise<void>{const previous=this.saved;this.saved={id,skin};if(this.preview===null){if(previous.id===id&&this.pending)return this.pending;if(previous.id!==id || this.active!==id){const task=this.load(id),version=this.revision;this.pending=task;try{await task;}catch(error){if(version===this.revision){this.fallback(id);this.report(error);}}finally{if(this.pending===task)this.pending=null;}}else if(previous.skin!==skin)this.mode(this.activeMode ?? skin);}}
 async show(id:string):Promise<void>{const task=this.load(id,true),version=this.revision;await task;if(version===this.revision)this.preview=id;}
 async restore():Promise<void>{this.preview=null;const task=this.load(this.saved.id,true),version=this.revision;try{await task;}catch(error){if(version===this.revision){this.fallback(this.saved.id);this.report(error);}throw error;}}
 async reload():Promise<void>{await this.load(this.preview ?? this.saved.id,true);}
 start(){window.addEventListener('kkb:theme-reload',this.refresh);return()=>{window.removeEventListener('kkb:theme-reload',this.refresh);this.revision++;this.element?.remove();};}
 private mode(skin:string){document.documentElement.dataset.theme=skin;document.documentElement.dispatchEvent(new Event('kkb:theme-change'));}
 private fallback(id:string){this.revision++;this.element?.remove();this.element=null;this.active=id;this.activeMode=undefined;this.mode(this.saved.skin);}
 private async load(id:string,force=false):Promise<void>{
  if(!force&&this.active===id){this.mode(this.activeMode ?? this.saved.skin);return;}const version=++this.revision;
  const catalog=await this.services.catalog(),entry=catalog.themes.find(t=>t.id===id),css=await this.services.compile(id);if(version!==this.revision)return;
  const next=await this.services.mount(css,id);
  if(version!==this.revision){next?.remove();return;}this.element?.remove();this.element=next;this.active=id;this.activeMode=entry?.mode;this.mode(entry?.mode ?? this.saved.skin);
  if(document.fonts)void document.fonts.ready.then(()=>{if(version===this.revision)document.documentElement.dispatchEvent(new Event('kkb:theme-change'));});
 }
}
export let themeRuntime:ThemeRuntime;
export function connectThemeRuntime(report:(error:unknown)=>void,services:ThemeServices=nativeServices){themeRuntime=new ThemeRuntime(report,services);return themeRuntime.start();}
