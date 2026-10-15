import {callTool,validateToolCall} from '../mcp/tools.ts';
import {readCard} from '../core/workspace.ts';
import {validCardImages,type CardImage} from '../core/card-images.ts';
import {imageRequestSummary,type ImageImportInput} from './image-input.ts';
import {importSharePackage,type SharePackage} from '../core/share-package.ts';
import {OperationJournal,compactChange,eventKey,validateActor,type McpContext,type Actor} from '../core/collaboration.ts';
import {ensureTutorial} from '../core/tutorial.ts';
import {isSkin,type SkinId} from '../core/skins.ts';
import {isInSubtree} from '../core/indexes.ts';
import {uiText} from '../i18n/text.ts';
import {validCanvasBindings,type CanvasDragBindings} from '../core/canvas-drag.ts';
import {CHILD_MIN_WIDTH, CHILD_MIN_HEIGHT} from '../core/layout-metrics.ts';
import {rendererOf} from '../core/renderer.ts';
import type { Session } from '../core/workspace.ts';
import { executeAction, type Action } from '../core/actions.ts';
import { MAX_CARD_RADIUS, openWindow, closeWindow, writeViewState, windowViewFor, type ViewState } from '../core/view-state.ts';
import {windowAnchor} from '../core/window-identity.ts';
import {freshWindow} from '../core/view-state.ts';
import {WindowPositions} from './window-events.ts';
import {navigationTarget} from './navigation.ts';
import {ExtensionHost,AVAILABLE_EXTENSIONS,extensionId,extensionAvailable} from '../extensions/registry.ts';
import {DesktopExtensionService,type ExtensionTransport} from '../extensions/desktop-service.ts';
import { windowCards } from '../core/windows.ts';
import type { BufferedFs } from '../platform/buffered-fs-ops.ts';
import type { AsyncFsOps } from '../platform/async-fs-ops.ts';

export type Request = {kind:"extension-control";id:string;method:"install"|"enable"|"disable"|"uninstall"|"configure";config?:Record<string,unknown>} | {kind:"extension-invoke";id:string;method:string;args:Record<string,unknown>} | {kind:"extension-job";jobId:number} | {kind:"extension-result";id:string;method:string;jobId:number;actor:Actor;result:unknown} | Action | {kind:'images-import';id:string;inputs:ImageImportInput[];offset?:number;beforeContent?:string} | {kind:'share-export';id:string} | {kind:'share-import';parent:string|null} | {kind:'window-state';windowLabel:string;changes:Record<string,unknown>} | {kind:'workspace';path:string|null} | {kind:'mcp';tool:string;args:Record<string,unknown>;context?:McpContext|undefined} | {kind:'signature';name:string} | {kind:'tutorial'} | {kind:'skin';skin:SkinId} | {kind:'interaction';canvasDragBindings:CanvasDragBindings} | { kind: 'appearance'; cardRadius: number } | { kind: 'window'; id: string; open: boolean } | { kind: 'close-all' } | { kind: 'float'; id: string }
  | { kind: 'view'; id: string; focus?: string; contentHeight?: number; childArea?: { width: number; height: number } };
export type Snapshot = { cards: [string, Session['state']['cards'] extends Map<string, infer V> ? V : never][];
  children: [string, Session['state']['children'] extends Map<string, infer V> ? V : never][];
  seq: number; view: ViewState; undoCount: number; revision: number };
export const READ_ONLY_MCP_TOOLS=new Set(['read_operations','ack_operations','read_tree','read_card','list_children','search','get_doodle','get_card_location','get_workspace','list_windows','inspect_window','capture_window']);

export class WorkspaceController {
  readonly extensions=new ExtensionHost();
  private extensionServices=new Map<string,DesktopExtensionService>();
  private extensionTransport:ExtensionTransport|undefined;
  private extensionStarting=false;
  private earlyExtensionResults=new Map<number,Record<string,unknown>>();
  private extensionJobs=new Map<number,{actor:Actor;method:string;id:string;repository:string;arguments:unknown}>();
  get hasExtensionJobs():boolean{return this.extensionJobs.size>0;}
  async queryExtensionJob(jobId:number):Promise<unknown>{
    if(!Number.isSafeInteger(jobId) || jobId<1)throw new Error(uiText('extensions.invalid'));
    if(!this.extensionTransport)throw new Error(uiText('extensions.noDesktop'));
    const reply=await this.extensionTransport('job',{jobId});if(reply.state==='done' || reply.state==='failed')void this.completeExtension(jobId,reply);return reply;
  }
  async attachExtensions(transport:ExtensionTransport):Promise<void>{
    this.extensionTransport=transport;
    for(const manifest of AVAILABLE_EXTENSIONS){
      const preference=this.view.extensions?.[manifest.id];if(preference?.installed===false)continue;
      const service=new DesktopExtensionService(manifest.id,transport);this.extensionServices.set(manifest.id,service);this.extensions.register(manifest,service);
      try{await this.extensions.initialize(manifest.id,preference?.config ?? {root:this.session.root});if(preference?.enabled!==false)await this.extensions.enable(manifest.id);}catch(error){this.error=String(error);}
    }
  }
  async completeExtension(jobId:number,reply:Record<string,unknown>):Promise<void>{
    const job=this.extensionJobs.get(jobId);if(!job){if(this.extensionStarting && this.earlyExtensionResults.size<64)this.earlyExtensionResults.set(jobId,reply);return;}this.extensionJobs.delete(jobId);this.extensionServices.get(job.id)?.complete(reply);this.extensions.publish({id:job.id,kind:'result',requestId:String(jobId),value:reply});this.changed();
    if(!['status','graph','diff','compare','commitDetail','openFile'].includes(job.method))await this.execute({kind:'extension-result',id:job.id,method:job.method,jobId,actor:job.actor,result:{repository:job.repository,arguments:job.arguments,state:reply.state,error:reply.error}});
  }
  readonly windowPositions=new WindowPositions();
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private listeners = new Set<() => void>();
  status = uiText("webview/controller.text001");
  error = '';
  busy = false;
  undoCount = 0;
  session: Session;
  desktopDiagnostics?:{incoming:number;replied:number;failed:number;requests:{from:string;kind:string;stage:string;error?:string}[]};
  view: ViewState;
  private buffer: BufferedFs;
  private backend: AsyncFsOps;
  journal:OperationJournal;
  constructor(session: Session, view: ViewState, buffer: BufferedFs, backend: AsyncFsOps) {
    this.session = session; this.view = view; this.buffer = buffer; this.backend = backend;
    this.normalizeWindowFocus();
    this.undoCount = session.events.length;
    this.journal=new OperationJournal(session.root,buffer.ops,session.clock,session.newId);
    this.journal.importEvents(session.events);
  }
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private normalizeWindowFocus():void {
    const windows={...this.view.windows};
    for(const [windowId,view] of Object.entries(windows)){
      const anchor=windowAnchor(windowId),allowedAnchor=navigationTarget(this.session.state,anchor,anchor);
      if(extensionId(anchor))continue;
      let focus=navigationTarget(this.session.state,view.focusId,view.focusId);
      if(!this.session.state.cards.get(focus) || this.session.state.cards.get(focus)!.deleted || !isInSubtree(this.session.state,allowedAnchor,focus))focus=allowedAnchor;
      if(focus!==view.focusId)windows[windowId]={...view,focusId:focus};
    }
    this.view={...this.view,windows};
  }
  private changed(): void { this.revision++; for (const fn of this.listeners) fn(); }
  getRevision = (): number => this.revision;
  snapshot(): Snapshot { return { cards: [...this.session.state.cards], children: [...this.session.state.children],
    seq: this.session.state.lastAppliedSeq, view: this.view, undoCount: this.session.events.length, revision: this.revision }; }
  accept(snapshot: Snapshot): void {
    this.session.state = { cards: new Map(snapshot.cards), children: new Map(snapshot.children), lastAppliedSeq: snapshot.seq };
    this.view = snapshot.view;
    this.undoCount = snapshot.undoCount;
    this.changed();
  }
  execute(request: Request,beforeExecute?:()=>Promise<void>,desktopExecute?:(tool:string,args:Record<string,unknown>)=>Promise<unknown>): Promise<{ createdId?: string; createdWindowId?:string; toolResult?:unknown }> {
    if(request.kind==='extension-job')return this.queryExtensionJob(request.jobId).then(toolResult=>({toolResult}));
    const task = this.queue.then(async () => {
      // A previous failed write is retried before accepting a new mutation.
      await this.buffer.flushTo(this.backend);
      await beforeExecute?.();
      const eventCount=this.session.events.length;
      const previousEvents=[...this.session.events];
      let actor:Actor={kind:'user',id:'user',name:this.view.userSignature || uiText('collaboration.defaultUser')};
      if(request.kind==='mcp'){
        actor=validateActor(request.context?.actor,'ai');
        validateToolCall(request.tool,request.args);
        if(request.tool==='read_operations'){
          this.journal.importEvents(this.session.events);
          if(request.context?.reviewToken)this.journal.confirm(actor,request.context.reviewToken,true);
          const value=this.journal.read(actor,request.context?.reviewToken,request.args.cursor as string|undefined,{all:request.args.all===true,details:request.args.details===true});
          await this.buffer.flushTo(this.backend);return {toolResult:value};
        }
        if(request.tool==='ack_operations'){const value=this.journal.confirm(actor,request.context?.reviewToken);await this.buffer.flushTo(this.backend);return {toolResult:value};}
        this.journal.assertReviewed(actor,request.context?.reviewToken);
        this.journal.confirm(actor,request.context?.reviewToken);
      }
      if(request.kind!=='signature')actor=validateActor(actor);
      this.session.actor=actor;
      const readOnly=request.kind==='mcp' && READ_ONLY_MCP_TOOLS.has(request.tool);
      this.error='';if(!readOnly){this.busy=true;this.status=uiText('webview/controller.text002');this.changed();}
      let result: { createdId?: string; createdWindowId?:string; toolResult?:unknown } = {};
      const previousLayouts = request.kind === 'layout' || request.kind === 'presentation' || (request.kind==='mcp' && ['set_layout','use_presentation'].includes(request.tool))
        ? new Map([...this.session.state.cards.keys()].map(id=>[id,rendererOf(this.session.state,id)])) : null;

      if(request.kind==='extension-control'){
        if(!this.extensionTransport)throw new Error(uiText('extensions.noDesktop'));
        const id=request.id,old=this.view.extensions?.[id] ?? {installed:true,enabled:true,config:{root:this.session.root}};
        let next={...old};
        if(request.method==='install'){const manifest=AVAILABLE_EXTENSIONS.find(e=>e.id===id);if(!manifest)throw new Error(uiText('extensions.missing'));const service=new DesktopExtensionService(id,this.extensionTransport);this.extensions.register(manifest,service);this.extensionServices.set(id,service);await this.extensions.initialize(id,old.config);await this.extensions.enable(id);next={...old,installed:true,enabled:true};}
        else if(request.method==='enable'){await this.extensions.enable(id);next.enabled=true;}
        else if(request.method==='disable'){await this.extensions.disable(id);next.enabled=false;}
        else if(request.method==='uninstall'){await this.extensions.uninstall(id);this.extensionServices.delete(id);next={...old,enabled:false,installed:false};}
        else if(request.method==='configure'){await this.extensions.configure(id,request.config ?? {});next.config=request.config ?? {};if(old.enabled)await this.extensions.enable(id);}
        else throw new Error(uiText('extensions.invalid'));
        this.view={...this.view,extensions:{...this.view.extensions,[id]:next}};
      }else if(request.kind==='extension-invoke'){
        if(!this.extensionTransport)throw new Error(uiText('extensions.noDesktop'));
        this.extensionStarting=true;let value:unknown;try{value=await this.extensions.invoke(request.id,request.method,request.args);}finally{this.extensionStarting=false;}this.extensionJobs.set((value as {jobId:number}).jobId,{actor,method:request.method,id:request.id,repository:String((this.extensionServices.get(request.id)?.status() as Record<string,unknown>)?.root ?? ''),arguments:compactChange(Object.fromEntries(Object.entries(request.args).filter(([key])=>['paths','ref','name','message','remote','side','confirmed'].includes(key))))});result={toolResult:value};
        const jobId=(value as {jobId:number}).jobId,early=this.earlyExtensionResults.get(jobId);this.earlyExtensionResults.clear();if(early)void this.completeExtension(jobId,early).catch(error=>{this.error=String(error);this.changed();});
      }else if(request.kind==='extension-result'){
        actor=validateActor(request.actor);this.session.actor=actor;
      }else if(request.kind==='mcp'){
        if(request.tool==='undo' && this.session.events.at(-1)?.type==='card_create' && ['000','001','002','003'].includes(this.session.events.at(-1)!.cardId))throw new Error(uiText('webview/controller.text006'));
        const previousClient=this.session.clientId;
        try{this.session.clientId=actor.id;const tool=validateToolCall(request.tool,request.args);if(request.tool==='set_field' && request.args.path==='/images'){
          if(!validCardImages(request.args.value))throw new Error(uiText('images.invalid'));
          if(!desktopExecute)throw new Error(uiText('images.desktopOnly'));
          await desktopExecute('verify-images',{images:request.args.value});
          executeAction(this.session,{kind:'images-update',id:request.args.cardId as string,images:request.args.value});result={toolResult:readCard(this.session,request.args.cardId as string)};
        }else if(tool.execution==='desktop'){if(!desktopExecute)throw new Error(uiText('mcp/extended.desktopOnly'));result={toolResult:await desktopExecute(request.tool,request.args)};}else result={toolResult:callTool(this.session,request.tool,request.args)};}
        finally{this.session.clientId=previousClient;}

      } else if(request.kind==='images-import'){
        const card=readCard(this.session,request.id);
        if(request.inputs.length>64)throw new Error(uiText('images.tooLarge'));
        if(request.beforeContent!==undefined && request.beforeContent!==card.content)throw new Error(uiText('images.editConflict'));
        if(!desktopExecute)throw new Error(uiText('images.desktopOnly'));
        const imported=await desktopExecute('images-import',{inputs:request.inputs}) as Omit<CardImage,'id'>[];
        const images=imported.map(image=>({...image,id:this.session.newId()}));
        executeAction(this.session,{kind:'images-append',id:request.id,images,...(request.offset===undefined?{}:{offset:request.offset}),...(request.beforeContent===undefined?{}:{beforeContent:request.beforeContent})});
      } else if(request.kind==='share-export'){
        readCard(this.session,request.id);if(!desktopExecute)throw new Error(uiText('share.desktopOnly'));
        await desktopExecute('share-export',{id:request.id});
      } else if(request.kind==='share-import'){
        if(!desktopExecute)throw new Error(uiText('share.desktopOnly'));
        const pkg=await desktopExecute('share-import',{}) as SharePackage|null;
        if(pkg){const imported=importSharePackage(this.session,pkg,request.parent);result={createdId:imported.rootId};}
      } else if(request.kind==='images-update'){
        if(!validCardImages(request.images))throw new Error(uiText('images.invalid'));
        if(desktopExecute)await desktopExecute('verify-images',{images:request.images});
        result=executeAction(this.session,request);
      } else if(request.kind==='window-state'){
        // Native effect has already completed; retain the completed gesture in the feed.
      } else if(request.kind==='workspace'){
        if(!desktopExecute)throw new Error(uiText('mcp/extended.desktopOnly'));await desktopExecute('switch_workspace',{path:request.path});
      } else if(request.kind==='signature'){
        actor=validateActor({kind:'user',id:'user',name:request.name});this.session.actor=actor;this.view={...this.view,userSignature:actor.name};
      } else if(request.kind==='tutorial'){
        const id=ensureTutorial(this.session,this.view.tutorialCardId);
        const opened=freshWindow(this.view,id);
        this.view={...opened.view,tutorialCardId:id,windows:{...opened.view.windows,[opened.windowId]:{...windowViewFor(opened.view,opened.windowId),childArea:{width:240,height:140}}}};
        result={createdId:id,createdWindowId:opened.windowId};
      } else if(request.kind==='skin') {
        if(!isSkin(request.skin))throw new Error(uiText('webview/controller.invalidSkin'));
        this.view={...this.view,skin:request.skin};
      } else if(request.kind==='interaction') {
        if(!validCanvasBindings(request.canvasDragBindings))throw new Error(uiText("webview/controller.text003"));
        this.view={...this.view,canvasDragBindings:request.canvasDragBindings};
      } else if (request.kind === 'appearance') {
        if(!Number.isFinite(request.cardRadius) || request.cardRadius<0 || request.cardRadius>MAX_CARD_RADIUS) throw new Error(uiText("webview/controller.text004"));
        this.view={...this.view,cardRadius:request.cardRadius};
      } else if (request.kind === 'close-all') {
        this.view = { ...this.view, openWindows: [] };
      } else if (request.kind === 'view') {
        if (request.childArea && (!Number.isFinite(request.childArea.width) || !Number.isFinite(request.childArea.height) || request.childArea.width < 0 || request.childArea.height < 0)) throw new Error(uiText("webview/controller.text005"));
        const old = this.view.windows[request.id] ?? { focusId: windowAnchor(request.id), bounds: null,
          regions: { breadcrumb: 32, content: 200, children: 240 }, collapsed: { breadcrumb: false, content: false, children: false } };
        this.view = { ...this.view, windows: { ...this.view.windows, [request.id]: { ...old,
          focusId: request.focus ?? old.focusId,
          ...(request.childArea ? { childArea: request.childArea } : {}),
          regions: { ...old.regions, content: request.contentHeight ?? old.regions.content } } } };
      } else if (request.kind === 'window') {
        this.view = request.open ? openWindow(this.view, request.id) : closeWindow(this.view, request.id);
        if(request.open)this.view={...this.view,windows:{...this.view.windows,[request.id]:{...windowViewFor(this.view,request.id),focusId:windowAnchor(request.id)}}};
      } else if (request.kind === 'float') {
        const card = this.session.state.cards.get(request.id);
        if (card?.isPrefab && card.prefabRef===null) result = executeAction(this.session, { kind: 'instantiate', id: request.id, parent: null });
        else executeAction(this.session, { kind: 'move', id: request.id, parent: null, index: 0 });
        const opened=freshWindow(this.view,result.createdId ?? request.id);
        this.view=opened.view;result={...result,createdWindowId:opened.windowId};
      } else {
        if (request.kind === 'undo' && this.session.events.at(-1)?.type === 'card_create' && ['000','001','002','003'].includes(this.session.events.at(-1)!.cardId)) throw new Error(uiText("webview/controller.text006"));
        result = executeAction(this.session, request);

      }
      if(previousLayouts) {
        const windows = {...this.view.windows};
        for(const [id,before] of previousLayouts) {
          const after = rendererOf(this.session.state,id);
          if(after === before || (after !== 'plain' && after !== 'ordered' && after !== 'tabs')) continue;
          windows[id] = {...windowViewFor(this.view,id), childArea: after === 'ordered'
            ? {width:CHILD_MIN_WIDTH,height:9999} : {width:9999,height:CHILD_MIN_HEIGHT}};
        }
        this.view = {...this.view,windows};
      }
      this.normalizeWindowFocus();
      const roots = new Set(windowCards(this.session.state));
      this.view = { ...this.view, openWindows: this.view.openWindows.filter(id => roots.has(windowAnchor(id)) || extensionAvailable(windowAnchor(id),this.view.extensions)) };
      if(!readOnly)writeViewState(this.session.root, this.view, this.buffer.ops);
      if(!readOnly || this.session.events.length!==eventCount){
        const events=this.session.events.slice(eventCount);
        const undone=this.session.events.length<eventCount?previousEvents.slice(this.session.events.length):[];
        this.journal.record(actor,request.kind==='mcp'?request.tool:request.kind,{request:compactChange(request.kind==='mcp'?request.args:request.kind==='images-import'?imageRequestSummary(request):request),events:compactChange(events),undone:compactChange(undone),eventKeys:events.map(eventKey)},this.session.events);
      }
      await this.buffer.flushTo(this.backend);
      this.status = uiText("webview/controller.text001");
      this.undoCount = this.session.events.length;
      return result;
    });
    this.queue = task.catch(error => { this.error = error instanceof Error ? error.message : String(error); this.status = uiText("webview/controller.text007"); })
      .finally(() => { this.busy = false; this.changed(); });
    return task;
  }
  async flush(): Promise<void> { await this.queue; this.journal.sealPending();await this.buffer.flushTo(this.backend); }
  async retry(): Promise<void> { await this.flush(); this.error = ''; this.status = uiText("webview/controller.text001"); this.changed(); }
}
