import {objectDragPaper} from './object-drag-paper.ts';
import {passedDragThreshold,swallowDragClick} from './pointer-gesture.ts';
import {forwardRef,useEffect,useImperativeHandle,useRef,useState,type ReactNode,type PointerEvent as ReactPointerEvent} from 'react';
import {createPortal} from 'react-dom';
import {mergeTable,splitTable,insertTableTrack,deleteTableSelection,TABLE_MIN_COLUMN_WIDTH,TABLE_MIN_ROW_HEIGHT,TABLE_CELL_FONT_SIZE,type BodyTable,type TableData,type TableCell} from '../core/table-markdown.ts';
import {uiText} from '../i18n/text.ts';
import {registerEditor} from './drafts.ts';
import {Markdown} from './Markdown.tsx';
import type {CardImage} from '../core/types.ts';
import './table-object.css';
export type TableHandle={edit:(key:string,extend?:boolean)=>void;flush:()=>Promise<void>};
type Props={previewData?:TableData|undefined;table:BodyTable;width:number;height:number;index:number;active:boolean;editable:boolean;toolsHost:HTMLElement|null;images:CardImage[];activate:()=>void;finishEditing:()=>void;preview:(size:{width:number;height:number}|null)=>void;save:(data:TableData,expected?:TableData)=>Promise<void>};
type Point={row:number;col:number};
type Selection={a:Point;b:Point;axis?:'rows'|'columns'};
const key=(cell:Point)=>`${cell.row}:${cell.col}`;
export const TableObject=forwardRef<TableHandle,Props>(function TableObject({previewData,table,width,height,index,active,editable,toolsHost,images,activate,finishEditing,preview,save},ref){
 const root=useRef<HTMLDivElement>(null),latest=useRef(table),saveRef=useRef(save),editor=useRef<{cell:TableCell;value:string}|null>(null),flight=useRef<Promise<void>|null>(null),stop=useRef<(()=>void)|null>(null);
 latest.current=table;saveRef.current=save;
 const [draft,setDraft]=useState<{cell:TableCell;value:string}|null>(null),[selection,setSelection]=useState<Selection|null>(null),[local,setLocal]=useState<TableData|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const update=(value:typeof draft)=>{editor.current=value;setDraft(value);};
 const flush=():Promise<void>=>{
  if(flight.current)return flight.current;const snapshot=editor.current;if(!snapshot)return Promise.resolve();
  const current=latest.current.data.cells.find(cell=>key(cell)===key(snapshot.cell));
  if(!current || current.text!==snapshot.cell.text || current.rowSpan!==snapshot.cell.rowSpan || current.colSpan!==snapshot.cell.colSpan){const error=new Error(uiText('tables.cellChanged'));setError(String(error));return Promise.reject(error);}
  if(snapshot.value===current.text){update(null);return Promise.resolve();}
  setBusy(true);setError('');const task=saveRef.current({...latest.current.data,cells:latest.current.data.cells.map(cell=>cell===current?{...cell,text:snapshot.value}:cell)},latest.current.data).then(()=>{if(editor.current===snapshot)update(null);}).catch(error=>{setError(String(error));throw error;}).finally(()=>{setBusy(false);if(flight.current===task)flight.current=null;});flight.current=task;return task;
 };
 const edit=(cellKey:string,extend=false)=>{
  if(!editable || busy)return;const cell=latest.current.data.cells.find(cell=>key(cell)===cellKey);if(!cell)return;
  activate();if(extend){void flush().then(()=>{setSelection(previous=>({a:previous?.a ?? cell,b:{row:cell.row+cell.rowSpan-1,col:cell.col+cell.colSpan-1}}));root.current?.focus({preventScroll:true});}).catch(()=>{});return;}
  if(editor.current && key(editor.current.cell)===cellKey)return;
  void flush().then(()=>{setSelection({a:cell,b:{row:cell.row+cell.rowSpan-1,col:cell.col+cell.colSpan-1}});update({cell,value:cell.text});}).catch(()=>{});
 };
 const selectTrack=(axis:'rows'|'columns',track:number,extend:boolean)=>{
  if(!editable || busy)return;activate();
  const first=extend && selection?.axis===axis?(axis==='rows'?selection.a.row:selection.a.col):track;
  void flush().then(()=>{const data=latest.current.data;setSelection(axis==='rows'?{axis,a:{row:first,col:0},b:{row:track,col:data.columns.length-1}}:{axis,a:{row:0,col:first},b:{row:data.rows.length-1,col:track}});root.current?.focus({preventScroll:true});}).catch(()=>{});
 };
 useEffect(()=>{setSelection(previous=>{
  if(!previous)return null;const row=(value:number)=>Math.min(value,table.data.rows.length-1),col=(value:number)=>Math.min(value,table.data.columns.length-1);
  return previous.axis==='rows'?{axis:'rows',a:{row:row(previous.a.row),col:0},b:{row:row(previous.b.row),col:table.data.columns.length-1}}:previous.axis==='columns'?{axis:'columns',a:{row:0,col:col(previous.a.col)},b:{row:table.data.rows.length-1,col:col(previous.b.col)}}:{a:{row:row(previous.a.row),col:col(previous.a.col)},b:{row:row(previous.b.row),col:col(previous.b.col)}};
 });},[table.data]);
 useImperativeHandle(ref,()=>({edit,flush}));
 useEffect(()=>{const handler=(event:Event)=>{if(editable)registerEditor(event,flush());};document.addEventListener('kkb:prepare-close',handler);return()=>{document.removeEventListener('kkb:prepare-close',handler);stop.current?.();};},[]);
 useEffect(()=>{
  if(!editable)return;
  const outside=(event:MouseEvent)=>{if(event.button!==0 || !editor.current || !(event.target instanceof Node) || root.current?.contains(event.target) || event.target instanceof Element && event.target.closest('.table-tools,.image-layout-toolbar,.image-remove,.table-collapse'))return;
   const pane=root.current?.closest('.preview,.document-region,.ordinary-document,.card-body-region') ?? root.current?.closest('.rich-image-body');if(!pane?.contains(event.target))return;
   event.preventDefault();event.stopImmediatePropagation();void flush().then(finishEditing).catch(()=>{});
  };
  document.addEventListener('click',outside,true);return()=>document.removeEventListener('click',outside,true);
 },[editable]);
 useEffect(()=>{setLocal(null);},[table]);
 useEffect(()=>{if(!active){void flush().catch(()=>{});setSelection(null);}},[active]);
 const data=local ?? previewData ?? table.data,totalWidth=data.columns.reduce((a,b)=>a+b,0),totalHeight=data.rows.reduce((a,b)=>a+b,0),scaleX=width/totalWidth,scaleY=height/totalHeight;
 const write=async(next:TableData,expected=latest.current.data)=>{setError('');setBusy(true);try{await saveRef.current(next,expected);setLocal(null);}catch(error){setError(String(error));setLocal(null);}finally{setBusy(false);preview(null);}};
 const resizeTrack=(event:ReactPointerEvent,axis:'columns'|'rows',track:number)=>{
  if(event.button!==0 || !editable || busy)return;event.preventDefault();event.stopPropagation();activate();
  if(editor.current){const changed=editor.current.value!==editor.current.cell.text;void flush().catch(()=>{});if(changed)return;}
  const before=latest.current.data,start=axis==='columns'?event.clientX:event.clientY,scale=axis==='columns'?scaleX:scaleY,pointerId=event.pointerId;let next=before;
  stop.current?.();const capture=event.currentTarget,origin={clientX:event.clientX,clientY:event.clientY};let moved=false,paper:ReturnType<typeof objectDragPaper>|null=null;const body=root.current?.closest<HTMLElement>('.rich-image-body'),initial=root.current!.getBoundingClientRect();let lastPoint={clientX:event.clientX,clientY:event.clientY};
  const move=(event:Pick<PointerEvent,'pointerId'|'clientX'|'clientY'|'preventDefault'>)=>{if(event.pointerId!==pointerId)return;lastPoint={clientX:event.clientX,clientY:event.clientY};if(!moved){if(!passedDragThreshold(origin,event))return;moved=true;capture.setPointerCapture?.(pointerId);if(body)paper=objectDragPaper(body,()=>move({pointerId,...lastPoint,preventDefault:()=>{}}));}event.preventDefault();const current=root.current!.getBoundingClientRect(),scroll=axis==='columns'?initial.left-current.left:initial.top-current.top;const sizes=[...before[axis]];sizes[track]=Math.max(axis==='columns'?TABLE_MIN_COLUMN_WIDTH:TABLE_MIN_ROW_HEIGHT,Math.min(4096,before[axis][track]!+((axis==='columns'?event.clientX:event.clientY)-start+scroll)/scale));next={...before,[axis]:sizes};setLocal(next);preview({width:next.columns.reduce((a,b)=>a+b,0),height:next.rows.reduce((a,b)=>a+b,0)});if(body){const origin=body.getBoundingClientRect();paper?.update(event,{x:current.left-origin.left,y:current.top-origin.top,width:next.columns.reduce((a,b)=>a+b,0),height:next.rows.reduce((a,b)=>a+b,0)});}};
  const finish=(event:PointerEvent)=>{if(event.pointerId!==pointerId)return;move(event);stop.current?.();if(moved)swallowDragClick();if(next[axis][track]!==before[axis][track])void write(next,before);else{setLocal(null);preview(null);}};
  const cancel=()=>{stop.current?.();setLocal(null);preview(null);};
  window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);
  stop.current=()=>{paper?.stop();window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);stop.current=null;};
 };
 const selected=(cell:TableCell)=>selection && cell.row<=Math.max(selection.a.row,selection.b.row) && cell.row+cell.rowSpan>Math.min(selection.a.row,selection.b.row) && cell.col<=Math.max(selection.a.col,selection.b.col) && cell.col+cell.colSpan>Math.min(selection.a.col,selection.b.col);
 const run=(operation:(data:TableData)=>TableData)=>{void flush().then(()=>{try{const before=latest.current.data,next=operation(before);if(next!==before)void write(next,before);}catch(error){setError(String(error));}}).catch(()=>{});};
 const selectedCell=selection?data.cells.find(cell=>cell.row<=selection.a.row && cell.row+cell.rowSpan>selection.a.row && cell.col<=selection.a.col && cell.col+cell.colSpan>selection.a.col):undefined;
 const add=(axis:'rows'|'columns')=>{if(!selection)return;const anchor=selectedCell ?? selection.a;run(data=>insertTableTrack(data,axis,anchor));};
 const tools:ReactNode=<div className="table-tools" onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}>
  <div className="table-tool-buttons">
   <button disabled={busy || !selection || data.cells.filter(cell=>selected(cell)).length<2} title={uiText('tables.merge')} aria-label={uiText('tables.merge')} onClick={()=>selection && run(data=>mergeTable(data,selection.a,selection.b))}><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14"/><path d="M8 12h8m-3-3 3 3-3 3"/></svg></button>
   <button disabled={busy || !selectedCell || selectedCell.rowSpan===1 && selectedCell.colSpan===1} title={uiText('tables.split')} aria-label={uiText('tables.split')} onClick={()=>selectedCell && run(data=>splitTable(data,data.cells.find(cell=>key(cell)===key(selectedCell))!))}><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14"/><path d="M12 5v14M3 12h18"/></svg></button>
   <button disabled={busy || !selectedCell} title={uiText('tables.addRow')} aria-label={uiText('tables.addRow')} onClick={()=>add('rows')}><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="11"/><path d="M12 17v6m-3-3h6M3 8h18"/></svg></button>
   <button disabled={busy || !selectedCell} title={uiText('tables.addColumn')} aria-label={uiText('tables.addColumn')} onClick={()=>add('columns')}><svg viewBox="0 0 24 24"><rect x="3" y="3" width="11" height="18"/><path d="M20 9v6m-3-3h6M8 3v18"/></svg></button>
  </div>

 </div>;
 return <div ref={root} className="table-object" tabIndex={editable?-1:undefined} style={{width,height}} onKeyDown={event=>{
  if(!editable || !selection || event.nativeEvent.isComposing || (event.key!=='Delete' && event.key!=='Backspace') || (event.target instanceof Element && event.target.closest('textarea,input,[contenteditable=true]')))return;
  event.preventDefault();event.stopPropagation();if(busy)return;const current=selection;run(data=>deleteTableSelection(data,current.a,current.b,current.axis));
 }}>
  <div className="table-surface" style={{width,height}}><table className="editable-table" style={{width,height,fontSize:TABLE_CELL_FONT_SIZE,lineHeight:1.6}}><colgroup>{data.columns.map((w,i)=><col key={i} style={{width:w*scaleX}}/>)}</colgroup>
   <tbody>{data.rows.map((_,i)=>row(i))}</tbody>
  </table></div>
  {editable && <div className="table-axis-selectors">{(['rows','columns'] as const).map(axis=>data[axis].map((_,track)=><button key={`${axis}:${track}`} className={`table-axis-select table-${axis==='rows'?'row':'column'}-select`} data-select-axis={axis} data-track={track} disabled={busy} title={uiText(axis==='rows'?'tables.selectRow':'tables.selectColumn',{arg0:track+1})} aria-label={uiText(axis==='rows'?'tables.selectRow':'tables.selectColumn',{arg0:track+1})} style={axis==='rows'?{left:0,top:data.rows.slice(0,track).reduce((a,b)=>a+b,0)*scaleY,height:data.rows[track]!*scaleY}:{top:0,left:data.columns.slice(0,track).reduce((a,b)=>a+b,0)*scaleX,width:data.columns[track]!*scaleX}} onPointerDown={event=>{event.preventDefault();event.stopPropagation();}} onClick={event=>{event.stopPropagation();selectTrack(axis,track,event.shiftKey);}}/>))}</div>}
  {active && editable && <>{data.columns.map((_,i)=><span key={`c${i}`} className="table-track-grip table-column-grip" role="separator" aria-label={uiText('tables.column')} style={{left:data.columns.slice(0,i+1).reduce((a,b)=>a+b,0)*scaleX-3,height}} onPointerDown={event=>resizeTrack(event,'columns',i)}/>)}{data.rows.map((_,i)=><span key={`r${i}`} className="table-track-grip table-row-grip" role="separator" aria-label={uiText('tables.row')} style={{top:data.rows.slice(0,i+1).reduce((a,b)=>a+b,0)*scaleY-3,width}} onPointerDown={event=>resizeTrack(event,'rows',i)}/>)}</>}
  {active && toolsHost && createPortal(tools,toolsHost)}
  {error && <div className="table-error" role="alert">{error}</div>}
 </div>;
 function row(r:number){return <tr key={r} style={{height:data.rows[r]!*scaleY}}>{data.cells.filter(cell=>cell.row===r).map(cell=>{const Tag=r===0?'th':'td',cellHeight=data.rows.slice(cell.row,cell.row+cell.rowSpan).reduce((a,b)=>a+b,0)*scaleY-1,editing=draft && key(draft.cell)===key(cell);return <Tag key={key(cell)} rowSpan={cell.rowSpan} colSpan={cell.colSpan} data-table-cell={key(cell)} data-cell-editing={!!editing} tabIndex={editable?0:undefined} onKeyDown={event=>{if(event.target===event.currentTarget && (event.key==='Enter' || event.key===' ')){event.preventDefault();event.stopPropagation();edit(key(cell),event.shiftKey);}}} data-cell-selected={!!selected(cell)} style={{textAlign:data.alignment[cell.col]}} title={uiText('tables.select')} onClick={event=>{event.stopPropagation();if(event.detail===0)edit(key(cell),event.shiftKey);}}>
   <div className="table-cell-content" style={{height:Math.max(1,cellHeight)}}>{editing?<textarea className="table-cell-editor" aria-label={uiText('tables.edit')} autoFocus disabled={busy} value={draft.value} onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onChange={event=>update({...draft,value:event.target.value})} onBlur={()=>void flush().catch(()=>{})} onKeyDown={event=>{event.stopPropagation();if(event.nativeEvent.isComposing)return;if(event.key==='Escape'){event.preventDefault();update(null);root.current?.focus({preventScroll:true});}else if((event.ctrlKey || event.metaKey) && event.key==='Enter'){event.preventDefault();void flush().catch(()=>{});}}}/>:<Markdown text={cell.text} images={images} compact/>}</div>
  </Tag>;})}</tr>;}
});
