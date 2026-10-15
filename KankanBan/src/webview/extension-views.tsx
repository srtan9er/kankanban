import type {ComponentType} from 'react';
import type {WorkspaceController,Request} from './controller.ts';
import {GitPanel} from './GitPanel.tsx';
export type ExtensionViewProps={controller:WorkspaceController;send:(r:Request)=>Promise<{createdId?:string;toolResult?:unknown}>};
const views=new Map<string,ComponentType<ExtensionViewProps>>([['git',GitPanel]]);
export function registerExtensionView(id:string,view:ComponentType<ExtensionViewProps>):void{if(views.has(id))throw new Error(id);views.set(id,view);}
export function extensionView(id:string){return views.get(id);}
