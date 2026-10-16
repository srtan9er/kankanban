import type {CardFields,Layout} from './types.ts';
import {CHILD_MIN_WIDTH,CHILD_MIN_HEIGHT} from './layout-metrics.ts';
import {uiText} from '../i18n/text.ts';

export type RegionSize={width:number;height:number};
export type LayoutSizes=Partial<Record<Layout,{width?:number;height?:number}>>;
const layouts=new Set(['plain','ordered','tabs','grid','library','columns','plane']);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
export function validLayoutSizes(value:unknown):value is LayoutSizes {
 return object(value)&&Object.entries(value).every(([layout,size])=>layouts.has(layout)&&object(size)&&Object.keys(size).length>0&&Object.entries(size).every(([key,n])=>['width','height'].includes(key)&&typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1e7));
}
export const copyLayoutSizes=(value:LayoutSizes):LayoutSizes=>Object.fromEntries(Object.entries(value).map(([layout,size])=>[layout,{...size}]));
export const regionLayout=(layout:Layout):'plain'|'ordered'|undefined=>layout==='ordered'?'ordered':layout==='plain'||layout==='tabs'?'plain':undefined;
export function defaultChildArea(layout:Layout):RegionSize {
 return layout==='ordered'?{width:CHILD_MIN_WIDTH,height:9999}:{width:9999,height:CHILD_MIN_HEIGHT};
}
export function normalizedChildArea(layout:Layout,size:RegionSize):RegionSize {
 if(![size.width,size.height].every(n=>Number.isFinite(n)&&n>=0&&n<=1e7))throw new Error(uiText('layoutSizing.invalid'));
 const vertical=layout==='ordered',axis=vertical?'width':'height',minimum=vertical?CHILD_MIN_WIDTH:CHILD_MIN_HEIGHT;
 return size[axis]===0?{width:0,height:0}:{...defaultChildArea(layout),[axis]:Math.max(minimum,size[axis])};
}
/** Legacy window values are used only until the card has its own size history. */
export function savedChildArea(card:Pick<CardFields,'layoutSizes'>,layout:Layout,legacy?:RegionSize):RegionSize|undefined {
 const mode=regionLayout(layout);if(!mode)return;
 const stored=card.layoutSizes?.[mode];
 return normalizedChildArea(mode,card.layoutSizes===undefined&&legacy?legacy:{...defaultChildArea(mode),...stored});
}
/** Save the adjustable axis only; the other axis always fills the available space. */
export function updatedLayoutSizes(current:LayoutSizes|undefined,layout:Layout,size:RegionSize):LayoutSizes {
 const next=copyLayoutSizes(current ?? {}),mode=regionLayout(layout);if(!mode)return next;
 const area=normalizedChildArea(mode,size),axis=mode==='ordered'?'width':'height';
 if(area[axis]===defaultChildArea(mode)[axis])delete next[mode];else next[mode]={[axis]:area[axis]};
 return next;
}
