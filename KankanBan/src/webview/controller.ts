import {isSkin,type SkinId} from '../core/skins.ts';
import {locateEntry,isInSubtree} from '../core/indexes.ts';
import {uiText} from '../i18n/text.ts';
import {validCanvasBindings,type CanvasDragBindings} from '../core/canvas-drag.ts';
import {CHILD_MIN_WIDTH, CHILD_MIN_HEIGHT} from '../core/layout-metrics.ts';
import {rendererOf} from '../core/renderer.ts';
import type { Session } from '../core/workspace.ts';
import { executeAction, type Action } from '../core/actions.ts';
import { MAX_CARD_RADIUS, openWindow, closeWindow, writeViewState, windowViewFor, type ViewState } from '../core/view-state.ts';
import { windowCards } from '../core/windows.ts';
import type { BufferedFs } from '../platform/buffered-fs-ops.ts';
import type { AsyncFsOps } from '../platform/async-fs-ops.ts';

export type Request = Action | {kind:'skin';skin:SkinId} | {kind:'interaction';canvasDragBindings:CanvasDragBindings} | { kind: 'appearance'; cardRadius: number } | { kind: 'window'; id: string; open: boolean } | { kind: 'close-all' } | { kind: 'float'; id: string }
  | { kind: 'view'; id: string; focus?: string; contentHeight?: number; childArea?: { width: number; height: number } };
export type Snapshot = { cards: [string, Session['state']['cards'] extends Map<string, infer V> ? V : never][];
  children: [string, Session['state']['children'] extends Map<string, infer V> ? V : never][];
  seq: number; view: ViewState; undoCount: number; revision: number };

export class WorkspaceController {
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private listeners = new Set<() => void>();
  status = uiText("webview/controller.text001");
  error = '';
  busy = false;
  undoCount = 0;
  session: Session;
  view: ViewState;
  private buffer: BufferedFs;
  private backend: AsyncFsOps;
  constructor(session: Session, view: ViewState, buffer: BufferedFs, backend: AsyncFsOps) {
    this.session = session; this.view = view; this.buffer = buffer; this.backend = backend;
    this.undoCount = session.events.length;
  }
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
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
  execute(request: Request): Promise<{ createdId?: string }> {
    const task = this.queue.then(async () => {
      // A previous failed write is retried before accepting a new mutation.
      await this.buffer.flushTo(this.backend);
      this.busy = true; this.error = ''; this.status = uiText("webview/controller.text002"); this.changed();
      let result: { createdId?: string } = {};
      if(request.kind==='skin') {
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
        const old = this.view.windows[request.id] ?? { focusId: request.id, bounds: null,
          regions: { breadcrumb: 32, content: 200, children: 240 }, collapsed: { breadcrumb: false, content: false, children: false } };
        this.view = { ...this.view, windows: { ...this.view.windows, [request.id]: { ...old,
          focusId: request.focus ?? old.focusId,
          ...(request.childArea ? { childArea: request.childArea } : {}),
          regions: { ...old.regions, content: request.contentHeight ?? old.regions.content } } } };
      } else if (request.kind === 'window') {
        this.view = request.open ? openWindow(this.view, request.id) : closeWindow(this.view, request.id);
        if(request.open)this.view={...this.view,windows:{...this.view.windows,[request.id]:{...windowViewFor(this.view,request.id),focusId:request.id}}};
      } else if (request.kind === 'float') {
        const card = this.session.state.cards.get(request.id);
        if (card?.isPrefab && card.prefabRef===null) result = executeAction(this.session, { kind: 'instantiate', id: request.id, parent: null });
        else executeAction(this.session, { kind: 'move', id: request.id, parent: null, index: 0 });
        this.view = openWindow(this.view, result.createdId ?? request.id);
      } else {
        if (request.kind === 'undo' && this.session.events.at(-1)?.type === 'card_create' && ['000','001','002','003'].includes(this.session.events.at(-1)!.cardId)) throw new Error(uiText("webview/controller.text006"));
        const previousLayouts = request.kind === 'layout' || request.kind === 'presentation'
          ? new Map([...this.session.state.cards.keys()].map(id=>[id,rendererOf(this.session.state,id)])) : null;
        const moving=request.kind==='move' || request.kind==='canvas-drop' ? request : null;
        const oldParent=moving ? locateEntry(this.session.state,moving.id)?.parentId ?? null : null;
        const wasInstance=moving ? !!this.session.state.cards.get(moving.id)?.prefabRef : false;
        result = executeAction(this.session, request);
        // Merging an instance moves the same node; collapse its old desktop expansion.
        if(moving && wasInstance && !result.createdId && moving.parent!==null && moving.parent!==oldParent){
          this.view=closeWindow(this.view,moving.id);
          const windows={...this.view.windows};
          for(const id of this.view.openWindows){
            const current=windows[id];
            if(current && !isInSubtree(this.session.state,id,current.focusId))windows[id]={...current,focusId:id};
          }
          this.view={...this.view,windows};
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
      }
      const roots = new Set(windowCards(this.session.state));
      this.view = { ...this.view, openWindows: this.view.openWindows.filter(id => roots.has(id)) };
      writeViewState(this.session.root, this.view, this.buffer.ops);
      await this.buffer.flushTo(this.backend);
      this.status = uiText("webview/controller.text001");
      this.undoCount = this.session.events.length;
      return result;
    });
    this.queue = task.catch(error => { this.error = error instanceof Error ? error.message : String(error); this.status = uiText("webview/controller.text007"); })
      .finally(() => { this.busy = false; this.changed(); });
    return task;
  }
  async flush(): Promise<void> { await this.queue; await this.buffer.flushTo(this.backend); }
  async retry(): Promise<void> { await this.flush(); this.error = ''; this.status = uiText("webview/controller.text001"); this.changed(); }
}
