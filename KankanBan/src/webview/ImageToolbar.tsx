import type {ImageLayout} from '../core/image-markdown.ts';
import {uiText} from '../i18n/text.ts';
const layouts:ImageLayout[]=['inline','float','overlay','underlay'];
function LayoutIcon({mode}:{mode:ImageLayout}){
 return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  {mode==='inline'?<><path d="M3 5h18M3 15h5m8 0h5"/><rect x="9" y="10" width="6" height="9"/></>:mode==='float'?<><rect x="3" y="4" width="8" height="10"/><path d="M15 4h6m-6 5h6m-6 5h6M3 20h18"/></>:mode==='overlay'?<><path d="M3 4h18M3 9h18M3 15h18M3 20h18"/><rect x="8" y="7" width="9" height="10" fill="var(--surface)"/></>:<><rect x="8" y="7" width="9" height="10"/><path d="M3 4h18M3 9h18M3 15h18M3 20h18"/></>}
 </svg>;
}
export function ImageToolbar({layout,busy,choose,layerUp,layerDown,canUp=false,canDown=false,modes=layouts,label=uiText('images.layout')}:{layout:ImageLayout;busy:boolean;choose:(layout:ImageLayout)=>void;layerUp?:()=>void;layerDown?:()=>void;canUp?:boolean;canDown?:boolean;modes?:ImageLayout[];label?:string}){
 return <div className="image-layout-toolbar" role="toolbar" aria-label={label} onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}>
  <div className="image-tool-row image-layer-row">{(['up','down'] as const).map(direction=><button key={direction} data-image-layer={direction} disabled={busy || (direction==='up'?!canUp:!canDown)} title={uiText(direction==='up'?'images.layerUp':'images.layerDown')} aria-label={uiText(direction==='up'?'images.layerUp':'images.layerDown')} onClick={direction==='up'?layerUp:layerDown}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 12 9 5 9-5M3 17l9 5 9-5M3 7l9 5 9-5-9-5z"/><path d={direction==='up'?'M12 9V3m-3 3 3-3 3 3':'M12 3v6m-3-3 3 3 3-3'} fill="var(--surface)"/></svg></button>)}{modes.filter(mode=>mode==='inline' || mode==='float').map(mode=><button key={mode} data-layout-mode={mode} disabled={busy} aria-pressed={mode===layout} title={uiText(`images.${mode}`)} aria-label={uiText(`images.${mode}`)} onClick={()=>choose(mode)}><LayoutIcon mode={mode}/></button>)}</div>
  {modes.length>2 && <div className="image-tool-row image-layout-row">{modes.filter(mode=>mode==='overlay' || mode==='underlay').map(mode=><button key={mode} data-layout-mode={mode} disabled={busy} aria-pressed={mode===layout} title={uiText(`images.${mode}`)} aria-label={uiText(`images.${mode}`)} onClick={()=>choose(mode)}><LayoutIcon mode={mode}/></button>)}</div>}
 </div>;
}
