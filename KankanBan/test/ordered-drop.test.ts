import './dom-setup.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {orderedDrop,listNestingTarget} from '../src/webview/ordered-drop.ts';
import {dropIndex} from '../src/webview/drop-index.ts';
import {createMemoryFs} from '../src/platform/memory-fs-ops.ts';
import {openSession,createCard,moveCard} from '../src/core/workspace.ts';
function list(horizontal:boolean,indexes=[0,1,2]){
 const root=document.createElement('div');root.className=horizontal?'horizontal-card-list':'vertical-card-list';root.dataset.dropParent='parent';root.getBoundingClientRect=()=>({left:0,top:0,right:horizontal?500:100,bottom:horizontal?100:500,width:horizontal?500:100,height:horizontal?100:500,x:0,y:0,toJSON:()=>{}});Object.defineProperties(root,{clientWidth:{value:horizontal?500:100},clientHeight:{value:horizontal?100:500}});
 const hits=indexes.map((index,i)=>{const slot=document.createElement('div');slot.className='card-slot';slot.getBoundingClientRect=()=>({left:horizontal?i*110:0,top:horizontal?0:i*110,right:horizontal?i*110+100:100,bottom:horizontal?100:i*110+100,width:100,height:100,x:0,y:0,toJSON:()=>{}});const gap=document.createElement('div');gap.className='insertion-zone';gap.dataset.dropIndex=String(index);const content=document.createElement('span');slot.append(gap,content);root.append(slot);return content;});document.body.append(root);return {root,hits};
}
for(const horizontal of [true,false])test(`${horizontal?'horizontal':'vertical'} uses identical quarter-edge sorting and middle-half nesting for both drags`,()=>{
 const {root,hits}=list(horizontal);const point=(at:number)=>horizontal?[at,50]:[50,at];
 try{for(const [at,gap] of ([[5,0],[115,1],[205,2],[450,3]] as const)){const [x,y]=point(at);assert.equal(orderedDrop(at===450?root:hits[at<100?0:1]!,x!,y!,false)?.gap,gap);}
 const [beforeX,beforeY]=point(115),[afterX,afterY]=point(205),[middleX,middleY]=point(160);
 assert.equal(orderedDrop(hits[1]!,beforeX!,beforeY!,true)?.gap,1);assert.equal(orderedDrop(hits[1]!,afterX!,afterY!,true)?.gap,2);assert.equal(orderedDrop(hits[1]!,middleX!,middleY!,true),null);assert.equal(orderedDrop(hits[1]!,middleX!,middleY!,false),null);
 }finally{root.remove();}
});
test('filtered lists use original tree indexes and forward moves remove the source once',()=>{
 const {root,hits}=list(true,[2,5,8]);try{assert.equal(orderedDrop(hits[1]!,115,50,false)?.gap,5);}finally{root.remove();}
 const s=openSession('/order',{ops:createMemoryFs().ops,builtins:false});const parent=createCard(s,{parentId:null,title:'P',layout:'ordered'}),a=createCard(s,{parentId:parent,title:'A'}),b=createCard(s,{parentId:parent,title:'B'}),c=createCard(s,{parentId:parent,title:'C'});
 moveCard(s,a,parent,dropIndex(s.state,a,parent,3));assert.deepEqual(s.state.children.get(parent)?.map(entry=>entry.id),[b,c,a]);moveCard(s,a,parent,dropIndex(s.state,a,parent,0));assert.deepEqual(s.state.children.get(parent)?.map(entry=>entry.id),[a,b,c]);
});
test('kanban column lists use middle-half nesting and top/bottom sibling insertion',()=>{
 const {root,hits}=list(false,[2,5,8]);root.className='column-cards';
 try{assert.equal(orderedDrop(hits[1]!,50,115)?.gap,5);assert.equal(orderedDrop(hits[1]!,50,205)?.gap,6);assert.equal(orderedDrop(hits[1]!,50,160),null);}finally{root.remove();}
});
test('waterfall insertion uses the hovered card original index, not another column midpoint',()=>{
 const {root,hits}=list(false,[2,5,8]);root.className='masonry-grid';const surface=document.createElement('div');surface.className='masonry-surface';while(root.firstChild)surface.append(root.firstChild);root.append(surface);
 root.getBoundingClientRect=()=>({left:0,top:0,right:400,bottom:500,width:400,height:500,x:0,y:0,toJSON:()=>{}});
 const slot=hits[1]!.parentElement!;slot.getBoundingClientRect=()=>({left:150,top:0,right:250,bottom:100,width:100,height:100,x:150,y:0,toJSON:()=>{}});
 try{const above=orderedDrop(hits[1]!,200,5);assert.equal(above?.gap,5);assert.equal(above?.marker.width,100);assert.equal(orderedDrop(hits[1]!,200,95)?.gap,6);assert.equal(orderedDrop(hits[1]!,200,50),null);}finally{root.remove();}
});
test('read-only lists do not accept sibling insertion',()=>{const {root,hits}=list(false);root.removeAttribute('data-drop-parent');try{assert.equal(orderedDrop(hits[0]!,50,5),null);}finally{root.remove();}});
test('native nesting uses the full cross-axis width and excludes the outer quarters',()=>{
 const {root,hits}=list(false);root.className='column-cards';const card=document.createElement('article');card.dataset.cardId='child';card.dataset.dropParent='child';hits[0]!.replaceWith(card);
 try{assert.equal(listNestingTarget(card,5,50),card);assert.equal(listNestingTarget(card,5,5),null);root.removeAttribute('data-drop-parent');assert.equal(listNestingTarget(card,5,50),null);}finally{root.remove();}
});
