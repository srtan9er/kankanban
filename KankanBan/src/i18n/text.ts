import catalog from './zh-CN.json' with {type:'json'};

export const locale = 'zh-CN';
type Catalog=typeof catalog;
export type TextKey={ [Group in keyof Catalog]: `${Group & string}.${keyof Catalog[Group] & string}` }[keyof Catalog];
/** Parameter substitution preserves values containing dollar signs, braces or HTML. */
export function uiText(key:TextKey,values:Readonly<Record<string,unknown>>={}):string {
 const split=key.lastIndexOf('.'),group=key.slice(0,split),entry=key.slice(split+1);
 const text=(catalog as Record<string,Record<string,string>>)[group]?.[entry];
 if(text===undefined)throw new Error(catalog.app.missingKey.replace('{arg0}',key));
 return text.replace(/\{(arg\d+)\}/g,(match,name:string)=>Object.hasOwn(values,name)?String(values[name]):match);
}
