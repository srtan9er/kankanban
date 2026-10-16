import {Children,useEffect,useRef,useState,type ReactNode} from 'react';
import {imageFileInputs,type ImageImportInput} from './image-input.ts';
import {uiText} from '../i18n/text.ts';

export type BodyInsertPillProps={
 onImages:(inputs:ImageImportInput[])=>Promise<unknown>|void;
 onTable:()=>Promise<unknown>|void;
 disabled?:boolean;
 onError?:((message:string)=>void)|undefined;
 beforeImages?:(()=>void)|undefined;
};
let fileDialogSequence=0;

/** The system file chooser, paste and file drops use the same validated image inputs. */
export function BodyInsertPill({onImages,onTable,disabled=false,onError,beforeImages}:BodyInsertPillProps){
 const input=useRef<HTMLInputElement>(null),pending=useRef(false),[busy,setBusy]=useState(false);
 const dialog=useRef<string|null>(null),focusReset=useRef<ReturnType<typeof setTimeout>|null>(null);
 const clearDialog=()=>{
  if(focusReset.current!==null){clearTimeout(focusReset.current);focusReset.current=null;}
  if(dialog.current!==null && document.documentElement.dataset.bodyFileDialog===dialog.current)delete document.documentElement.dataset.bodyFileDialog;
  dialog.current=null;
 };
 useEffect(()=>{
  const fileInput=input.current,focus=()=>{if(dialog.current===null)return;if(focusReset.current!==null)clearTimeout(focusReset.current);focusReset.current=setTimeout(clearDialog,100);};
  fileInput?.addEventListener('cancel',clearDialog);window.addEventListener('focus',focus);
  return()=>{fileInput?.removeEventListener('cancel',clearDialog);window.removeEventListener('focus',focus);clearDialog();};
 },[]);
 const chooseImages=()=>{
  if(disabled || busy || !input.current)return;
  clearDialog();dialog.current=String(++fileDialogSequence);document.documentElement.dataset.bodyFileDialog=dialog.current;
  try{beforeImages?.();input.current.click();}catch(error){clearDialog();onError?.(String(error));}
 };
 const insert=async(files:File[])=>{
  if(disabled || pending.current || !files.length)return;
  pending.current=true;setBusy(true);onError?.('');
  try{await onImages(await imageFileInputs(files));}catch(error){onError?.(String(error));}
  finally{pending.current=false;setBusy(false);}
 };
 const insertTable=async()=>{try{await onTable();}catch(error){onError?.(String(error));}};
 return <div className="ink-pill body-insert-pill" onPointerDown={event=>{event.preventDefault();event.stopPropagation();}} onClick={event=>event.stopPropagation()}>
  <button type="button" className="image-create-button" aria-label={uiText('images.insert')} title={uiText('images.insertHint')} disabled={disabled || busy} onClick={chooseImages}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="1"/><circle cx="6.5" cy="7.5" r="1.5"/><path d="m3 15 5-5 3 3 2-2 4 4"/></svg></button>
  <button type="button" className="table-create-button" aria-label={uiText('tables.create')} title={uiText('tables.createHint')} disabled={disabled || busy} onClick={()=>{void insertTable();}}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="2" width="16" height="16" rx="1"/><path d="M2 8h16M8 2v16"/></svg></button>
  <input ref={input} className="body-image-file-input" type="file" hidden multiple accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif" disabled={disabled || busy} onChange={event=>{const files=[...(event.currentTarget.files ?? [])];event.currentTarget.value='';clearDialog();void insert(files);}}/>
 </div>;
}

export function BodyToolStack({children}:{children:ReactNode}){
 return <div className="body-create-tools body-tool-stack" style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6}}>{Children.map(children,child=>child==null?null:<div className="body-tool-row" style={{display:'flex',justifyContent:'flex-end',alignItems:'center',flex:'none'}}>{child}</div>)}</div>;
}
