import {uiText} from '../i18n/text.ts';
import {useContext,useState} from 'react';
import {EditMode} from './edit-mode.ts';
import type {CardFields} from '../core/types.ts';
import type {Request} from './controller.ts';
import {prepareEditors} from './drafts.ts';

export function PrefabSyncButtons({card,send}:{card:CardFields;send:(request:Request)=>Promise<unknown>}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const {editable}=useContext(EditMode);
 if(!editable)return null;
 if(!card.isPrefab && !card.prefabRef)return null;
 const sync=async(target:'prefab'|'all')=>{
  if(busy)return;setBusy(true);setError('');
  try{await prepareEditors();await send({kind:'prefab-sync',id:card.id,target});}
  catch(error){setError(String(error));}finally{setBusy(false);}
 };
 const description=(text:string)=>error?uiText("webview/PrefabSyncButtons.text002", {arg0: (text), arg1: (error)}):busy?uiText("webview/PrefabSyncButtons.text003"):text;
 return <div className={`prefab-sync-controls ${error?'sync-error':''}`} onPointerDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()}>
  {!card.isPrefab && <button type="button" disabled={busy} aria-label={uiText("webview/PrefabSyncButtons.text004")} title={description(uiText("webview/PrefabSyncButtons.text005"))} onClick={()=>void sync('prefab')}><span aria-hidden="true"/></button>}
  <button type="button" disabled={busy} aria-label={uiText("webview/PrefabSyncButtons.text006")} title={description(card.isPrefab?uiText("webview/PrefabSyncButtons.text007"):uiText("webview/PrefabSyncButtons.text008"))} onClick={()=>void sync('all')}><span aria-hidden="true"/></button>
  {error && <span className="sync-error-message" role="alert">{error}</span>}
 </div>;
}
