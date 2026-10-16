import {useEffect,useRef,useState} from 'react';
import {getCurrentWebview} from '@tauri-apps/api/webview';
import {isTauri} from './tauri-backend.ts';
import {imageFileInputs,type ImageImportInput} from './image-input.ts';
import {getMarkdownEditorSelection} from './markdown-editor-model.ts';
import {getVisualEditorSelection} from './VisualBodyEditor.tsx';
/** Native file drops and browser clipboard images converge on the main writer. */
export type ImageInsertion={beforeContent:string;offset:number};
export function useImageInput(enabled:boolean,accept:(inputs:ImageImportInput[],position?:ImageInsertion)=>Promise<void>,report:(error:string)=>void) {
 const latest=useRef({enabled,accept,report});latest.current={enabled,accept,report};
 const [over,setOver]=useState(false);
 useEffect(()=>{
  const files=async(items:File[],position?:ImageInsertion)=>{try{await latest.current.accept(await imageFileInputs(items),position);}catch(error){latest.current.report(String(error));}};
  const paste=(event:ClipboardEvent)=>{
   if(!latest.current.enabled)return;
   const images=[...(event.clipboardData?.items ?? [])].filter(item=>item.kind==='file' && item.type.startsWith('image/')).map(item=>item.getAsFile()).filter((file):file is File=>!!file);
   if(images.length){event.preventDefault();event.stopPropagation();const target=event.target as HTMLElement|null,editor=target?.closest<HTMLElement>('[data-markdown-editor]'),range=editor?(editor.hasAttribute('data-visual-editor')?getVisualEditorSelection(editor):getMarkdownEditorSelection(editor)):undefined;const position=range?{beforeContent:range.beforeContent,offset:range.offset}:target?.tagName==='TEXTAREA'?{beforeContent:(target as HTMLTextAreaElement).value,offset:(target as HTMLTextAreaElement).selectionStart}:undefined;void files(images,position);}
  };
  const drop=(event:DragEvent)=>{
   if(!latest.current.enabled || isTauri() || !event.dataTransfer?.files.length)return;
   event.preventDefault();event.stopPropagation();setOver(false);void files([...event.dataTransfer.files]);
  };
  const dragover=(event:DragEvent)=>{if(latest.current.enabled && !isTauri() && event.dataTransfer?.types.includes('Files')){event.preventDefault();setOver(true);}};
  document.addEventListener('paste',paste,true);document.addEventListener('drop',drop,true);document.addEventListener('dragover',dragover,true);
  let disposed=false,stop:(()=>void)|undefined;
  if(isTauri())void getCurrentWebview().onDragDropEvent((event:{payload:{type:'enter'|'over'|'leave'|'drop';paths?:string[]}})=>{
   if(!latest.current.enabled)return;
   const payload=event.payload;
   setOver(payload.type==='enter' || payload.type==='over');
   if(payload.type==='drop')void latest.current.accept((payload.paths ?? []).map(path=>({path,name:path.replaceAll('\\','/').split('/').at(-1)!}))).catch(error=>latest.current.report(String(error)));
  }).then(unlisten=>{if(disposed)unlisten();else stop=unlisten;}).catch(error=>latest.current.report(String(error)));
  return()=>{disposed=true;stop?.();document.removeEventListener('paste',paste,true);document.removeEventListener('drop',drop,true);document.removeEventListener('dragover',dragover,true);};
 },[]);
 return over;
}
