import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wantedDesktopViews} from '../src/webview/card-window-service.ts';
import {emptyState} from '../src/core/state.ts';
import {emptyViewState} from '../src/core/view-state.ts';
test('registered extension windows survive synchronization without entering the card tree',()=>{
 const view=emptyViewState();Object.assign(view,{extensions:{git:{enabled:true,installed:true,config:{}}}});view.openWindows=['ext-git__one','ext-git__two'];
 assert.deepEqual(wantedDesktopViews(emptyState(),view),view.openWindows);
});
