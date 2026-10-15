import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitForMirrorSnapshot} from '../src/webview/mirror-startup.ts';
test('mirror receives boot broadcast even when its early request was lost before the writer listener existed',async()=>{
 let resolve!:()=>void,reject!:()=>void;const broadcast=new Promise<void>(done=>resolve=done),request=new Promise<void>((_,fail)=>reject=()=>fail(new Error('writer did not receive early request')));
 let ready=false;const opening=waitForMirrorSnapshot(()=>request,broadcast).then(()=>ready=true).catch(()=>undefined);
 resolve();await new Promise(done=>setTimeout(done,0));const observed=ready;reject();await opening;
 assert.equal(observed,true,'authoritative boot snapshot should unblock mirror rendering without an RPC reply');
});
test('an ordinary snapshot reply still starts the mirror',async()=>{await waitForMirrorSnapshot(()=>Promise.resolve({}),new Promise(()=>{}));});
test('when no authoritative state arrives the startup error remains visible',async()=>{await assert.rejects(waitForMirrorSnapshot(()=>Promise.reject(new Error('offline')),new Promise(()=>{})),/offline/);});
