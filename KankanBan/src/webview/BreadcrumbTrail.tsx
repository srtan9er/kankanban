import {uiText} from '../i18n/text.ts';
import {useLayoutEffect,useRef,useState} from 'react';

/** Keep the root, then fit whole nodes starting at the current card. */
export function BreadcrumbTrail({ids,titleOf,navigate}:{ids:readonly string[];titleOf:(id:string)=>string;navigate:(id:string)=>void}) {
 const host=useRef<HTMLElement>(null),measure=useRef<HTMLDivElement>(null);
 const [first,setFirst]=useState(1);
 const labels=ids.map(titleOf),signature=JSON.stringify([ids,labels]);
 useLayoutEffect(()=>{
  const element=host.current,probe=measure.current;if(!element || !probe)return;
  const fit=()=>{
   const widths=[...probe.children].map(node=>node.getBoundingClientRect().width);
   const total=Math.max(0,element.clientWidth-26),root=Math.min(widths[0] ?? 0,ids.length>1?total*.4:total);
   let space=Math.max(0,total-root),start=ids.length;
   // Reserve the omission marker when not all ancestors can fit.
   const hidden=widths.slice(1).reduce((a,b)=>a+b,0)>space;
   if(hidden && ids.length>2)space=Math.max(0,space-18);
   for(let i=ids.length-1;i>=1;i--){
    const width=widths[i] ?? 0;
    if(start!==ids.length && width>space)break;
    start=i;space-=width;
   }
   setFirst(Math.max(1,start));
  };
  const observer=new ResizeObserver(fit);observer.observe(element);observer.observe(probe);fit();
  return()=>observer.disconnect();
 },[signature]);
 if(!ids.length)return null;
 const node=(id:string,index:number,measuring=false)=><span className={`breadcrumb-node ${index===0?'breadcrumb-root':''}`} key={id}>
  {index>0 && <span className="breadcrumb-separator" aria-hidden="true">/</span>}
  <button type="button" tabIndex={measuring?-1:0} title={titleOf(id)} aria-current={!measuring && index===ids.length-1?'page':undefined} onClick={()=>navigate(id)}>{titleOf(id)}</button>
 </span>;
 return <nav ref={host} className={`breadcrumb-trail ${ids.length===1?'breadcrumb-trail-single':''}`} aria-label={uiText("webview/BreadcrumbTrail.text001")}>
  <button type="button" className="breadcrumb-back" disabled={ids.length<2} aria-label={uiText("webview/BreadcrumbTrail.back")} title={uiText("webview/BreadcrumbTrail.back")} onClick={()=>{const parent=ids.at(-2);if(parent)navigate(parent);}}>←</button>
  {node(ids[0]!,0)}
  {first>1 && <span className="breadcrumb-omission" title={labels.slice(1,first).join(' / ')}>…</span>}
  <span className="breadcrumb-tail">{ids.slice(first).map((id,i)=>node(id,first+i))}</span>
  <div ref={measure} className="breadcrumb-measure" aria-hidden="true">{ids.map((id,i)=>node(id,i,true))}</div>
 </nav>;
}
