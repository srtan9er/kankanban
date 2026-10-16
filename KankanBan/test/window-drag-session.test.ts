import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWindowDragSession} from '../src/webview/window-drag-session.ts';
type Call={command:string;args:Record<string,unknown>};
function fixture(block?:{command:string;gate:Promise<void>}){
 const calls:Call[]=[];const drag=createWindowDragSession(async(command,args)=>{calls.push({command,args});if(command===block?.command)await block.gate;return {bottom:true};},true);return {calls,drag};
}
test('a chain drag starts lazily once and finishes at the latest absolute point',async()=>{
 const {calls,drag}=fixture();assert.deepEqual(calls,[]);await drag.move({x:10,y:20});await drag.move({x:30,y:40});await drag.move({x:50,y:60},true);await drag.cancel();
 assert.deepEqual(calls,[{command:'begin_window_drag',args:{fixed:true}},{command:'move_note',args:{x:10,y:20,finish:false}},{command:'move_note',args:{x:30,y:40,finish:false}},{command:'move_note',args:{x:50,y:60,finish:true}}]);
});
test('cancelling an unstarted gesture does not split or persist a chain',async()=>{const {calls,drag}=fixture();await drag.cancel();await drag.move({x:1,y:2});assert.deepEqual(calls,[]);});

test('explicit begin is idempotent and shares the native transaction with queued moves',async()=>{
 const {calls,drag}=fixture();await Promise.all([drag.begin(),drag.begin(),drag.move({x:10,y:20})]);await drag.move({x:30,y:40},true);await drag.begin();
 assert.deepEqual(calls,[{command:'begin_window_drag',args:{fixed:true}},{command:'move_note',args:{x:10,y:20,finish:false}},{command:'move_note',args:{x:30,y:40,finish:true}}]);
});

test('cancel during explicit begin waits for the start and rejects queued obsolete movement',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),{calls,drag}=fixture({command:'begin_window_drag',gate});const begun=drag.begin();await Promise.resolve();const moving=drag.move({x:10,y:20}),cancelled=drag.cancel();release();await Promise.all([begun,moving,cancelled]);
 assert.deepEqual(calls,[{command:'begin_window_drag',args:{fixed:true}},{command:'cancel_window_drag',args:{}}]);
});
test('cancel waits for an in-flight native start and prevents the obsolete movement',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),{calls,drag}=fixture({command:'begin_window_drag',gate});const moving=drag.move({x:10,y:20});await Promise.resolve();const cancelled=drag.cancel();release();await Promise.all([moving,cancelled]);await drag.cancel();
 assert.deepEqual(calls,[{command:'begin_window_drag',args:{fixed:true}},{command:'cancel_window_drag',args:{}}]);
});
test('native moves and cancellation are serialized and a cancelled session never moves again',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),{calls,drag}=fixture({command:'move_note',gate});const moving=drag.move({x:10,y:20});for(let i=0;i<6;i++)await Promise.resolve();const cancelled=drag.cancel();release();await Promise.all([moving,cancelled]);await drag.move({x:50,y:60},true);
 assert.deepEqual(calls.map(call=>call.command),['begin_window_drag','move_note','cancel_window_drag']);
});
test('a failed move still allows native cancellation to restore the original chain',async()=>{
 const calls:string[]=[];const drag=createWindowDragSession(async command=>{calls.push(command);if(command==='move_note')throw new Error('native move failed');return {};},false);
 await assert.rejects(drag.move({x:1,y:2}),/native move failed/);await drag.cancel();assert.deepEqual(calls,['begin_window_drag','move_note','cancel_window_drag']);
});
