import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundedImage} from '../src/webview/image-bounds.ts';
test('an oversized picture is fitted before clamping and a scrolled origin remains inside its viewport',()=>{
 const bounds={left:20,top:180,right:220,bottom:300},value=boundedImage(bounds,{width:400,height:200},{x:999,y:-100});assert.deepEqual(value,{width:200,height:100,x:20,y:180});
 const other=boundedImage(bounds,{width:80,height:40},{x:999,y:999});assert.deepEqual(other,{width:80,height:40,x:140,y:260});
});
