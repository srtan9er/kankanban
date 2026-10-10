import {useLayoutEffect,useEffect,useRef,useState,type CSSProperties} from 'react';
import {emptyInk,type InkDocument} from '../core/drawing.ts';
import type {Request} from './controller.ts';
import {useInk,useDoodleMode,InkPill} from './Ink.tsx';
import {registerEditor} from './drafts.ts';
import {Markdown} from './Markdown.tsx';
export function DrawingBody({id,content,doodle,placeholder,send,prepare}:{id:string;content:string;doodle?:InkDocument|null;placeholder?:string;send:(request:Request)=>Promise<unknown>;prepare?:()=>Promise<unknown>}) {
 const host=useRef<HTMLDivElement>(null),seed=useRef(emptyInk('doodle',1,1)),extent=useRef({width:1,height:1});
 const [size,setSize]=useState({width:1,height:1,panel:1}),[paperHeight,setPaperHeight]=useState(0);
 const paper=useRef(0);
 const ink=useInk(doodle ?? seed.current,(document,before)=>{
  const bottom=Math.max(1,...document.strokes.map(stroke=>Math.max(...stroke.points.map(p=>p.y))+stroke.width+4));
  return send({kind:'doodle-update',id,document:{...document,width:extent.current.width,height:bottom},before});
 });
 const mode=useDoodleMode(host,ink,prepare);
 useLayoutEffect(()=>{
  const element=host.current;if(!element)return;const parent=element.closest<HTMLElement>('.preview') ?? element.parentElement;
  const measure=()=>{
   const styles=parent?getComputedStyle(parent):null;
   const panel=Math.max(1,(parent?.clientHeight ?? 1)-parseFloat(styles?.paddingTop ?? '0')-parseFloat(styles?.paddingBottom ?? '0'));
   const next={width:Math.max(1,element.clientWidth),height:Math.max(1,element.clientHeight),panel};extent.current=next;
   setSize(old=>old.width===next.width && old.height===next.height && old.panel===next.panel?old:next);
  };
  const grow=()=>{const height=Math.max(element.clientHeight,paper.current)+Math.max(100,(parent?.clientHeight ?? 200));paper.current=height;element.style.minHeight=`${height}px`;setPaperHeight(height);};
  const wheel=(event:WheelEvent)=>{if(mode.mode && event.deltaY>0 && !event.ctrlKey && parent && parent.scrollHeight-parent.scrollTop-parent.clientHeight<Math.max(32,parent.clientHeight*.3))grow();};
  const scroll=()=>{if(mode.mode && parent && parent.scrollTop>0 && parent.scrollHeight-parent.scrollTop-parent.clientHeight<Math.max(32,parent.clientHeight*.3))grow();};
  if(!mode.mode){paper.current=0;element.style.minHeight=`${Math.max(size.panel,ink.document.height)}px`;setPaperHeight(0);}
  parent?.addEventListener('wheel',wheel,{passive:true});parent?.addEventListener('scroll',scroll,{passive:true});
  const observer=new ResizeObserver(measure);observer.observe(element);if(parent)observer.observe(parent);measure();return()=>{observer.disconnect();parent?.removeEventListener('wheel',wheel);parent?.removeEventListener('scroll',scroll);};
 },[content,mode.mode,ink.document.height,size.panel]);
 useEffect(()=>{const flush=(event:Event)=>registerEditor(event,ink.flush());document.addEventListener('kkb:prepare-close',flush);return()=>document.removeEventListener('kkb:prepare-close',flush);},[]);
 return <div ref={host} className="drawing-body doodle-body" onContextMenu={event=>{if(mode.mode || document.documentElement.dataset.doodleExiting){event.preventDefault();event.stopPropagation();}}} style={{minHeight:Math.max(size.panel,paperHeight,ink.document.height)} as CSSProperties}>
  <div className="doodle-toolbar"><InkPill mode={mode.mode} toggle={mode.toggle}/></div>
  {mode.mode && <div className="doodle-range" aria-hidden="true" style={{'--doodle-panel-height':`${size.panel}px`} as CSSProperties}/>}
  <Markdown text={content} {...(placeholder===undefined?{}:{placeholder})}/>
  <svg className="doodle-layer" data-drawing-surface="true" data-active={mode.mode!==null} viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" onContextMenu={event=>{if(mode.mode){event.preventDefault();event.stopPropagation();}}} {...ink.handlers(event=>{
   const svg=event.currentTarget as SVGSVGElement,matrix=svg.getScreenCTM();const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix?.inverse());return {x:p.x,y:p.y};
  },undefined,2)}>
   {ink.document.strokes.map(stroke=><polyline key={stroke.id} points={stroke.points.map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke={`var(--palette-${stroke.color})`} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round"/>)}
  </svg>
  {(ink.error || mode.error) && <span className="doodle-error" role="alert">{ink.error || mode.error}</span>}
 </div>;
}
