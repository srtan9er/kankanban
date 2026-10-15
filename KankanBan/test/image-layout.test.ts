import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareRichInline} from '@chenglou/pretext/rich-inline';
import {flowImageText,imageTextSlots} from '../src/webview/image-layout.ts';
Object.assign(globalThis,{OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(text)].length*10})};}}});
test('free images split every intersected row into unoccupied text slots',()=>{
 const rects=[{x:40,y:20,width:60,height:40},{x:160,y:0,width:40,height:100}];
 assert.deepEqual(imageTextSlots(240,30,20,rects,0),[{x:0,width:40},{x:100,width:60},{x:200,width:40}]);
 assert.deepEqual(imageTextSlots(240,120,20,rects,0),[{x:0,width:240}]);
});
test('free wrapping keeps all Chinese, emoji and rich-text fragments outside every image',()=>{
 const text='甲乙丙丁戊己庚辛壬癸你好🙂世界🙂再见'.repeat(8),rects=[{x:50,y:0,width:80,height:70},{x:170,y:40,width:50,height:70}];
 const p=prepareRichInline([{text,font:'13px Test'}]),result=flowImageText(p,240,0,20,rects,[]);
 assert.equal(result.lines.flatMap(line=>line.fragments.map(fragment=>fragment.text)).join(''),text);
 for(const line of result.lines)for(const rect of rects)assert.ok(line.y+line.height<=rect.y || line.y>=rect.y+rect.height || line.x+line.width<=rect.x || line.x>=rect.x+rect.width);
 assert.ok(result.height>110);
});
test('a full-width image advances the text below it without losing characters',()=>{
 const p=prepareRichInline([{text:'All text survives',font:'13px Test'}]);
 const result=flowImageText(p,100,0,20,[{x:0,y:0,width:100,height:80}],[]);
 assert.ok(result.lines.length>0);assert.ok(result.lines.every(line=>line.y>=88));
 assert.equal(result.lines.flatMap(line=>line.fragments.map(f=>f.text)).join('').replace(/\s/g,''),'Alltextsurvives');
});
