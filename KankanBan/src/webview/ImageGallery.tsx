import {createContext,useContext,useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {invoke} from '@tauri-apps/api/core';
import type {CardImage} from '../core/types.ts';
import {uiText} from '../i18n/text.ts';
import {isTauri} from './tauri-backend.ts';
import {ImageHoverHint,type ImageHoverPoint} from './ImageHoverHint.tsx';

export const ImageWorkspace=createContext('');
type Asset={users:number;size:number;url?:string;pending:Promise<string>;last:number};
const assets=new Map<string,Asset>();
function trimAssets(){
 let size=[...assets.values()].reduce((n,a)=>n+a.size,0);
 for(const [key,asset] of [...assets.entries()].sort((a,b)=>a[1].last-b[1].last)){
  if(size<=64*1024*1024)break;
  if(asset.users || !asset.url)continue;
  URL.revokeObjectURL(asset.url);assets.delete(key);size-=asset.size;
 }
}
function retainAsset(workspace:string,id:string,compact:boolean):Asset {
 const key=`${workspace}:${id}:${compact?'preview':'original'}`;let asset=assets.get(key);
 if(!asset){
  asset={users:0,size:0,last:Date.now(),pending:Promise.resolve('')};
  const current=asset;
  current.pending=invoke<string>(compact?'read_image_preview':'read_image_asset',{assetId:id,...(compact?{maxSide:512}:{})}).then(async data=>{
   const blob=await (await fetch(data)).blob();current.size=blob.size;current.url=URL.createObjectURL(blob);trimAssets();return current.url;
  }).catch(error=>{assets.delete(key);throw error;});
  assets.set(key,current);
 }
 asset.users++;asset.last=Date.now();return asset;
}
function ImageAsset({image,compact,onIntrinsic}:{image:CardImage;compact:boolean;onIntrinsic?:((size:{width:number;height:number})=>void)|undefined}) {
 const workspace=useContext(ImageWorkspace),host=useRef<HTMLSpanElement>(null),[visible,setVisible]=useState(typeof IntersectionObserver==='undefined'),[url,setUrl]=useState(''),[failed,setFailed]=useState('');
 useEffect(()=>{const element=host.current;if(!element || typeof IntersectionObserver==='undefined'){setVisible(true);return;}const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.target===element)setVisible(entry.isIntersecting);},{rootMargin:'300px'});observer.observe(element);return()=>observer.disconnect();},[workspace,image.assetId,compact]);
 useEffect(()=>{
  setUrl('');setFailed('');if(!isTauri() || !visible)return;
  let alive=true;const asset=retainAsset(workspace,image.assetId,compact);
  void asset.pending.then(value=>{if(alive)setUrl(value);}).catch(error=>{if(alive)setFailed(String(error));});
  return()=>{alive=false;asset.users--;asset.last=Date.now();trimAssets();};
 },[workspace,image.assetId,compact,visible]);
 return <span ref={host} className="image-asset" role="img" aria-label={image.name}>{url?<img src={url} alt={image.name} draggable={false} loading="lazy" onLoad={event=>{if(!compact)onIntrinsic?.({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight});}}/>:<span className="image-status" role={failed?'alert':undefined} title={failed || undefined}>{uiText(!isTauri()?'images.desktopOnly':failed?'images.failed':'images.loading')}</span>}</span>;
}
export function ImageGallery({images,names,compact=false,removeControl,onIntrinsic}:{images:CardImage[];names?:readonly string[];compact?:boolean;removeControl?:ReactNode;onIntrinsic?:((size:{width:number;height:number})=>void)|undefined}) {
 const [hovered,setHovered]=useState<ImageHoverPoint|null>(null);
 useEffect(()=>setHovered(null),[images,compact]);
 const hover=(index:number,event:{target:EventTarget;clientX:number;clientY:number})=>{
  if(!compact)return;if(event.target instanceof Element && event.target.closest('button')){setHovered(null);return;}
  setHovered(current=>current?.index===index?current:{index,x:event.clientX,y:event.clientY,...(names?.[index]?{name:names[index]}:{})});
 };
 return <div className={`image-gallery ${compact?'image-thumbnails':'body-images'}`} title="" data-count={images.length} style={compact?{'--image-columns':Math.ceil(Math.sqrt(images.length))} as CSSProperties:undefined}>
  {images.map((image,index)=><figure key={`${image.id}:${index}`} className="card-image" title={compact?'':undefined} onPointerEnter={event=>hover(index,event)} onPointerMove={event=>hover(index,event)} onPointerLeave={()=>setHovered(null)}>
   <ImageAsset key={image.assetId} image={image} compact={compact} onIntrinsic={onIntrinsic}/>
  </figure>)}
  {removeControl}
  <ImageHoverHint point={compact?hovered:null}/>
 </div>;
}
