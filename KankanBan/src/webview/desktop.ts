import {connectDesktopDrag} from './desktop-drag.ts';
import {cardIdFromLabel,windowIdFromLabel,windowAnchor,windowLabel} from '../core/window-identity.ts';
import {connectWindowPositions} from './window-position-sync.ts';
import {inspectLocalWindow} from './inspect-window.ts';
import {shareAssetIds,buildSharePackage,parseSharePackage,MAX_SHARE_ASSETS,MAX_SHARE_BASE64} from '../core/share-package.ts';
import type {CardImage} from '../core/card-images.ts';
import {createDesktopMirror,serveDesktopRequests,DESKTOP_CHANNEL as CHANNEL} from './desktop-mirror.ts';
import {validateToolCall} from '../mcp/tools.ts';
import {getAllWindows} from '@tauri-apps/api/window';
import {freshWindow,closeWindow} from '../core/view-state.ts';
import {navigationTarget} from './navigation.ts';
import {readCard} from '../core/workspace.ts';
import {uiText} from '../i18n/text.ts';
import {dispatchCanvasDrag,CANVAS_WINDOW_SHIFT} from './canvas-events.ts';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WorkspaceController,READ_ONLY_MCP_TOOLS, type Request } from './controller.ts';
import {cardWindowService,wantedDesktopViews} from './card-window-service.ts';
import { prepareEditors } from './drafts.ts';


/** Composition root for desktop windows.
 * Identity: core/window-identity; lifecycle commands: card-window-service.
 * Mirror transport: desktop-mirror; native drags: desktop-drag.
 * Position notifications: window-position-sync; main remains the sole writer.
 * Native command names, event channels and stored view IDs are compatibility boundaries.
 */
export async function connectDesktop(c: WorkspaceController, label: string) {
  const main = label === 'main';
  const windows=cardWindowService();
  const bus={emit,listen};
  const mirror=main?null:createDesktopMirror(label,snapshot=>c.accept(snapshot),bus);
  const w = getCurrentWindow();
  const diagnostics={incoming:0,replied:0,failed:0,requests:[] as {from:string;kind:string;stage:string;error?:string}[]};c.desktopDiagnostics=diagnostics;
  let closing = false;
  let switching=false;
  let errorHandler = (message: string): void => { c.error = message; c.accept(c.snapshot()); };
  const request = async (action: Request | null,beforeExecute?:()=>Promise<void>): Promise<{ createdId?: string;createdWindowId?:string;toolResult?:unknown }> => {
    if (main) {
      if((closing || switching) && action?.kind==='extension-invoke')throw new Error(uiText('extensions.busy'));
      if(action?.kind==='extension-job')return c.execute(action);
      if (action && ((action.kind === 'mcp' && !READ_ONLY_MCP_TOOLS.has(action.tool)) || ['images-import','images-update','share-export','share-import'].includes(action.kind) || action.kind === 'tutorial' || action.kind === 'close-all' || action.kind === 'float' || action.kind === 'move' || action.kind === 'canvas-drop' || action.kind === 'delete' || action.kind === 'prefab-sync' || action.kind === 'undo' || action.kind === 'window')) await prepareWindows();
      if (action === null) await c.flush();
      if(action?.kind==='mcp' && (switching || closing))throw new Error(uiText('native/mcpBridge.stopped'));
      const result = action === null ? {} : await c.execute(action,action.kind==='mcp'?async()=>{if(switching || closing)throw new Error(uiText('native/mcpBridge.stopped'));await beforeExecute?.();}:undefined,desktopTool);
      await emit(`${CHANNEL}:snapshot`, c.snapshot());
      const errors = await windows.sync(wantedDesktopViews(c.session.state,c.view));
      if (errors.length) errorHandler(errors.join('；'));
      if(action?.kind==='tutorial' && result.createdWindowId)await windows.open(result.createdWindowId);
      if(action?.kind==='float' && result.createdWindowId)await windows.open(result.createdWindowId);
      if(action?.kind==='window' && action.open)await windows.open(action.id);
      return result;
    }
    return mirror!.request(action);
  };
  const unlisteners: (() => void)[] = [];
  if(cardIdFromLabel(label)!==null){
    let disposed=false;
    const raiseChain=():void=>{void invoke('raise_window_chain').catch(error=>{if(!disposed)errorHandler(String(error));});};
    document.addEventListener('pointerdown',raiseChain,true);
    unlisteners.push(()=>{disposed=true;document.removeEventListener('pointerdown',raiseChain,true);});
  }
  unlisteners.push(await listen<{error:string}>('kkb:window-chain-error',event=>errorHandler(event.payload.error)));
  unlisteners.push(await listen('kkb:theme-reload',()=>window.dispatchEvent(new Event('kkb:theme-reload'))));
  if(mirror)unlisteners.push(()=>mirror.dispose());
  const onWindowOperation=(event:Event)=>{void request({kind:'window-state',windowLabel:label,changes:(event as CustomEvent<Record<string,unknown>>).detail}).catch(error=>errorHandler(String(error)));};
  document.addEventListener('kkb:window-operation',onWindowOperation);
  unlisteners.push(()=>document.removeEventListener('kkb:window-operation',onWindowOperation));
  const dragState={fixed:false};
  const positionSync=await connectWindowPositions({label,window:w,bus,positions:c.windowPositions,fixed:()=>dragState.fixed,
    shift:delta=>document.dispatchEvent(new CustomEvent(CANVAS_WINDOW_SHIFT,{detail:delta})),
    notify:position=>document.dispatchEvent(new CustomEvent('kkb:card-window-position',{detail:position})),error:reason=>errorHandler(reason)});
  unlisteners.push(()=>positionSync.dispose());
  const clearCanvasDrag = (phase: 'cancel'|'leave'): void => {
    for(const canvas of document.querySelectorAll<HTMLElement>('.canvas-viewport')) dispatchCanvasDrag(canvas,{id:'',x:0,y:0,phase});
  };
  unlisteners.push(await listen(`${CHANNEL}:canvas-end`,()=>clearCanvasDrag('cancel')));

  if(main)unlisteners.push(await serveDesktopRequests(bus,request,()=>c.snapshot(),diagnostics));
  else {
    await mirror!.start();
    if(c.view.tutorialCardId===cardIdFromLabel(label)){
      const preferences=await invoke<unknown>('window_preferences');
      if(!preferences)await invoke('resize_note',{width:760,height:660,finish:true});
    }
  }

  const flushEditor = async (): Promise<void> => {
    await prepareEditors();
    if (main) await c.flush();
  };
  const acknowledgements = new Map<string, Set<string>>();
  unlisteners.push(await listen<{ token: string }>(`${CHANNEL}:prepare`, e => {
    if (main) return;
    void flushEditor().then(() => emit(`${CHANNEL}:prepared`, { token: e.payload.token, label }))
      .catch(error => errorHandler(String(error)));
  }));
  if (main) unlisteners.push(await listen<{ token: string; label: string }>(`${CHANNEL}:prepared`, e => acknowledgements.get(e.payload.token)?.delete(e.payload.label)));

  const prepareWindows = async (): Promise<void> => {
    await flushEditor();
    const token = crypto.randomUUID();
    const waiting = new Set(await windows.labels());
    acknowledgements.set(token, waiting);
    try {
      await emit(`${CHANNEL}:prepare`, { token });
      const deadline = Date.now() + 8000;
      while (waiting.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
      if (waiting.size) throw new Error(uiText("webview/desktop.text002"));
    } finally { acknowledgements.delete(token); }
  };

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      if(main){await c.refreshExtensionJobs();if(c.hasExtensionJobs)throw new Error(uiText('extensions.busy'));}
      await flushEditor();
      if (main) {
        await prepareWindows();
        await c.execute({kind:'window-state',windowLabel:label,changes:{operation:'exit'}});await c.flush();
        await invoke('finish_exit');
      } else {
        await request({ kind: 'window', id: windowIdFromLabel(label)!, open: false });
      }
    } catch (error) { closing = false; errorHandler(String(error)); }
  };
  unlisteners.push(await w.onCloseRequested(event => { event.preventDefault(); void close(); }));

  const drag=await connectDesktopDrag({controller:c,label,window:w,windows,request,positionSync,dragState,clearCanvasDrag,errorHandler:reason=>errorHandler(reason)});
  const {startDrag}=drag;unlisteners.push(()=>drag.dispose());

  const inspections=new Map<string,{label:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  unlisteners.push(await listen<{token:string}>('kkb:inspect',event=>{void emit('kkb:inspected',{token:event.payload.token,label,data:inspectLocalWindow(c,label)});}));
  if(main)unlisteners.push(await listen<{token:string;label:string;data:unknown}>('kkb:inspected',event=>{const waiting=inspections.get(event.payload.token);if(waiting?.label===event.payload.label){clearTimeout(waiting.timer);inspections.delete(event.payload.token);waiting.resolve(event.payload.data);}}));
  unlisteners.push(()=>{for(const pending of inspections.values()){clearTimeout(pending.timer);pending.reject(new Error(uiText('native/mcpBridge.stopped')));}inspections.clear();});
  const ownedWindow=async(target:string)=>{const windows=await getAllWindows();const found=windows.find(window=>window.label===target && (target==='main' || target.startsWith('card-')));if(!found)throw new Error(uiText('mcp/extended.invalidWindow'));return found;};
  const desktopTool=async(tool:string,args:Record<string,unknown>):Promise<unknown>=>{
    if(tool==='images-import')return invoke('import_image_assets',{inputs:args.inputs});
    if(tool==='verify-images'){
      const images=args.images as CardImage[];
      const checked=await invoke<{assetId:string;mime:string;width:number;height:number}[]>('verify_image_assets',{assetIds:[...new Set(images.map(image=>image.assetId))]});
      const assets=new Map(checked.map(asset=>[asset.assetId,asset]));
      if(images.some(image=>{const actual=assets.get(image.assetId);return !actual || actual.mime!==image.mime || actual.width!==image.width || actual.height!==image.height;}))throw new Error(uiText('images.invalid'));
      return null;
    }
    if(tool==='share-export'){
      const id=args.id as string,assets=new Map<string,string>(),descriptors=new Map<string,{assetId:string;mime:CardImage['mime'];width:number;height:number;name:string}>(),ids=shareAssetIds(c.session.state,id);
      if(ids.length>MAX_SHARE_ASSETS)throw new Error(uiText('share.tooLarge'));
      for(let start=0;start<ids.length;start+=64){const batch=await invoke<{assetId:string;mime:CardImage['mime'];width:number;height:number;name:string}[]>('verify_image_assets',{assetIds:ids.slice(start,start+64)});for(const asset of batch)descriptors.set(asset.assetId,asset);}
      let encodedSize=0;
      for(const assetId of ids){const base64=(await invoke<string>('read_image_asset',{assetId})).split(',')[1]!;encodedSize+=base64.length;if(encodedSize>MAX_SHARE_BASE64)throw new Error(uiText('share.tooLarge'));assets.set(assetId,base64);}
      const pkg=buildSharePackage(c.session.state,id,assets,descriptors);
      if(pkg.cards.some(card=>card.images.some(image=>{const actual=descriptors.get(image.assetId);return !actual || actual.mime!==image.mime || actual.width!==image.width || actual.height!==image.height;})))throw new Error(uiText('share.assetMismatch'));
      return invoke('save_share_package',{data:JSON.stringify(pkg),name:`${readCard(c.session,id).title.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,100) || id}.kkbpack`});
    }
    if(tool==='share-import'){
      const data=await invoke<string|null>('pick_share_package');if(data===null)return null;
      let value:unknown;try{value=JSON.parse(data);}catch{throw new Error(uiText('share.invalid'));}
      const pkg=parseSharePackage(value);
      for(let start=0;start<pkg.assets.length;start+=64){
        const batch=pkg.assets.slice(start,start+64),stored=await invoke<{assetId:string;mime:string;width:number;height:number}[]>('import_image_assets',{inputs:batch.map(asset=>({name:asset.assetId,base64:asset.base64}))});
        if(stored.length!==batch.length || stored.some((asset,index)=>asset.assetId!==batch[index]!.assetId))throw new Error(uiText('share.assetMismatch'));
        for(const card of pkg.cards)for(const image of card.images){const actual=stored.find(asset=>asset.assetId===image.assetId);if(actual && (actual.mime!==image.mime || actual.width!==image.width || actual.height!==image.height))throw new Error(uiText('share.assetMismatch'));}
      }
      return pkg;
    }
    if(tool==='get_workspace')return {path:c.session.root};
    if(tool==='list_windows')return Promise.all((await getAllWindows()).filter(window=>window.label==='main' || window.label.startsWith('card-')).map(async window=>({label:window.label,position:await window.outerPosition(),size:await window.innerSize(),scaleFactor:await window.scaleFactor(),cardId:window.label==='main'?null:cardIdFromLabel(window.label),focusId:c.view.windows[windowIdFromLabel(window.label)!]?.focusId ?? null})));
    if(tool==='open_card_window' || tool==='close_card_window'){
      const requestedId=args.cardId as string;readCard(c.session,requestedId);
      const id=tool==='open_card_window'?navigationTarget(c.session.state,requestedId,requestedId):requestedId;
      if(id==='000')throw new Error(uiText('mcp/extended.invalidWindow'));
      if(tool==='open_card_window'){const opened=freshWindow(c.view,id);c.view=opened.view;await windows.open(opened.windowId);return {cardId:id,windowLabel:windowLabel(opened.windowId),open:true};}
      const target=c.view.openWindows.includes(id)?id:c.view.openWindows.find(key=>windowAnchor(key)===id) ?? id;
      c.view=closeWindow(c.view,target);await windows.close(target);
      return {cardId:id,windowLabel:windowLabel(target),open:false};
    }
    const target=args.windowLabel as string ?? 'main';await ownedWindow(target);
    if(tool==='capture_window')return invoke('capture_app_window',{label:target});
    if(tool==='inspect_window'){
      if(target===label)return inspectLocalWindow(c,label);
      const token=crypto.randomUUID();return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{inspections.delete(token);reject(new Error(uiText('mcp/extended.inspectTimeout')));},3000);inspections.set(token,{label:target,resolve,reject,timer});
        void invoke('emit_window_inspection',{label:target,token}).catch(error=>{clearTimeout(timer);inspections.delete(token);reject(error);});
      });
    }
    throw new Error(uiText('mcp/extended.desktopOnly'));
  };
  let bridgeQueue=Promise.resolve();
  if(main){
    await c.attachExtensions((channel,args)=>invoke(channel==='control'?'extension_control':channel==='start'?'extension_start':'extension_job',args));
    unlisteners.push(await listen<{workspace:string;jobId:number;reply:Record<string,unknown>}>('kkb:extension-result',event=>{
      if(event.payload.workspace.replaceAll('\\','/')!==c.session.root.replaceAll('\\','/'))return;
      void c.completeExtension(event.payload.jobId,event.payload.reply).catch(error=>errorHandler(String(error)));
    }));
    unlisteners.push(await listen<{id:string;tool:string;args:Record<string,unknown>}>('kkb:mcp-request',event=>{
      bridgeQueue=bridgeQueue.then(async()=>{
        const claimed=await invoke<{tool:string;args:Record<string,unknown>;context?:import('../core/collaboration.ts').McpContext}|null>('mcp_bridge_claim',{id:event.payload.id});
        if(!claimed)return;
        if(claimed.tool==='switch_workspace'){
          try{
            validateToolCall(claimed.tool,claimed.args);
            const path=claimed.args.path as string|null;
            await invoke('select_workspace',{path,checkOnly:true});
            await switchWorkspace(path,async()=>{await invoke('mcp_bridge_reply',{id:event.payload.id,reply:{result:{status:'scheduled',requestedPath:path}}});},async()=>{if(!await invoke<boolean>('mcp_bridge_active',{id:event.payload.id}))throw new Error(uiText('native/mcpBridge.stopped'));},claimed.context ?? {});
          }catch(error){await invoke('mcp_bridge_reply',{id:event.payload.id,reply:{error:String(error)}});errorHandler(String(error));}
          return;
        }
        let reply:unknown;
        try{const result=await request({kind:'mcp',tool:claimed.tool,args:claimed.args,context:claimed.context},async()=>{if(!await invoke<boolean>('mcp_bridge_active',{id:event.payload.id}))throw new Error(uiText('native/mcpBridge.stopped'));});reply={result:result.toolResult ?? null};}
        catch(error){reply={error:String(error)};}
        await invoke('mcp_bridge_reply',{id:event.payload.id,reply});
      }).catch(error=>errorHandler(String(error)));
    }));
    await invoke('mcp_bridge_start');
  }
  const switchWorkspace = async (path: string | null,beforeReload?:()=>Promise<void>,beforeSelection?:()=>Promise<void>,mcpContext?:import('../core/collaboration.ts').McpContext): Promise<void> => {
    if (!main) throw new Error(uiText("webview/desktop.text003"));
    switching=true;
    try{
      await c.refreshExtensionJobs();if(c.hasExtensionJobs)throw new Error(uiText('extensions.busy'));
      await prepareWindows(); await c.flush();
      await beforeSelection?.();
      await c.execute(mcpContext?{kind:'mcp',tool:'switch_workspace',args:{path},context:mcpContext}:{kind:'workspace',path},undefined,async()=>{await invoke('select_workspace',{path});return {status:'scheduled',requestedPath:path};});
      await beforeReload?.();
      await invoke('reload_workspace');
    }catch(error){switching=false;await request(null);await invoke('mcp_bridge_start');throw error;}
    unlisteners.forEach(dispose=>dispose());
    window.location.reload();
  };
  return { switchWorkspace, request: (action: Request) => request(action), startDrag, close: () => { void close(); },
    restore: () => request(null), dispose: () => unlisteners.forEach(fn => fn()) };
}
