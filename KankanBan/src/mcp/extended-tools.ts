import {uiText} from '../i18n/text.ts';
import {emptyInk,PENCIL_COLOR,PENCIL_WIDTH,type InkStroke} from '../core/drawing.ts';
import {readCard} from '../core/workspace.ts';
import {executeAction} from '../core/actions.ts';
import {locateEntry} from '../core/indexes.ts';
import type {ToolDef} from './tools.ts';
const card={type:'string'},point={type:'object',properties:{x:{type:'number'},y:{type:'number'}},required:['x','y']};
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object' as const,properties,required,additionalProperties:false});
const desktop=(name:string,title:string,description:string,properties:Record<string,unknown>,required:string[]=[]):ToolDef=>({name,title,description,inputSchema:schema(properties,required),execution:'desktop',handler:()=>{throw new Error(uiText('mcp/extended.desktopOnly'));}});
export const EXTENDED_TOOLS:readonly ToolDef[]=[
 desktop('identify_actor',uiText('collaboration.identify'),uiText('collaboration.identifyHelp'),{id:{type:'string'},name:{type:'string'}},['id','name']),
 desktop('read_operations',uiText('collaboration.read'),uiText('collaboration.readHelp'),{cursor:{type:'string'},all:{type:'boolean'},details:{type:'boolean'}}),
 desktop('ack_operations',uiText('collaboration.ack'),uiText('collaboration.ackHelp'),{}),
 {name:'get_doodle',title:uiText('mcp/extended.getDoodle'),description:uiText('mcp/extended.getDoodleHelp'),inputSchema:schema({cardId:card},['cardId']),handler:(s,a)=>({cardId:a.cardId,document:readCard(s,a.cardId as string).doodle ?? null})},
 {name:'add_doodle_strokes',title:uiText('mcp/extended.addDoodle'),description:uiText('mcp/extended.addDoodleHelp'),inputSchema:schema({cardId:card,width:{type:'number'},height:{type:'number'},strokes:{type:'array',items:{type:'object',properties:{points:{type:'array',items:point}},required:['points'],additionalProperties:false}}},['cardId','strokes']),handler:(s,a)=>{
  const id=a.cardId as string,before=readCard(s,id).doodle ?? null,base=before ?? emptyInk(s.newId(),a.width as number|undefined,a.height as number|undefined);
  const strokes=(a.strokes as {points:{x:number;y:number}[]}[]).map(stroke=>({points:stroke.points,id:s.newId(),width:PENCIL_WIDTH,color:PENCIL_COLOR} as InkStroke));
  const document={...base,width:a.width as number ?? base.width,height:a.height as number ?? base.height,strokes:[...base.strokes,...strokes]};
  executeAction(s,{kind:'doodle-update',id,document,...(before?{before}:{})});return {cardId:id,strokeIds:strokes.map(stroke=>stroke.id),document:readCard(s,id).doodle};
 }},
 {name:'remove_doodle_strokes',title:uiText('mcp/extended.removeDoodle'),description:uiText('mcp/extended.removeDoodleHelp'),inputSchema:schema({cardId:card,strokeIds:{type:'array',items:{type:'string'}}},['cardId','strokeIds']),handler:(s,a)=>{
  const id=a.cardId as string,before=readCard(s,id).doodle;if(!before)return {removed:0};const remove=new Set(a.strokeIds as string[]),strokes=before.strokes.filter(stroke=>!remove.has(stroke.id));const {groups:_,...base}=before;executeAction(s,{kind:'doodle-update',id,document:{...base,strokes},before});return {removed:before.strokes.length-strokes.length};
 }},
 {name:'clear_doodle',title:uiText('mcp/extended.clearDoodle'),description:uiText('mcp/extended.clearDoodleHelp'),inputSchema:schema({cardId:card},['cardId']),handler:(s,a)=>{const id=a.cardId as string,before=readCard(s,id).doodle;if(!before)return {removed:0};const {groups:_,...base}=before;executeAction(s,{kind:'doodle-update',id,document:{...base,strokes:[]},before});return {removed:before.strokes.length};}},
 {name:'get_card_location',title:uiText('mcp/extended.getLocation'),description:uiText('mcp/extended.getLocationHelp'),inputSchema:schema({cardId:card},['cardId']),handler:(s,a)=>{const id=a.cardId as string;readCard(s,id);const at=locateEntry(s.state,id),ancestors:string[]=[];let cursor=at?.parentId;while(cursor){ancestors.unshift(cursor);cursor=locateEntry(s.state,cursor)?.parentId;}return {cardId:id,parentId:at?.parentId ?? null,index:at?.index ?? null,entry:at?.entry ?? null,ancestors};}},
 {name:'reorder_card',title:uiText('mcp/extended.reorder'),description:uiText('mcp/extended.reorderHelp'),inputSchema:schema({cardId:card,index:{type:'integer',minimum:0}},['cardId','index']),handler:(s,a)=>{const id=a.cardId as string;readCard(s,id);const at=locateEntry(s.state,id);if(!at)throw new Error(uiText('mcp/extended.rootOrder'));executeAction(s,{kind:'move',id,parent:at.parentId,index:a.index as number,...('x' in at.entry?{plane:at.entry}:{})});return {cardId:id,parentId:at.parentId,index:locateEntry(s.state,id)?.index};}},
 {name:'move_card_in_canvas',title:uiText('mcp/extended.canvasMove'),description:uiText('mcp/extended.canvasMoveHelp'),inputSchema:schema({cardId:card,parentId:card,x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'}},['cardId','parentId','x','y']),handler:(s,a)=>executeAction(s,{kind:'canvas-drop',id:a.cardId as string,parent:a.parentId as string,x:a.x as number,y:a.y as number,...(a.width===undefined?{}:{w:a.width as number}),...(a.height===undefined?{}:{h:a.height as number})})},
 {name:'sync_prefab',title:uiText('mcp/extended.sync'),description:uiText('mcp/extended.syncHelp'),inputSchema:schema({cardId:card,target:{type:'string',enum:['prefab','all']}},['cardId','target']),handler:(s,a)=>executeAction(s,{kind:'prefab-sync',id:a.cardId as string,target:a.target as 'prefab'|'all'})},
 desktop('get_workspace',uiText('mcp/extended.workspace'),uiText('mcp/extended.workspaceHelp'),{}),
 desktop('switch_workspace',uiText('mcp/extended.switch'),uiText('mcp/extended.switchHelp'),{path:{type:['string','null']}},['path']),
 desktop('list_windows',uiText('mcp/extended.windows'),uiText('mcp/extended.windowsHelp'),{}),
 desktop('open_card_window',uiText('mcp/extended.open'),uiText('mcp/extended.openHelp'),{cardId:card},['cardId']),
 desktop('close_card_window',uiText('mcp/extended.close'),uiText('mcp/extended.closeHelp'),{cardId:card},['cardId']),
 desktop('capture_window',uiText('mcp/extended.capture'),uiText('mcp/extended.captureHelp'),{windowLabel:{type:'string'}}),
 desktop('inspect_window',uiText('mcp/extended.inspect'),uiText('mcp/extended.inspectHelp'),{windowLabel:{type:'string'}}),
];
