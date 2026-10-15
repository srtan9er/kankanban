import {graphRows,type GitCommit} from '../extensions/git-graph.ts';
import {uiText} from '../i18n/text.ts';
export function GitGraph({commits,selected,select}:{commits:GitCommit[];selected:string|null;select:(id:string)=>void}){
 const color=(lane:number)=>['var(--palette-accent)','var(--palette-prefab-border)','var(--palette-instance-border)','color-mix(in srgb,var(--palette-accent) 45%,var(--palette-text))'][lane%4]!;
 const rows=graphRows(commits),width=Math.max(1,...rows.map(r=>r.width))*18+16;
 return <div className="git-graph" data-scroll-owner="git:graph">{rows.length?rows.map(row=><button key={row.commit.id} className={`git-commit-row ${selected===row.commit.id?'selected':''}`} aria-pressed={selected===row.commit.id} onClick={()=>select(row.commit.id)}>
  <svg width={width} height={44} viewBox={`0 0 ${width} 44`} aria-hidden="true">{row.edges.map((edge,i)=>{const x=10+edge.from*18,y=10+edge.to*18;return <path key={i} style={{stroke:color(edge.from)}} className={edge.parent?'parent':''} d={edge.parent?`M ${x} 22 C ${x} 34 ${y} 34 ${y} 44`:`M ${x} 0 C ${x} 22 ${y} 22 ${y} 44`}/>;})}<path className="parent" style={{stroke:color(row.lane)}} d={`M ${10+row.lane*18} 0 V 22`}/><circle style={{fill:color(row.lane)}} cx={10+row.lane*18} cy={22} r={4}/></svg>
  <span className="git-commit-text"><strong>{row.commit.subject}</strong>{row.commit.refs&&<span className="git-ref-label">{row.commit.refs}</span>}<small>{row.commit.id.slice(0,8)} · {row.commit.author} · {row.commit.date.slice(0,10)}</small></span>
 </button>):<p>{uiText('git.empty')}</p>}</div>;
}
