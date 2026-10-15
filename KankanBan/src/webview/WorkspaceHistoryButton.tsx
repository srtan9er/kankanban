import {useEffect,useRef,useState} from 'react';
import {uiText} from '../i18n/text.ts';

const historyKey='kkb-recent-workspaces';
const canonical=(path:string)=>{
 const value=path.trim().replace(/[\\/]+$/,'');
 return /^[a-z]:|^\\\\/i.test(value)?value.replace(/\\/g,'/').toLowerCase():value;
};
export function recentWorkspaces(current:string,previous:unknown):string[]{
 const result:string[]=[],seen=new Set<string>();
 for(const value of [current,...(Array.isArray(previous)?previous:[])]){
  if(typeof value!=='string' || !value.trim())continue;
  const key=canonical(value);if(seen.has(key))continue;
  seen.add(key);result.push(value);if(result.length===5)break;
 }
 return result;
}
export function workspaceFolderName(path:string):string{
 return path.replace(/[\\/]+$/,'').split(/[\\/]/).at(-1) || path;
}
function loadHistory(current:string):string[]{
 try{return recentWorkspaces(current,JSON.parse(window.localStorage.getItem(historyKey) ?? '[]'));}
 catch{return recentWorkspaces(current,[]);}
}
/** App-level preferences survive workspace reloads; only opened roots are recorded. */
export function WorkspaceHistoryButton({current,busy,switchTo}:{current:string;busy:boolean;switchTo:(path:string)=>Promise<void>}){
 const [open,setOpen]=useState(false),[history,setHistory]=useState(()=>loadHistory(current));
 const host=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const next=loadHistory(current);setHistory(next);setOpen(false);
  try{window.localStorage.setItem(historyKey,JSON.stringify(next));}catch{/* Optional UI preference. */}
 },[current]);
 useEffect(()=>{
  if(!open)return;
  const outside=(event:PointerEvent)=>{if(!host.current?.contains(event.target as Node))setOpen(false);};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);host.current?.querySelector('button')?.focus();}};
  document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);};
 },[open]);
 return <div className="workspace-history" ref={host}>
  <button className="workspace-history-toggle" disabled={busy} aria-expanded={open} aria-haspopup="true" onClick={()=>setOpen(!open)}>{uiText('webview/WorkspaceApp.text025')}</button>
  {open && <div className="workspace-history-list" role="group" aria-label={uiText('webview/WorkspaceApp.recentWorkspaces')} onPointerDown={event=>event.stopPropagation()}>
   {history.map(path=><button key={path} title={path} disabled={busy} aria-current={canonical(path)===canonical(current)?'true':undefined} onClick={()=>{setOpen(false);void switchTo(path).catch(()=>{});}}>{workspaceFolderName(path)}</button>)}
  </div>}
 </div>;
}
