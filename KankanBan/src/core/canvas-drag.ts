import {uiText} from '../i18n/text.ts';
export type CanvasDragAction='pan'|'window-desktop'|'window-fixed';
export type CanvasDragBindings={left:CanvasDragAction;right:CanvasDragAction;combined:CanvasDragAction};
export const canvasDragOptions:readonly [CanvasDragAction,string][]=[['pan',uiText("core/canvas-drag.text001")],['window-desktop',uiText("core/canvas-drag.text002")],['window-fixed',uiText("core/canvas-drag.text003")]];
export function canvasBindings(view:{canvasDragBindings?:CanvasDragBindings;canvasSwapButtons?:boolean}):CanvasDragBindings {
 return view.canvasDragBindings ?? {left:view.canvasSwapButtons===false?'window-desktop':'pan',right:view.canvasSwapButtons===false?'pan':'window-desktop',combined:'window-fixed'};
}
export function validCanvasBindings(value:CanvasDragBindings):boolean {
 return !!value && ['left','right','combined'].every(key=>canvasDragOptions.some(([action])=>action===value[key as keyof CanvasDragBindings]));
}
export function canvasGesture(button:number,buttons:number):keyof CanvasDragBindings {
 return (buttons&3)===3 || button===1 || !!(buttons&4)?'combined':button===2?'right':'left';
}
