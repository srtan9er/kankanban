import {uiText} from '../i18n/text.ts';
import {waitForMirrorSnapshot} from './mirror-startup.ts';
import type {Request,Snapshot} from './controller.ts';

export const DESKTOP_CHANNEL='kkb:v1';
export type DesktopResult={createdId?:string;createdWindowId?:string;toolResult?:unknown};
export type DesktopReply={token:string;to:string;snapshot?:Snapshot;result?:DesktopResult;error?:string};
export type DesktopRequest={token:string;from:string;request:Request|null};
export type DesktopBus={
 emit:(channel:string,payload:unknown)=>Promise<void>;
 listen:<T>(channel:string,handler:(event:{payload:T})=>void)=>Promise<()=>void>;
};
export function requestTimeout(request:Request|null):number|null{
 return request?.kind==='share-export' || request?.kind==='share-import'?null:request?.kind==='images-import' || request?.kind==='images-update'?120000:12000;
}
/** Mirror windows never write: requests go to main; ordered snapshots come back. */
export function createDesktopMirror(label:string,accept:(snapshot:Snapshot)=>void,bus:DesktopBus){
 const pending=new Map<string,{resolve:(result:DesktopResult)=>void;reject:(error:Error)=>void;timeout:ReturnType<typeof setTimeout>|null}>();
 const stops:(()=>void)[]=[];let revision=-1;
 let snapshotArrived!:()=>void;const firstSnapshot=new Promise<void>(resolve=>{snapshotArrived=resolve;});
 const receive=(snapshot:Snapshot)=>{if(snapshot.revision>=revision){revision=snapshot.revision;accept(snapshot);snapshotArrived();}};
 const request=(action:Request|null):Promise<DesktopResult>=>{
  const token=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
   const duration=requestTimeout(action),timeout=duration===null?null:setTimeout(()=>{pending.delete(token);reject(new Error(uiText('webview/desktop.text001')));},duration);
   pending.set(token,{resolve,reject,timeout});
   void bus.emit(`${DESKTOP_CHANNEL}:request`,{token,from:label,request:action} satisfies DesktopRequest).catch(error=>{if(timeout!==null)clearTimeout(timeout);pending.delete(token);reject(error);});
  });
 };
 return {
  request,
  async start():Promise<void>{
   stops.push(await bus.listen<Snapshot>(`${DESKTOP_CHANNEL}:snapshot`,event=>receive(event.payload)));
   stops.push(await bus.listen<DesktopReply>(`${DESKTOP_CHANNEL}:reply`,event=>{
    const reply=event.payload;if(reply.to!==label)return;const waiting=pending.get(reply.token);if(!waiting)return;
    pending.delete(reply.token);if(waiting.timeout!==null)clearTimeout(waiting.timeout);
    if(reply.snapshot)receive(reply.snapshot);
    if(reply.error)waiting.reject(new Error(reply.error));else waiting.resolve(reply.result ?? {});
   }));
   await waitForMirrorSnapshot(()=>request(null),firstSnapshot);
  },
  dispose(){stops.splice(0).forEach(stop=>stop());for(const waiting of pending.values()){if(waiting.timeout!==null)clearTimeout(waiting.timeout);waiting.reject(new Error(uiText('native/mcpBridge.stopped')));}pending.clear();},
 };
}
export type DesktopDiagnostics={incoming:number;replied:number;failed:number;requests:{from:string;kind:string;stage:string;error?:string}[]};
/** Main is the sole authority; every reply carries its latest committed snapshot. */
export function serveDesktopRequests(bus:DesktopBus,request:(action:Request|null)=>Promise<DesktopResult>,snapshot:()=>Snapshot,diagnostics:DesktopDiagnostics){
 return bus.listen<DesktopRequest>(`${DESKTOP_CHANNEL}:request`,event=>{
  const message=event.payload,trace:{from:string;kind:string;stage:string;error?:string}={from:message.from,kind:message.request?.kind ?? 'snapshot',stage:'received'};
  diagnostics.incoming++;diagnostics.requests.push(trace);if(diagnostics.requests.length>8)diagnostics.requests.shift();
  void request(message.request).then(async result=>{trace.stage='replying';await bus.emit(`${DESKTOP_CHANNEL}:reply`,{token:message.token,to:message.from,result,...(message.request?.kind==='extension-job'?{}:{snapshot:snapshot()})} satisfies DesktopReply);trace.stage='replied';diagnostics.replied++;})
   .catch(async error=>{diagnostics.failed++;trace.stage='failed';trace.error=String(error);await bus.emit(`${DESKTOP_CHANNEL}:reply`,{token:message.token,to:message.from,error:String(error)} satisfies DesktopReply);});
 });
}
