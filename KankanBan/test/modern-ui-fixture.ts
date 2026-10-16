import './dom-setup.ts';

/** Browser capabilities missing from JSDOM; no native windows or network are started. */
export function installModernUI():void{
 Object.assign(globalThis,{
  MutationObserver:window.MutationObserver,CustomEvent:window.CustomEvent,localStorage:window.localStorage,
  ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},
  requestAnimationFrame:(callback:FrameRequestCallback)=>setTimeout(()=>callback(0),0),cancelAnimationFrame:clearTimeout,
  OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:[...text].length*8})};}},
 });
 Object.defineProperties(window.Range.prototype,{getClientRects:{configurable:true,value:()=>[]},getBoundingClientRect:{configurable:true,value:()=>new window.DOMRect()}});
}
