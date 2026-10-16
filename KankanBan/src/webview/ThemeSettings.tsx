import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {emit} from '@tauri-apps/api/event';
import {themeCatalog,themeRuntime,type ThemeCatalog} from '../themes/runtime.ts';
import {uiText} from '../i18n/text.ts';
import {isTauri} from './tauri-backend.ts';
import {Markdown} from './Markdown.tsx';
import type {Request,WorkspaceController} from './controller.ts';
export function ThemeSettings({controller:c,send}:{controller:WorkspaceController;send:(request:Request)=>Promise<unknown>}){
 const [catalog,setCatalog]=useState<ThemeCatalog>({directory:'',themes:[]}),[selected,setSelected]=useState(c.view.theme ?? ''),[preview,setPreview]=useState(false),[previewName,setPreviewName]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const task=async(action:()=>Promise<void>)=>{setBusy(true);setMessage('');try{await action();}catch(error){setMessage(String(error));}finally{setBusy(false);}};
 useEffect(()=>{void themeCatalog().then(setCatalog).catch(error=>setMessage(String(error)));return()=>{void themeRuntime?.restore().catch(()=>{});};},[]);
 return <section className="settings-card theme-settings"><h3>{uiText('themes.title')}</h3><p>{uiText('themes.help')}</p>
  <label>{uiText('themes.choose')}<select value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}><option value="">{uiText('themes.default')}</option>{catalog.themes.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
  <div className="theme-actions"><button disabled={busy} onClick={()=>void task(async()=>{await themeRuntime?.show(selected);setPreview(true);setPreviewName(catalog.themes.find(t=>t.id===selected)?.name ?? uiText('themes.default'));})}>{uiText('themes.preview')}</button>
   <button disabled={busy} onClick={()=>void task(async()=>{await themeRuntime?.show(selected);setPreview(true);await send({kind:'theme',theme:selected});await themeRuntime?.restore();setPreview(false);if(isTauri())await emit('kkb:theme-reload');setMessage(uiText('themes.applied'));})}>{uiText('themes.apply')}</button>
   {preview&&<button disabled={busy} onClick={()=>void task(async()=>{await themeRuntime?.restore();setPreview(false);})}>{uiText('themes.cancel')}</button>}
   <button disabled={busy} onClick={()=>void task(async()=>{setCatalog(await themeCatalog());if(preview){await themeRuntime?.show(selected);}else{await themeRuntime?.reload();if(isTauri())await emit('kkb:theme-reload');}})}>{uiText('themes.reload')}</button>
   {isTauri()&&<button disabled={busy} onClick={()=>void task(async()=>{await invoke('theme_open_folder');})}>{uiText('themes.openFolder')}</button>}</div>
  {catalog.directory&&<p className="theme-directory">{catalog.directory}</p>}{!isTauri()&&<p>{uiText('themes.browser')}</p>}
  {preview&&<p role="status">{uiText('themes.previewing',{arg0:previewName})}</p>}
  <div className="theme-specimen"><Markdown text={uiText('themes.sampleBody')}/></div>{message&&<p role="status">{message}</p>}
 </section>;
}
