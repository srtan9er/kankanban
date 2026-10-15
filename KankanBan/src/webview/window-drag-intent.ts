import {cardIdFromLabel} from '../core/window-identity.ts';
import type {CanvasDragAction} from '../core/canvas-drag.ts';
/** Classify intent separately from pointer capture, native motion and drop execution. */
export function windowDragIntent({label,cardId,childBody,relationHandle,mode}:{label:string;cardId:string;childBody:boolean;relationHandle:boolean;mode?:CanvasDragAction|undefined}){
 const sourceWindow=cardIdFromLabel(label)===cardId && !childBody;
 return {sourceWindow,reparent:relationHandle,positionOnly:childBody && !sourceWindow && mode===undefined,
  movingWindow:mode==='window-desktop' || mode==='window-fixed' || (sourceWindow && !relationHandle)};
}
export function extractOnDesktop({valid,target,movingWindow}:{valid:boolean;target:unknown;movingWindow:boolean}):boolean{
 return !valid && !movingWindow && !target;
}
