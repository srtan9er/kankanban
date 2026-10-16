import {cardIdFromLabel} from '../core/window-identity.ts';
import {DESKTOP_CHANNEL,type DesktopBus} from './desktop-mirror.ts';
import {WindowPositions,type WindowPositionUpdate} from './window-events.ts';
type Point={x:number;y:number};
export type PositionWindow={
 outerPosition:()=>Promise<Point>;scaleFactor:()=>Promise<number>;
 onScaleChanged:(handler:(event:{payload:{scaleFactor:number}})=>void)=>Promise<()=>void>;
 onMoved:(handler:(event:{payload:Point})=>void)=>Promise<()=>void>;
};
type Frames={request:(callback:FrameRequestCallback)=>number;cancel:(id:number)=>void};
/** Physical screen-position broadcasts and local logical-pixel canvas compensation. */
export async function connectWindowPositions({label,window,bus,positions,fixed,shift,notify,error,frames={request:callback=>requestAnimationFrame(callback),cancel:id=>cancelAnimationFrame(id)}}:{
 label:string;window:PositionWindow;bus:DesktopBus;positions:WindowPositions;fixed:()=>boolean;
 shift:(delta:Point)=>void;notify:(position:WindowPositionUpdate)=>void;error:(reason:string)=>void;frames?:Frames;
}){
 let origin=await window.outerPosition(),sequence=0,originRevision=0,frame:number|null=null;
 let chainFixed=false,chainRevision=0,settleFrame:number|null=null,disposed=false;
 const stops:(()=>void)[]=[];
 stops.push(await bus.listen<WindowPositionUpdate>(`${DESKTOP_CHANNEL}:window-position`,event=>positions.accept(event.payload)));
 stops.push(positions.subscribe(notify));
 stops.push(await bus.listen<{active:boolean;fixed:boolean}>('kkb:window-chain-motion',event=>{
  const revision=++chainRevision;
  if(settleFrame!==null){frames.cancel(settleFrame);settleFrame=null;}
  if(event.payload.active){chainFixed=event.payload.fixed;return;}
  if(!chainFixed)return;
  // Native move notifications can trail the chain's ending. Keep the guard
  // across their event-loop/frame boundary while accepting the final origin.
  const originAtRequest=originRevision;
  void window.outerPosition().then(position=>{
   if(disposed||revision!==chainRevision)return;if(originAtRequest===originRevision)origin=position;
   settleFrame=frames.request(()=>{settleFrame=frames.request(()=>{settleFrame=null;if(!disposed&&revision===chainRevision)chainFixed=false;});});
  }).catch(reason=>{if(!disposed&&revision===chainRevision){chainFixed=false;error(String(reason));}});
 }));
 let scale=await window.scaleFactor();
 stops.push(await window.onScaleChanged(event=>{scale=event.payload.scaleFactor;}));
 stops.push(await window.onMoved(event=>{
  const position=event.payload,delta={x:(position.x-origin.x)/scale,y:(position.y-origin.y)/scale};origin=position;originRevision++;
  if(frame===null)frame=frames.request(()=>{frame=null;void bus.emit(`${DESKTOP_CHANNEL}:window-position`,{windowId:label,cardId:label==='main'?'000':cardIdFromLabel(label)!,x:origin.x,y:origin.y,sequence:++sequence} satisfies WindowPositionUpdate).catch(reason=>error(String(reason)));});
  if(!fixed()&&!chainFixed)shift(delta);
 }));
 return {
  resetOrigin:(position:Point)=>{origin=position;originRevision++;},
  dispose:()=>{disposed=true;chainRevision++;stops.splice(0).forEach(stop=>stop());if(frame!==null)frames.cancel(frame);if(settleFrame!==null)frames.cancel(settleFrame);},
 };
}
