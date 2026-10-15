import {invoke} from '@tauri-apps/api/core';
import {windowAnchor} from '../core/window-identity.ts';
import {windowCards} from '../core/windows.ts';
import type {CoreState} from '../core/state.ts';
import type {ViewState} from '../core/view-state.ts';
import {extensionAvailable} from '../extensions/registry.ts';
export type NativeWindowInvoke=<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
/** Keep native command compatibility here: their cardId argument identifies a desktop view. */
export function cardWindowService(call:NativeWindowInvoke=invoke){
 return {
  open:(windowId:string)=>call<void>('open_card_window',{cardId:windowId}),
  close:(windowId:string)=>call<void>('close_card_window',{cardId:windowId}),
  position:(windowId:string,x:number,y:number)=>call<void>('position_card_window',{cardId:windowId,x,y}),
  labels:()=>call<string[]>('card_window_labels'),
  sync:(wanted:readonly string[])=>call<string[]>('sync_card_windows',{wanted}),
 };
}
export function wantedDesktopViews(state:CoreState,view:ViewState):string[]{
 const alive=new Set(windowCards(state));
 return view.openWindows.filter(id=>id!=='000' && (alive.has(windowAnchor(id)) || extensionAvailable(windowAnchor(id),view.extensions)));
}
