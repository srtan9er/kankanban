import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ImageToolbar} from '../src/webview/ImageToolbar.tsx';
test('scrollports reserve separate space for the window grip and collapsed child rails',()=>{
 const css=readFileSync(new URL('../src/webview/workspace.css',import.meta.url),'utf8');
 assert.match(css,/#root \.proto-note \.card-regions\s*\{[^}]*margin-bottom:18px/);
 assert.match(css,/horizontal-regions:has\(> \.child-region-collapsed\) > \.card-body-region\s*\{[^}]*margin-bottom:12px/);
 assert.match(css,/vertical-regions:has\(> \.child-region-collapsed\) > \.card-body-region\s*\{[^}]*margin-right:12px/);
});
test('only the current cell editor can scroll with a visible scrollbar, and minus stays left of trash',()=>{
 const css=readFileSync(new URL('../src/webview/table-object.css',import.meta.url),'utf8');
 const dom=new JSDOM(`<style>${css}</style><div id="root"><div class="table-cell-content"></div><textarea class="table-cell-editor"></textarea><div class="image-edit-controls"><button class="table-collapse"><svg></svg></button></div></div>`);
 try{const content=dom.window.getComputedStyle(dom.window.document.querySelector('.table-cell-content')!);const editor=dom.window.getComputedStyle(dom.window.document.querySelector('.table-cell-editor')!);assert.equal(content.overflow,'clip');assert.equal(editor.overflow,'auto');assert.equal(editor.getPropertyValue('scrollbar-width'),'auto');
  const style=dom.window.getComputedStyle(dom.window.document.querySelector('.table-collapse')!);assert.equal(style.right,'31px');assert.equal(style.top,'3px');assert.equal(style.display,'grid');
 }finally{dom.window.close();}
});
test('empty floating tool docks are hidden, populated ones still show',()=>{
 const css=readFileSync(new URL('../src/webview/table-object.css',import.meta.url),'utf8');
 const dom=new JSDOM(`<style>${css}</style><div class="table-floating-dock" data-floating-object-tools></div><div class="table-floating-dock" data-floating-object-tools><button></button></div>`);
 try{const docks=dom.window.document.querySelectorAll('.table-floating-dock');assert.equal(dom.window.getComputedStyle(docks[0]!).display,'none');assert.equal(dom.window.getComputedStyle(docks[1]!).display,'flex');}finally{dom.window.close();}
});
test('global manager button styles cannot push image-control icons off center',()=>{
 const imageCss=readFileSync(new URL('../src/webview/image-layout.css',import.meta.url),'utf8');
 const managerCss=readFileSync(new URL('../src/webview/prototype.css',import.meta.url),'utf8').match(/\.proto-manager button\s*\{[^}]*\}/)![0];
 const toolbar=renderToStaticMarkup(createElement(ImageToolbar,{layout:'inline',busy:false,choose:()=>{}}));
 const dom=new JSDOM(`<style>${imageCss}</style><style>${managerCss}</style><div id="root"><main class="proto-manager"><div class="image-placement"><button class="image-remove"><svg viewBox="0 0 24 24"></svg></button>${toolbar}</div></main></div>`);
 try{
  for(const button of dom.window.document.querySelectorAll('button')){
   const style=dom.window.getComputedStyle(button);
   assert.equal(style.padding,'0px');assert.equal(style.borderTopWidth,'0px');assert.equal(style.width,'24px');assert.equal(style.height,'24px');assert.equal(style.display,'grid');assert.equal(style.placeItems,'center');
   assert.equal(dom.window.getComputedStyle(button.querySelector('svg')!).display,'block');
  }
  const bar=dom.window.getComputedStyle(dom.window.document.querySelector('.image-layout-toolbar')!);
  assert.equal(bar.position,'absolute');assert.equal(bar.right,'24px');assert.equal(bar.bottom,'3px');
 }finally{dom.window.close();}
});
test('image resize cursors use more specific important rules for attached and detached controls',()=>{
 const imageCss=readFileSync(new URL('../src/webview/image-layout.css',import.meta.url),'utf8');
 const defaults=readFileSync(new URL('../src/webview/workspace.css',import.meta.url),'utf8').match(/html, body, #root, #root \* \{[^}]*\}/)![0];
 const dom=new JSDOM(`<style>${imageCss}</style><style>${defaults}</style><div id="root"><div class="image-placement"><span class="image-resize-grip"></span></div><div class="image-edit-controls"><span class="image-resize-grip"></span></div><div class="rich-image-body image-resizing"><span class="resize-body-text">text</span></div></div>`);
 try{
  const rule=[...dom.window.document.styleSheets[0]!.cssRules].find(rule=>'selectorText' in rule && (rule as CSSStyleRule).selectorText.includes('#root .image-resize-grip')) as CSSStyleRule;
  assert.ok(rule);assert.ok(rule.selectorText.split(',').map(selector=>selector.trim()).includes('#root .image-resize-grip'));assert.equal(rule.style.getPropertyValue('cursor'),'nwse-resize');assert.equal(rule.style.getPropertyPriority('cursor'),'important');
  const defaultRule=dom.window.document.styleSheets[1]!.cssRules[0] as CSSStyleRule;assert.ok(defaultRule.selectorText.split(',').map(selector=>selector.trim()).includes('#root *'));assert.equal(defaultRule.style.getPropertyPriority('cursor'),'important');
  // Real order is image styles then workspace defaults. #root + class outranks #root + universal.
  // jsdom 30 incorrectly lets the later sheet win equal-important declarations regardless of specificity.
  // Check actual selectors/priorities above, then isolate the winning rules to verify their computed values.
  dom.window.document.querySelectorAll('style')[1]!.remove();
  for(const grip of dom.window.document.querySelectorAll('.image-resize-grip'))assert.equal(dom.window.getComputedStyle(grip).cursor,'nwse-resize');
  const text=dom.window.document.querySelector('.resize-body-text')!;assert.equal(dom.window.getComputedStyle(text).cursor,'nwse-resize');text.parentElement!.classList.remove('image-resizing');assert.notEqual(dom.window.getComputedStyle(text).cursor,'nwse-resize');
 }finally{dom.window.close();}
});
