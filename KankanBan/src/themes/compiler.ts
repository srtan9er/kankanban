import {parse,type AtRule} from 'postcss';
import valueParser from 'postcss-value-parser';
import {uiText} from '../i18n/text.ts';
export type ThemeAsset={kind:string;content:string};
export type ThemeReader=(path:string)=>Promise<ThemeAsset|null>;
export type ThemeEntry={id:string;name:string;mode?:'light'|'dark'};
import {validThemeId} from '../core/themes.ts';
const unescapeCss=(value:string)=>value.replace(/\\([0-9a-f]{1,6}\s?|[^\r\n])/gi,(_,part:string)=>/^[0-9a-f]/i.test(part)?String.fromCodePoint(Math.min(0x10ffff,parseInt(part.trim(),16)) || 0xfffd):part);
const embedded=(url:string)=>/^data:(?:image\/(?:png|jpeg|gif|webp)|font\/[\w-]+|application\/(?:font-woff|vnd.ms-fontobject));base64,/i.test(url);
function relative(from:string,url:string):string{
 url=unescapeCss(url).trim();
 if(/^[a-z][\w+.-]*:|^[\\/]/i.test(url))throw new Error(uiText('themes.remote',{arg0:url}));
 try{url=decodeURIComponent(url.split(/[?#]/)[0]!);}catch{throw new Error(uiText('themes.invalidPath',{arg0:url}));}
 if(/^[a-z][\w+.-]*:|^[\\/]/i.test(url))throw new Error(uiText('themes.invalidPath',{arg0:url}));
 const parts=from.split('/').slice(0,-1);for(const part of url.replaceAll('\\','/').split('/')){if(part==='..'){if(!parts.length)throw new Error(uiText('themes.invalidPath',{arg0:url}));parts.pop();}else if(part && part!=='.')parts.push(part);}
 return parts.join('/');
}
const cssUrl=(css:string)=>`data:text/css;charset=utf-8,${encodeURIComponent(css)}`;
/** Bundle through a confined native reader; PostCSS preserves selectors and import conditions. */
export async function compileTheme(entry:string,read:ThemeReader):Promise<string>{
 if(!validThemeId(entry))throw new Error(uiText('themes.invalid'));let files=0,total=0;
 const load=async(path:string,ancestors:string[]):Promise<string>=>{
  if(ancestors.includes(path)||ancestors.length>16||++files>128)throw new Error(uiText('themes.cycle',{arg0:path}));
  const file=await read(path);if(!file||file.kind!=='css')throw new Error(uiText('themes.missing',{arg0:path}));total+=file.content.length;if(total>2*1024*1024)throw new Error(uiText('themes.tooLarge'));
  let root;try{root=parse(file.content,{from:undefined});}catch{throw new Error(uiText('themes.invalidCss',{arg0:path}));}
  const imports:AtRule[]=[];root.walkAtRules(rule=>{if(unescapeCss(rule.name).toLowerCase()==='import')imports.push(rule);});
  for(const rule of imports){const values=valueParser(rule.params),first=values.nodes.find(n=>n.type!=='space'&&n.type!=='comment');if(!first)throw new Error(uiText('themes.invalidCss',{arg0:path}));
   const url=first.type==='string'?first.value:first.type==='function'&&unescapeCss(first.value).toLowerCase()==='url'?valueParser.stringify(first.nodes).replace(/^['"]|['"]$/g,''):'';if(!url)throw new Error(uiText('themes.invalidCss',{arg0:path}));
   const imported=await load(relative(path,url),[...ancestors,path]);const tail=rule.params.slice(first.sourceEndIndex);rule.name='import';rule.params=`url("${cssUrl(imported)}")${tail}`;
  }
  const declarations:import('postcss').Declaration[]=[];root.walkDecls(decl=>{declarations.push(decl);});
  for(const decl of declarations){const values=valueParser(decl.value),refs:import('postcss-value-parser').FunctionNode[]=[],strings:import('postcss-value-parser').StringNode[]=[];values.walk(node=>{
   if(node.type==='string'||node.type==='word'){const value=unescapeCss(node.value).trim();if(/^[a-z][\w+.-]*:|^\/\//i.test(value)&&!embedded(value))throw new Error(uiText('themes.remote',{arg0:value}));}
   if(node.type==='function'){const name=unescapeCss(node.value).toLowerCase();if(name==='url'){node.value='url';refs.push(node);return false;}if(['image-set','-webkit-image-set'].includes(name))for(const child of node.nodes)if(child.type==='string')strings.push(child);}
  });
   for(const node of refs){const url=unescapeCss(valueParser.stringify(node.nodes).replace(/^['"]|['"]$/g,'')).trim();if(url.startsWith('#')||embedded(url))continue;
    const asset=await read(relative(path,url));if(!asset||asset.kind!=='asset')throw new Error(uiText('themes.missing',{arg0:url}));total+=asset.content.length;if(total>32*1024*1024)throw new Error(uiText('themes.tooLarge'));node.nodes=[{type:'string',quote:'"',value:asset.content,sourceIndex:0,sourceEndIndex:0}];
   }decl.value=values.toString();
   for(const node of strings){if(embedded(node.value))continue;const asset=await read(relative(path,node.value));if(!asset||asset.kind!=='asset')throw new Error(uiText('themes.missing',{arg0:node.value}));total+=asset.content.length;if(total>32*1024*1024)throw new Error(uiText('themes.tooLarge'));node.value=asset.content;}decl.value=values.toString();
  }
  return root.toString();
 };
 // Overrides are separate imports so their @imports remain legal, in cascade order.
 const layers:string[]=[];if(entry)layers.push(await load(entry,[]));
 for(const path of ['base.user.css',...(entry?[entry.replace(/\.css$/,'.user.css')]:[])]){if(await read(path))layers.push(await load(path,[]));}
 return layers.map(css=>`@import url("${cssUrl(css)}");`).join('\n');
}
