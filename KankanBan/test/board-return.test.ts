import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {openSession,createCard} from '../src/core/workspace.ts';
import {executeAction} from '../src/core/actions.ts';
import {navigationTarget} from '../src/webview/navigation.ts';
test('returning to the parent column from a board event opens the board',()=>{
 const s=openSession('/nav',{ops:createMemoryFs().ops}),board=executeAction(s,{kind:'create',parent:null,title:'Board',layout:'columns'}).createdId!,column=s.state.children.get(board)![0]!.id,event=createCard(s,{parentId:column,title:'Event'});
 assert.equal(navigationTarget(s.state,event,column),board);assert.equal(navigationTarget(s.state,event,board),board);
 const nested=createCard(s,{parentId:event,title:'Nested'});assert.equal(navigationTarget(s.state,nested,event),event);
 assert.equal(navigationTarget(s.state,column,event),event);
});
test('normal parent navigation is retained outside a board',()=>{
 const s=openSession('/nav',{ops:createMemoryFs().ops}),root=createCard(s,{parentId:null,title:'Root'}),parent=createCard(s,{parentId:root,title:'Parent'}),child=createCard(s,{parentId:parent,title:'Child'});
 assert.equal(navigationTarget(s.state,child,parent),parent);assert.equal(navigationTarget(s.state,child,root),root);
});
test('board columns cannot be entered from any location regardless of their names',()=>{
 const s=openSession('/nav-anywhere',{ops:createMemoryFs().ops}),board=executeAction(s,{kind:'create',parent:null,title:'Board',layout:'columns'}).createdId!,columns=s.state.children.get(board)!,event=createCard(s,{parentId:columns[0]!.id,title:'Event'}),nested=createCard(s,{parentId:event,title:'Nested'}),outside=createCard(s,{parentId:null,title:'Outside'});
 for(const column of columns)for(const current of ['manager',outside,board,column.id,event,nested])assert.equal(navigationTarget(s.state,current,column.id),board);
 const ordinary=createCard(s,{parentId:outside,title:'todo'});assert.equal(navigationTarget(s.state,'manager',ordinary),ordinary);
});
