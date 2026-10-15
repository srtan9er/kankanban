import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {prepareWithSegments,measureNaturalWidth,clearCache,type PreparedTextWithSegments} from '@chenglou/pretext';
import {CARD_MIN_HEIGHT} from '../core/layout-metrics.ts';
import {previewLayout,type PreviewLine} from './preview-layout.ts';
type Layout={lines:PreviewLine[];lineHeight:number;height:number};
const number=(value:string)=>parseFloat(value)||0;
function ellipsis(text:string,width:number,font:string,spacing:number):string {
 const parts=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text.trimEnd())].map(s=>s.segment);
 while(parts.length && measureNaturalWidth(prepareWithSegments(parts.join('')+'…',font,{letterSpacing:spacing}))>width)parts.pop();
 return parts.join('')+'…';
}
/** Prepared glyph widths are reused; only line routing runs when available space changes. */
export function ChildPreview({text,full,deleteButton}:{text:string;full:boolean;deleteButton:ReactNode}){
 const host=useRef<HTMLDivElement>(null),prepared=useRef<{key:string;value:PreparedTextWithSegments}|null>(null),last=useRef('');
 const [model,setModel]=useState<Layout|null>(null),canDelete=!!deleteButton;
 useLayoutEffect(()=>{
  const element=host.current,card=element?.closest<HTMLElement>('.task-card');if(!element || !card)return;
  let frame:number|null=null,disposed=false;
  const measure=()=>{
   if(disposed)return;const width=element.clientWidth,reserved=canDelete?28:0;if(width<=reserved+1)return;
   const style=getComputedStyle(element),cardStyle=getComputedStyle(card),title=card.querySelector<HTMLElement>('.child-title-row');
   const lineHeight=number(style.lineHeight)||number(style.fontSize)*1.45||17.4,font=`${style.fontStyle || 'normal'} ${style.fontWeight || '400'} ${style.fontSize || '12px'} ${style.fontFamily || 'sans-serif'}`,spacing=number(style.letterSpacing);
   const bounded=!!card.closest('.horizontal-card-list,.canvas-surface');
   const outer=full?(number(cardStyle.maxHeight)||CARD_MIN_HEIGHT*2):bounded?card.offsetHeight:number(cardStyle.maxHeight)||Infinity;
   const room=outer-number(cardStyle.paddingTop)-number(cardStyle.paddingBottom)-number(cardStyle.borderTopWidth)-number(cardStyle.borderBottomWidth)-(title?.offsetHeight ?? 0)-number(style.marginTop);
   const maxLines=Math.max(1,Math.min(full?20:3,Number.isFinite(room)?Math.floor(room/lineHeight):3));
   const source=text.slice(0,8192),key=JSON.stringify([source,font,spacing,full]);
   const geometry=JSON.stringify([key,width,maxLines,lineHeight,canDelete]);if(last.current===geometry)return;
   try{
    if(prepared.current?.key!==key)prepared.current={key,value:prepareWithSegments(source,font,{whiteSpace:full?'pre-wrap':'normal',letterSpacing:spacing})};
    const result=previewLayout(prepared.current.value,width,maxLines,reserved),tail=result.lines.at(-1);
    if(tail && (result.overflow || text.length>source.length))tail.text=ellipsis(tail.text,tail.slotWidth,font,spacing);
    last.current=geometry;element.removeAttribute('data-layout-error');setModel({lines:result.lines,lineHeight,height:Math.max(canDelete?24:0,result.lines.length*lineHeight)});
   }catch(error){element.dataset.layoutError=String(error);setModel(null);}
  };
  const schedule=()=>{if(frame!==null || disposed)return;frame=requestAnimationFrame(()=>{frame=null;measure();});};
  const title=card.querySelector<HTMLElement>('.child-title-row');
  const observer=new ResizeObserver(schedule);observer.observe(element);observer.observe(card);if(title)observer.observe(title);
  const fontsChanged=()=>{clearCache();prepared.current=null;last.current='';schedule();};
  document.fonts?.addEventListener('loadingdone',fontsChanged);if(document.fonts?.status==='loading')void document.fonts.ready.then(()=>{if(!disposed)fontsChanged();});
  last.current='';measure();
  return()=>{disposed=true;observer.disconnect();if(frame!==null)cancelAnimationFrame(frame);document.fonts?.removeEventListener('loadingdone',fontsChanged);};
 },[text,full,canDelete]);
 return <div ref={host} className="child-preview" data-layout={model?'pretext':'fallback'} style={model?{height:model.height}:undefined}>
  {text && (model?<p className="task-preview pretext-preview">{model.lines.map((line,i)=><span className="preview-line" key={i} style={{width:line.slotWidth,height:model.lineHeight,lineHeight:`${model.lineHeight}px`}}>{line.text || '\u00a0'}</span>)}</p>:<p className="task-preview preview-fallback">{text}</p>)}
  {deleteButton}
 </div>;
}
