import MarkdownIt from 'markdown-it';
import {Schema,Fragment,type Node as RichNode,type NodeSpec,type MarkSpec} from 'prosemirror-model';
import {MarkdownParser,MarkdownSerializer,defaultMarkdownParser,defaultMarkdownSerializer,schema} from 'prosemirror-markdown';
import {imageMarkdownTokens} from '../core/image-markdown.ts';
import {parseTables} from '../core/table-markdown.ts';
import {inlineText} from '../core/markdown-syntax.ts';

/** Markdown remains the persisted format. These attributes are editor-only snapshots. */
const sourceAttrs={sourceRaw:{default:null},sourceFingerprint:{default:null},sourceGap:{default:''},sourceIdentity:{default:null}};
const nodes:Record<string,NodeSpec>={};
schema.spec.nodes.forEach((name,spec)=>{
 nodes[name]=name==='text'?spec:{...spec,attrs:{...spec.attrs,...sourceAttrs}};
});
nodes.doc={...nodes.doc!,attrs:{sourceRaw:{default:''},sourceFingerprint:{default:null},sourceSuffix:{default:''}}};
nodes.paragraph={...nodes.paragraph!,toDOM(){return ['p',{'data-md-kind':'p'},0];}};
nodes.heading={...nodes.heading!,content:'inline*',toDOM(node){return [`h${node.attrs.level}`,{'data-md-kind':`h${node.attrs.level}`},0];}};
nodes.blockquote={...nodes.blockquote!,toDOM(){return ['blockquote',{'data-md-kind':'blockquote'},0];}};
nodes.code_block={...nodes.code_block!,toDOM(node){return ['pre',{'data-md-kind':'pre','data-params':node.attrs.params},['code',0]];}};
nodes.horizontal_rule={...nodes.horizontal_rule!,toDOM(){return ['hr',{class:'markdown-rule'}];}};
nodes.list_item={...nodes.list_item!,attrs:{...nodes.list_item!.attrs,checked:{default:null}},toDOM(node){return node.attrs.checked===null?['li',0]:['li',{'data-task-item':'true'},['input',{type:'checkbox',checked:node.attrs.checked?'checked':null,contenteditable:'false',tabindex:'-1'}],['div',0]];}};
nodes.body_object={inline:true,group:'inline',atom:true,isolating:true,selectable:true,marks:'',attrs:{raw:{default:''},kind:{default:'unknown'},name:{default:''}},toDOM(node){return ['span',{'data-visual-object':node.attrs.kind,contenteditable:'false'},node.attrs.name?`<${node.attrs.name}>`:node.attrs.raw];}};
const marks:Record<string,MarkSpec>={};schema.spec.marks.forEach((name,spec)=>{marks[name]=spec;});
marks.strike={parseDOM:[{tag:'s'},{tag:'del'}],toDOM(){return ['del',0];}};
marks.sup={excludes:'sub',parseDOM:[{tag:'sup'}],toDOM(){return ['sup',0];}};
marks.sub={excludes:'sup',parseDOM:[{tag:'sub'}],toDOM(){return ['sub',0];}};
marks.link={...marks.link!,toDOM(mark){const href=String(mark.attrs.href);return ['a',{href:/^(https?:|mailto:)/i.test(href)?href:undefined,rel:'noopener noreferrer',title:mark.attrs.title},0];}};
export const richBodySchema=new Schema({nodes,marks});

const tokenizer=new MarkdownIt('commonmark',{html:false}).enable('strikethrough');
const scriptDepth=Symbol('kkb-script-depth');
tokenizer.inline.ruler.before('image','kkb_object',(state,silent)=>{
 const remaining=state.src.slice(state.pos);let raw='',kind='unknown',name='';
 if(remaining.startsWith('<image') || remaining.startsWith('![')){
  const image=imageMarkdownTokens(remaining)[0];if(image?.start===0){raw=remaining.slice(0,image.end);kind='image';name=image.name ?? '';}
 }else if(remaining.startsWith('<table')){
  const table=parseTables(remaining)[0];if(table?.start===0){raw=remaining.slice(0,table.end);kind='table';name=table.name;}
 }
 if(!raw && remaining[0]==='<')raw=/^<\/?[a-zA-Z][\w:-]*(?:\s+[^<>]*?)?\s*\/?>/.exec(remaining)?.[0] ?? '';
 if(!raw)return false;
 if(!silent){const token=state.push('body_object','',0);token.meta={raw,kind,name};}
 state.pos+=raw.length;return true;
});
tokenizer.inline.ruler.before('emphasis','kkb_script',(state,silent)=>{
 const environment=state.env as Record<symbol,number>,depth=environment[scriptDepth] ?? 0;if(depth>=24)return false;
 const delimiter=state.src[state.pos];if(delimiter!=='^' && delimiter!=='_')return false;
 const start=state.pos+1;if(/\s/.test(state.src[start] ?? ' '))return false;
 let end=start;for(;end<state.posMax;end++){if(state.src[end]==='\\'){end++;continue;}if(state.src[end]===delimiter)break;}
 if(end===start || end>=state.posMax || /\s/.test(state.src[end-1]!))return false;
 if(!silent){const type=delimiter==='^'?'sup':'sub';state.push(type+'_open',type,1);environment[scriptDepth]=depth+1;try{const children=state.md.parseInline(state.src.slice(start,end),state.env)[0]?.children ?? [];for(const child of children){const token=state.push(child.type,child.tag,child.nesting);token.content=child.content;token.attrs=child.attrs;token.meta=child.meta;token.markup=child.markup;token.children=child.children;}}finally{environment[scriptDepth]=depth;}state.push(type+'_close',type,-1);}
 state.pos=end+1;return true;
});
// Pipe tables and controlled table tags are protected objects, including multiline cell text.
tokenizer.block.ruler.before('paragraph','kkb_table',(state,startLine,_endLine,silent)=>{
 const from=state.bMarks[startLine]!+state.tShift[startLine]!,remaining=state.src.slice(from),table=parseTables(remaining)[0];
 if(table?.start!==0)return false;if(silent)return true;
 const raw=remaining.slice(0,table.end),following=remaining.slice(table.end).split('\n',1)[0];if(following?.trim())return false;
 const lastLine=startLine+raw.split('\n').length;
 const open=state.push('paragraph_open','p',1);open.map=[startLine,lastLine];
 const object=state.push('body_object','',0);object.meta={raw,kind:'table',name:table.name};
 state.push('paragraph_close','p',-1);state.line=lastLine;return true;
});
tokenizer.core.ruler.after('inline','kkb_tasks',state=>{
 for(let i=0;i<state.tokens.length;i++){
  const item=state.tokens[i]!;if(item.type!=='list_item_open')continue;
  const inline=state.tokens[i+2];if(inline?.type!=='inline')continue;
  const match=/^\[([ xX])\]\s+/.exec(inline.content);if(!match)continue;
  item.attrSet('checked',match[1]!.toLowerCase()==='x'?'true':'false');inline.content=inline.content.slice(match[0].length);
  if(inline.children?.[0]?.type==='text')inline.children[0].content=inline.children[0].content.slice(match[0].length);
 }
});
const parser=new MarkdownParser(richBodySchema,tokenizer,{
 ...defaultMarkdownParser.tokens,
 list_item:{block:'list_item',getAttrs:token=>({checked:token.attrGet('checked')===null?null:token.attrGet('checked')==='true'})},
 softbreak:{node:'hard_break'},body_object:{node:'body_object',getAttrs:token=>token.meta as Record<string,unknown>},
 s:{mark:'strike'},sup:{mark:'sup'},sub:{mark:'sub'}
});

/** Fingerprints deliberately omit all source bookkeeping, including nested snapshots. */
const fingerprintCache=new WeakMap<RichNode,string>();
function fingerprint(node:RichNode):string{
 const cached=fingerprintCache.get(node);if(cached!==undefined)return cached;
 const clean=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(clean);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!key.startsWith('source')).map(([key,v])=>[key,clean(v)]));
  return value;
 };
 const result=JSON.stringify(clean(node.toJSON()));fingerprintCache.set(node,result);return result;
}
const lineStarts=(source:string)=>{const starts=[0];for(let i=0;i<source.length;i++)if(source[i]==='\n')starts.push(i+1);return starts;};
export function parseRichBody(source:string):RichNode{
 const doc=parser.parse(source),tokens=tokenizer.parse(source,{}),starts=lineStarts(source);
 const ranges=tokens.filter(token=>token.level===0 && token.nesting!==-1 && token.map).map(token=>({start:starts[token.map![0]] ?? source.length,end:starts[token.map![1]] ?? source.length}));
 const children:RichNode[]=[];let previous=0;
 doc.forEach((node,_offset,index)=>{
  const range=ranges[index] ?? {start:previous,end:source.length};
  children.push(node.type.create({...node.attrs,sourceRaw:source.slice(range.start,range.end),sourceGap:source.slice(previous,range.start),sourceFingerprint:fingerprint(node),sourceIdentity:index},node.content,node.marks));previous=range.end;
 });
 const result=doc.type.create({...doc.attrs,sourceRaw:source,sourceSuffix:source.slice(previous)},Fragment.from(children));
 return result.type.create({...result.attrs,sourceFingerprint:fingerprint(result)},result.content);
}
export const richBodySerializer=new MarkdownSerializer({
 ...defaultMarkdownSerializer.nodes,
 body_object(state,node){state.write(node.attrs.raw);},
 list_item(state,node){if(node.attrs.checked!==null)state.write(node.attrs.checked?'[x] ':'[ ] ');state.renderContent(node);},
 hard_break(state){state.write('\n');}
},{
 ...defaultMarkdownSerializer.marks,
 strike:{open:'~~',close:'~~',mixable:true,expelEnclosingWhitespace:true},
 sup:{open:'^',close:'^',mixable:true,expelEnclosingWhitespace:true},
 sub:{open:'_',close:'_',mixable:true,expelEnclosingWhitespace:true}
});
type SourceBlock={node:RichNode;position:number;start:number;end:number;raw:string};
const serializedCache=new WeakMap<RichNode,{source:string;blocks:SourceBlock[]}>();
function serializedBlocks(doc:RichNode):{source:string;blocks:SourceBlock[]}{
 const cached=serializedCache.get(doc);if(cached)return cached;
 let source='';const blocks:SourceBlock[]=[],seen=new Set<unknown>();
 doc.forEach((node,position)=>{
  const identity=node.attrs.sourceIdentity,known=identity!==null && !seen.has(identity);if(known)seen.add(identity);
  let raw=node.attrs.sourceFingerprint===fingerprint(node)?String(node.attrs.sourceRaw ?? ''):richBodySerializer.serialize(richBodySchema.topNodeType.create(null,[node]));
  if(node.attrs.sourceFingerprint!==fingerprint(node) && /\r?\n$/.test(node.attrs.sourceRaw ?? '') && !raw.endsWith('\n'))raw+=(node.attrs.sourceRaw as string).endsWith('\r\n')?'\r\n':'\n';
  const gap=known?String(node.attrs.sourceGap ?? ''):source && !source.endsWith('\n\n')?(source.endsWith('\n')?'\n':'\n\n'):'';
  source+=gap;const start=source.length;source+=raw;blocks.push({node,position,start,end:source.length,raw});
 });
 source+=String(doc.attrs.sourceSuffix ?? '');const result={source,blocks};serializedCache.set(doc,result);return result;
}
export function serializeRichBody(doc:RichNode):string{
 return doc.attrs.sourceFingerprint===fingerprint(doc)?String(doc.attrs.sourceRaw ?? ''):serializedBlocks(doc).source;
}

type VisibleUnit={text:string;start:number;end:number;atom?:boolean};
/** Lexical source map uses this application's existing dialect, never rendered HTML. */
function visibleSource(raw:string):VisibleUnit[]{
 const objects=[...imageMarkdownTokens(raw).map(token=>({...token,kind:'image'})),...parseTables(raw).map(token=>({...token,kind:'table'}))].filter((token,index,all)=>!all.some((parent,j)=>j!==index && parent.start<token.start && parent.end>=token.end)).sort((a,b)=>a.start-b.start);
 const result:VisibleUnit[]=[];let fence:string|null=null,lineStart=0,objectIndex=0;
 for(const line of raw.split('\n')){
  const lineEnd=lineStart+line.length;
  if(fence){if(new RegExp('^ {0,3}'+fence[0]+'{'+fence.length+',}\\s*$').test(line))fence=null;else for(let i=0;i<line.length;i++)result.push({text:line[i]!,start:lineStart+i,end:lineStart+i+1});lineStart=lineEnd+1;continue;}
  const delimiter=/^ {0,3}(`{3,}|~{3,})/.exec(line);if(delimiter){fence=delimiter[1]!;lineStart=lineEnd+1;continue;}
  let prefix=/^(?: {0,3}>\s?)*(?: {0,3}(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+))?(?:\[[ xX]\]\s+)?/.exec(line)?.[0].length ?? 0;
  if(/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)){lineStart=lineEnd+1;continue;}
  let cursor=lineStart+prefix;
  while(cursor<lineEnd){
   while(objectIndex<objects.length && objects[objectIndex]!.end<=cursor)objectIndex++;
   const object=objects[objectIndex];if(object && object.start<=cursor && object.end>cursor){if(object.start===cursor)result.push({text:'\ufffc',start:object.start,end:object.end,atom:true});cursor=object.end;continue;}
   const stop=Math.min(lineEnd,object?.start ?? lineEnd),part=raw.slice(cursor,stop);
   // Unknown HTML remains a protected literal atom too.
   const html=/<\/?[a-zA-Z][\w:-]*(?:\s+[^<>]*?)?\s*\/?>/.exec(part);
   const end=html?cursor+html.index:stop;
   for(const token of inlineText(raw.slice(cursor,end),cursor)){
    for(let i=0;i<token.text.length;i++)result.push({text:token.text[i]!,start:token.start+i,end:Math.min(token.end,token.start+i+1)});
   }
   cursor=end;if(html){result.push({text:'\ufffc',start:cursor,end:cursor+html[0].length,atom:true});cursor+=html[0].length;}
  }
  if(lineEnd<raw.length && !objects.some(object=>object.start<=lineEnd && object.end>lineEnd))result.push({text:'\n',start:lineEnd,end:lineEnd+1});lineStart=lineEnd+1;
 }
 return result;
}
type PositionUnit={position:number;start:number;end:number;atom:boolean};
const positionCache=new WeakMap<RichNode,PositionUnit[]>();
function positionUnits(doc:RichNode):PositionUnit[]{
 const cached=positionCache.get(doc);if(cached)return cached;
 const result:PositionUnit[]=[];
 for(const block of serializedBlocks(doc).blocks){
  const visible=visibleSource(block.raw);let cursor=0;
  block.node.descendants((node,position)=>{
   if(!node.isText && !node.isLeaf)return;
   const text=node.isText?node.text!:node.type.name==='hard_break'?'\n':node.type.name==='body_object'?'\ufffc':'';
   for(let i=0;i<text.length;i++){
    let match=cursor;while(match<visible.length && visible[match]!.text!==text[i])match++;if(match>=visible.length)continue;cursor=match+1;const unit=visible[match]!;
    result.push({position:block.position+position+1+i,start:block.start+unit.start,end:block.start+unit.end,atom:Boolean(unit.atom)});
   }
  });
 }
 positionCache.set(doc,result);return result;
}
export function sourceToVisualPosition(doc:RichNode,offset:number,bias=-1):number{
 const units=positionUnits(doc);if(!units.length)return Math.min(1,doc.content.size);
 let previous=units[0]!;for(const unit of units){
  if(offset<unit.start)return bias>0?unit.position:previous.position+(offset>previous.start?1:0);
  if(offset===unit.start)return unit.position;
  if(offset<unit.end)return unit.position+(bias>0?1:0);
  if(offset===unit.end)return unit.position+1;previous=unit;
 }
 return Math.min(doc.content.size,previous.position+1);
}
export function visualPositionToSource(doc:RichNode,position:number,bias=1):number{
 const units=positionUnits(doc);if(!units.length)return 0;
 let previous:PositionUnit|undefined;for(const unit of units){
  if(position===unit.position)return bias<0 && previous?previous.end:unit.start;
  if(position<unit.position)return bias>0?unit.start:previous?.end ?? unit.start;previous=unit;
 }
 return previous?.end ?? 0;
}
