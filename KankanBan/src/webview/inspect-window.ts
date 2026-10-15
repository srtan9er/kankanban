import {cardIdFromLabel,windowIdFromLabel} from '../core/window-identity.ts';
import type {WorkspaceController} from './controller.ts';
import {readMarkdownEditor} from './markdown-editor-model.ts';
export function inspectLocalWindow(c:WorkspaceController,label:string){
 const rect=(element:Element|null)=>{if(!element)return null;const box=element.getBoundingClientRect();return {x:box.left,y:box.top,width:box.width,height:box.height};};
 const canvas=document.querySelector<HTMLElement>('.canvas-viewport'),svg=document.querySelector<SVGSVGElement>('.doodle-layer'),body=document.querySelector<HTMLElement>('.preview,.card-body-region');
 const cardId=label==='main'?document.querySelector<HTMLElement>('main')?.dataset.dropParent ?? null:c.view.windows[windowIdFromLabel(label)!]?.focusId ?? cardIdFromLabel(label);
 const card=cardId?c.session.state.cards.get(cardId):undefined;
 const title=document.querySelector<HTMLInputElement>('input.title'),editor=document.querySelector<HTMLElement>('[data-markdown-editor],textarea.content');
 const markdown=document.querySelector<HTMLElement>('.proto-note .preview .markdown,.ordinary-document .markdown,.rich-image-body');
 const display={title:title?.value ?? document.querySelector('.editable-title')?.textContent ?? null,bodyText:markdown?.textContent?.slice(0,10000) ?? null,editorText:editor?(editor.hasAttribute('data-markdown-editor')?readMarkdownEditor(editor):(editor as HTMLTextAreaElement).value).slice(0,10000):null};
 const diagnostics=c.desktopDiagnostics;
 const model=card?{id:card.id,title:card.title,content:card.content.slice(0,10000),contentLength:card.content.length}:null;
 return {windowLabel:label,cardId,workspace:c.session.root,revision:c.getRevision(),dataSeq:c.session.state.lastAppliedSeq,diagnostics,model,display,coordinateSpace:'window-css',viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},body:body?{rect:rect(body),scrollLeft:body.scrollLeft,scrollTop:body.scrollTop,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,drawingRect:rect(svg),drawingViewBox:svg?{x:svg.viewBox.baseVal.x,y:svg.viewBox.baseVal.y,width:svg.viewBox.baseVal.width,height:svg.viewBox.baseVal.height}:null}:null,canvas:canvas?{rect:rect(canvas),zoom:Number(canvas.dataset.canvasZoom),pan:{x:Number(canvas.dataset.canvasPanX),y:Number(canvas.dataset.canvasPanY)},period:{width:Number(canvas.dataset.canvasPeriodWidth),height:Number(canvas.dataset.canvasPeriodHeight)}}:null,cards:[...document.querySelectorAll<HTMLElement>('[data-card-id]')].slice(0,100).map(element=>({cardId:element.dataset.cardId,rect:rect(element)}))};
}
