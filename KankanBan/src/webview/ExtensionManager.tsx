import {AVAILABLE_EXTENSIONS,extensionAnchor} from '../extensions/registry.ts';
import {uiText} from '../i18n/text.ts';
import type {WorkspaceController,Request} from './controller.ts';
import './git-panel.css';
import {useState} from 'react';
export function ExtensionManager({controller:c,send,open}:{controller:WorkspaceController;send:(r:Request)=>Promise<unknown>;open:(id:string)=>void}){
 const [editing,setEditing]=useState<string|null>(null),[configuration,setConfiguration]=useState(''),[error,setError]=useState('');
 const control=async(request:Request)=>{try{await send(request);setError('');}catch(e){setError(String(e));}};
 return <section className="extension-list">{AVAILABLE_EXTENSIONS.map(extension=>{const preference=c.view.extensions?.[extension.id],installed=preference?.installed!==false,enabled=installed && preference?.enabled!==false;
  return <article className="task-card" tabIndex={0} key={extension.id} onDoubleClick={()=>{if(enabled)open(extensionAnchor(extension.id));}} onKeyDown={e=>{if(e.target===e.currentTarget && e.key==='Enter' && enabled)open(extensionAnchor(extension.id));}}><h3>{uiText(extension.nameKey)}</h3><p>{uiText(extension.descriptionKey)}</p><small>{uiText('extensions.version',{arg0:extension.version})} · {uiText(!installed?'extensions.uninstalled':enabled?'extensions.enabled':'extensions.disabled')}</small><div className="extension-controls" onDoubleClick={e=>e.stopPropagation()}>
   <button disabled={c.busy || c.hasExtensionJobs} onClick={()=>void control({kind:'extension-control',id:extension.id,method:!installed?'install':enabled?'disable':'enable'})}>{uiText(!installed?'extensions.install':enabled?'extensions.disable':'extensions.enable')}</button>
   {installed&&<><button onClick={()=>{setEditing(editing===extension.id?null:extension.id);setConfiguration(JSON.stringify(preference?.config ?? {},null,2));}}>{uiText('extensions.configure')}</button><button disabled={c.busy || c.hasExtensionJobs} onClick={()=>{if(window.confirm(uiText('extensions.confirmUninstall')))void control({kind:'extension-control',id:extension.id,method:'uninstall'});}}>{uiText('extensions.uninstall')}</button></>}
  </div>{editing===extension.id&&<form onDoubleClick={e=>e.stopPropagation()} onSubmit={e=>{e.preventDefault();try{const config=JSON.parse(configuration);if(!config || typeof config!=='object' || Array.isArray(config))throw new Error(uiText('extensions.invalidConfig'));void control({kind:'extension-control',id:extension.id,method:'configure',config});}catch(e){setError(String(e));}}}><textarea aria-label={uiText('extensions.configure')} value={configuration} onChange={e=>setConfiguration(e.target.value)}/><button disabled={c.busy || c.hasExtensionJobs}>{uiText('extensions.saveConfig')}</button></form>}{error&&<p role="alert">{error}</p>}</article>;
 })}</section>;
}
