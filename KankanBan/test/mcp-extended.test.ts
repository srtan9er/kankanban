import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {callTool,TOOLS} from '../src/mcp/tools.ts';
import {createServer} from '../src/mcp/server.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const fixture=()=>openSession('/extended',{ops:createMemoryFs().ops});
test('MCP pencil cannot use styles unavailable in the UI or bypass via set_field',()=>{
 const s=fixture(),id=createCard(s,{parentId:null,title:'Ink'});
 for(const style of [{color:'accent'},{width:2}])assert.throws(()=>callTool(s,'add_doodle_strokes',{cardId:id,strokes:[{points:[{x:1,y:2}],...style}]}));
 callTool(s,'add_doodle_strokes',{cardId:id,strokes:[{points:[{x:1,y:2}]}]});
 const document=s.state.cards.get(id)!.doodle!;
 assert.equal(document.strokes[0]!.color,'text');assert.equal(document.strokes[0]!.width,3);
 assert.throws(()=>callTool(s,'set_field',{cardId:id,path:'/doodle',value:document}));
 assert.throws(()=>callTool(s,'set_field',{cardId:id,path:'/doodle/strokes/0/color',value:'accent'}));
});
test('extended catalogue exposes 31 distinct tools',()=>{assert.equal(TOOLS.length,31);assert.equal(new Set(TOOLS.map(tool=>tool.name)).size,31);});
test('doodle tools append, erase by ID, clear and undo without replacing text',()=>{
 const s=fixture(),id=createCard(s,{parentId:null,title:'Ink',content:'Keep this'});
 const draw=(x:number)=>callTool(s,'add_doodle_strokes',{cardId:id,strokes:[{points:[{x,y:1},{x:x+10,y:5}]}]}) as {strokeIds:string[]};
 const first=draw(1),second=draw(20);assert.notEqual(first.strokeIds[0],second.strokeIds[0]);assert.equal(s.state.cards.get(id)?.doodle?.strokes.length,2);
 callTool(s,'remove_doodle_strokes',{cardId:id,strokeIds:first.strokeIds});assert.deepEqual(s.state.cards.get(id)?.doodle?.strokes.map(stroke=>stroke.id),second.strokeIds);
 callTool(s,'clear_doodle',{cardId:id});assert.equal(s.state.cards.get(id)?.doodle?.strokes.length,0);callTool(s,'undo',{});assert.equal(s.state.cards.get(id)?.doodle?.strokes.length,1);assert.equal(s.state.cards.get(id)?.content,'Keep this');
});
test('invalid stroke coordinates and widths do not mutate doodles',()=>{const s=fixture(),id=createCard(s,{parentId:null,title:'Ink'});assert.throws(()=>callTool(s,'add_doodle_strokes',{cardId:id,strokes:[{points:[{x:1,y:2}],width:30}]}));assert.equal(s.state.cards.get(id)?.doodle,null);assert.throws(()=>callTool(s,'add_doodle_strokes',{cardId:id,strokes:[{points:[{x:Infinity,y:2}]}]}));});
test('tree position tools preserve identity and final indexes',()=>{const s=fixture(),p=createCard(s,{parentId:null,title:'P',layout:'ordered'}),a=createCard(s,{parentId:p,title:'A'}),b=createCard(s,{parentId:p,title:'B'});const at=callTool(s,'get_card_location',{cardId:a}) as {parentId:string;index:number;ancestors:string[]};assert.deepEqual(at.ancestors,[p]);assert.equal(at.index,0);callTool(s,'reorder_card',{cardId:a,index:1});assert.deepEqual(s.state.children.get(p)?.map(entry=>entry.id),[b,a]);assert.throws(()=>callTool(s,'reorder_card',{cardId:p,index:0}));});
test('desktop-only tools fail explicitly without a desktop dispatcher',()=>{for(const name of ['get_workspace','capture_window','inspect_window','switch_workspace'])assert.throws(()=>callTool(fixture(),name,name==='switch_workspace'?{path:null}:{}),/桌面/);});
test('screenshot is returned as MCP image content rather than a base64 JSON string',async()=>{
 const png=readFileSync(new URL('../src-tauri/icons/32x32.png',import.meta.url)).toString('base64');const server=createServer(async()=>({windowLabel:'main',mimeType:'image/png',data:png,width:32,height:32}));const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);const client=new Client({name:'images',version:'1'});await client.connect(a);
 try{const reply=await client.callTool({name:'capture_window',arguments:{}});assert.equal((reply.content as {type:string}[])[0]?.type,'image');const metadata=(reply.content as {type:string;text?:string}[]).find(block=>block.type==='text');assert.ok(!metadata?.text?.includes(png));}finally{await client.close();await server.close();}
});
