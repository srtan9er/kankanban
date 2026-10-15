import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {isTauri} from './tauri-backend.ts';
import {uiText} from '../i18n/text.ts';
type Config={available:boolean;bridgeReady:boolean;path:string;configuration:unknown};
export function McpSettings(){
 const [config,setConfig]=useState<Config|null>(null),[feedback,setFeedback]=useState('');
 useEffect(()=>{if(isTauri())void invoke<Config>('mcp_connection_config').then(setConfig).catch(e=>setFeedback(String(e)));},[]);
 return <div className="settings-card"><h3>{uiText('mcp/release.title')}</h3><p>{uiText('mcp/release.help')}</p>{config?<><p>{uiText(config.available?'mcp/release.available':'mcp/release.missing')}</p><p>{uiText(config.bridgeReady?'mcp/release.bridgeReady':'mcp/release.bridgeStopped')}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(config.configuration,null,2)}</pre><button disabled={!config.available} onClick={()=>void navigator.clipboard.writeText(JSON.stringify(config.configuration,null,2)).then(()=>setFeedback(uiText('mcp/release.copied'))).catch(e=>setFeedback(String(e)))}>{uiText('mcp/release.copy')}</button></>:!isTauri()?<p>{uiText('mcp/release.browser')}</p>:null}{feedback&&<p role="status">{feedback}</p>}</div>;
}
