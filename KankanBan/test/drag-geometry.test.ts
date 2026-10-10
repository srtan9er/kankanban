import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insideMergeArea, dropPosition } from '../src/webview/drag-geometry.ts';
test('window edges stay available for snapping while the interior accepts a merge',()=>{
 const rect={left:0,top:0,right:300,bottom:400};
 for(const [x,y] of [[2,200],[298,200],[150,2],[150,398]]) assert.equal(insideMergeArea(rect,x!,y!),false);
 assert.equal(insideMergeArea(rect,150,200),true);
 assert.equal(insideMergeArea(rect,-1,200),false);
});


test('drop coordinates agree on translated canvas surfaces and exposed viewport space',()=>{
 const element=(left:number,top:number,dataset:Record<string,string>={})=>({getBoundingClientRect:()=>({left,top}),scrollLeft:0,scrollTop:0,dataset}) as unknown as HTMLElement;
 assert.deepEqual(dropPosition(element(10,20,{canvasPanX:'-100',canvasPanY:'60'}),200,150),{x:290,y:70});
 assert.deepEqual(dropPosition(element(-90,80),200,150),{x:290,y:70});
 assert.deepEqual(dropPosition(element(10,20,{canvasPanX:'100',canvasPanY:'100'}),20,30),{x:0,y:0});
});
