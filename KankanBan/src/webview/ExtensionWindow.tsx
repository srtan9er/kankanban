import {PrototypeNote} from './PrototypeNote.tsx';
import {extensionView,type ExtensionViewProps} from './extension-views.tsx';
import {AVAILABLE_EXTENSIONS,extensionId} from '../extensions/registry.ts';
import {windowAnchor} from '../core/window-identity.ts';
import {EditMode} from './edit-mode.ts';
import {uiText} from '../i18n/text.ts';
import type {WorkspaceAppProps} from './WorkspaceApp.tsx';
import type {CardFields} from '../core/types.ts';
import {useEffect,useState,Component,type ReactNode} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {isTauri} from './tauri-backend.ts';
export function ExtensionWindow({controller:c,windowId,send,close,startDrag}:{controller:import('./controller.ts').WorkspaceController;windowId:string;send:ExtensionViewProps['send'];close:WorkspaceAppProps['close'];startDrag:WorkspaceAppProps['startDrag']}){
 const [windowError,setWindowError]=useState('');
 useEffect(()=>{let active=true;if(isTauri())void invoke<unknown>('window_preferences').then(value=>{if(active && !value)return invoke('resize_note',{width:920,height:680,finish:true});}).catch(error=>{if(active)setWindowError(String(error));});return()=>{active=false;};},[]);
 const id=extensionId(windowAnchor(windowId)) ?? '',manifest=AVAILABLE_EXTENSIONS.find(e=>e.id===id),View=extensionView(id);
 const card:CardFields={id:windowAnchor(windowId),title:uiText(manifest?.nameKey ?? 'extensions.missing'),content:'',layout:'plain',type:null,isPrefab:false,prefabRef:null,overrides:[],createdAt:0,updatedAt:0,createdBy:'extension',editingBy:null,deleted:false};
 return <EditMode.Provider value={{editable:false,busy:false}}><PrototypeNote extension card={card} viewId={windowId} send={send} close={close} startDrag={startDrag} hideBody add={()=>{}} breadcrumb={<span>{uiText('extensions.tab')}</span>}><ExtensionBoundary>{windowError&&<p role="alert">{windowError}</p>}{View?<View controller={c} send={send}/>:<p>{uiText('extensions.missing')}</p>}</ExtensionBoundary></PrototypeNote></EditMode.Provider>;
}
class ExtensionBoundary extends Component<{children:ReactNode},{error:string|null}>{
 override state:{error:string|null}={error:null};
 static getDerivedStateFromError(error:unknown){return {error:String(error)};}
 override render(){return this.state.error?<div role="alert">{uiText('extensions.failed')}<pre>{this.state.error}</pre><button onClick={()=>this.setState({error:null})}>{uiText('git.retry')}</button></div>:this.props.children;}
}
