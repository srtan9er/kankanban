import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareWithSegments} from '@chenglou/pretext';
import {previewLayout} from '../src/webview/preview-layout.ts';
// Deterministic glyph metrics test wrapping geometry, not platform font rendering.
Object.assign(globalThis,{OffscreenCanvas:class{getContext(){return {font:'',measureText:(text:string)=>({width:[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(text)].length*10})};}}});
test('last two preview rows wrap before the delete area without dropping short text',()=>{
 const text='甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳',p=prepareWithSegments(text,'12px Test');
 const result=previewLayout(p,100,4,30);assert.equal(result.overflow,false);assert.equal(result.lines.map(l=>l.text).join(''),text);
 for(const line of result.lines.slice(-2)){assert.equal(line.slotWidth,70);assert.ok(line.measuredWidth<=70);}
});
test('long previews use full early rows and shortened last two rows',()=>{
 const p=prepareWithSegments('甲'.repeat(80),'12px Test'),result=previewLayout(p,100,4,30);
 assert.equal(result.overflow,true);assert.deepEqual(result.lines.map(l=>l.slotWidth),[100,100,70,70]);
});
test('Chinese and emoji wrap using grapheme boundaries',()=>{
 const text='你好🙂世界🙂再见',p=prepareWithSegments(text,'12px Test');const result=previewLayout(p,60,6,20);
 assert.equal(result.overflow,false);assert.equal(result.lines.map(l=>l.text).join(''),text);assert.ok(result.lines.every(l=>l.measuredWidth<=l.slotWidth));
});
test('overlong Latin words and joined emoji retain their characters when there is enough height',()=>{
 for(const text of ['abcdefghijklmnopqrstuvwxyz','你好👨‍👩‍👧‍👦世界🇨🇳再见']){
  const p=prepareWithSegments(text,'12px Test'),result=previewLayout(p,100,6,30);
  assert.equal(result.overflow,false);assert.equal(result.lines.map(l=>l.text).join(''),text);assert.ok(result.lines.every(l=>l.measuredWidth<=l.slotWidth));
 }
});
test('explicit line breaks are kept in full previews',()=>{
 const result=previewLayout(prepareWithSegments('第一行\n第二行\n第三行','12px Test',{whiteSpace:'pre-wrap'}),100,6,30);
 assert.equal(result.overflow,false);assert.ok(result.lines.some(l=>l.text.includes('第二行')));assert.equal(result.lines.map(l=>l.text).join('').replace(/\n/g,''),'第一行第二行第三行');
});
