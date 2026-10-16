export type InlineCodeMetric={size:number;family:string;weight:string;letterSpacing:number;left:number;right:number};
export type ParagraphMetric={size:number;lineHeight:number;family:string;weight:string;strongWeight:string;mono:string;code:InlineCodeMetric;letterSpacing:number;before:number;after:number;left:number;right:number};
export type TextMetrics={paragraphs:Record<string,ParagraphMetric>;insetX:number;insetY:number;insetBottom:number;taskWidth:number;gap:number};
const number=(value:string,fallback:number)=>Number.isFinite(parseFloat(value))?parseFloat(value):fallback;
export function readTextMetrics(host:HTMLElement):TextMetrics {
 const metrics:Record<string,ParagraphMetric>={};let taskWidth=20;const probe=host.ownerDocument.createElement('div');probe.setAttribute('aria-hidden','true');probe.style.cssText='position:fixed;visibility:hidden;pointer-events:none;width:320px;left:-10000px;top:0';host.append(probe);
 try{
  for(const kind of ['p','task','list','h1','h2','h3','blockquote','pre']){
   const tag=kind==='task' || kind==='list'?'p':kind;
   const element=host.ownerDocument.createElement(tag);element.className=`rich-text-paragraph${kind==='task'?' md-task':kind==='list'?' md-list':''}`;element.dataset.mdKind=tag;element.textContent='Mm 字';probe.append(element);const style=getComputedStyle(element),size=number(style.fontSize,tag==='h1'?23:tag==='h2'?19:tag==='h3'?16:tag==='pre'?12:13);
   const strong=host.ownerDocument.createElement('strong');element.append(strong);const code=host.ownerDocument.createElement('code');element.append(code);const codeStyle=getComputedStyle(code),mono=codeStyle.fontFamily||'Consolas,monospace';
   metrics[kind]={size,lineHeight:number(style.lineHeight,size*1.6),family:style.fontFamily || getComputedStyle(host).fontFamily,weight:style.fontWeight||'400',strongWeight:getComputedStyle(strong).fontWeight||'600',mono,code:{size:number(codeStyle.fontSize,size),family:mono,weight:codeStyle.fontWeight||style.fontWeight||'400',letterSpacing:number(codeStyle.letterSpacing,number(style.letterSpacing,0)),left:number(codeStyle.paddingLeft,0)+number(codeStyle.borderLeftWidth,0),right:number(codeStyle.paddingRight,0)+number(codeStyle.borderRightWidth,0)},letterSpacing:number(style.letterSpacing,0),before:number(style.marginTop,2)+number(style.paddingTop,0)+number(style.borderTopWidth,0),after:number(style.marginBottom,2)+number(style.paddingBottom,0)+number(style.borderBottomWidth,0),left:number(style.paddingLeft,0)+number(style.borderLeftWidth,0),right:number(style.paddingRight,0)+number(style.borderRightWidth,0)};
   if(kind==='task'){
    const check=host.ownerDocument.createElement('input');check.type='checkbox';check.className='markdown-task-check';element.append(check);const checkStyle=getComputedStyle(check);
    const chrome=checkStyle.boxSizing==='border-box'?0:number(checkStyle.paddingLeft,0)+number(checkStyle.paddingRight,0)+number(checkStyle.borderLeftWidth,0)+number(checkStyle.borderRightWidth,0);
    taskWidth=(check.getBoundingClientRect().width || number(checkStyle.width,14)+chrome)+number(checkStyle.marginLeft,0)+number(checkStyle.marginRight,6);
   }
  }
  const inset=host.ownerDocument.createElement('div');inset.style.cssText='width:var(--md-inset-x,16px);height:var(--md-inset-top,var(--md-inset-y,12px))';probe.append(inset);const style=getComputedStyle(inset),hostStyle=getComputedStyle(host),symmetric=number(hostStyle.getPropertyValue('--md-inset-y'),12);
  const bottom=host.ownerDocument.createElement('div');bottom.style.height='var(--md-inset-bottom,var(--md-inset-y,12px))';probe.append(bottom);
  const gap=host.ownerDocument.createElement('div');gap.className='paragraph-gap';probe.append(gap);
  return {paragraphs:metrics,insetX:number(style.width,number(hostStyle.getPropertyValue('--md-inset-x'),16)),insetY:number(style.height,number(hostStyle.getPropertyValue('--md-inset-top'),symmetric)),insetBottom:number(getComputedStyle(bottom).height,number(hostStyle.getPropertyValue('--md-inset-bottom'),symmetric)),taskWidth,gap:number(getComputedStyle(gap).height,10)};
 }finally{probe.remove();}
}
