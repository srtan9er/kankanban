import {uiText} from '../i18n/text.ts';

export type GitDiff={text:string;binary?:boolean;beforeImage?:string|null;afterImage?:string|null};
export function GitDiffView({diff}:{diff:GitDiff|null}){
 if(!diff)return <div className="git-empty-state"><GitIcon name="file"/><p>{uiText('git.noFileSelected')}</p></div>;
 return <div className="git-diff-content">{diff.binary&&<p className="git-muted">{uiText('git.binary')}</p>}
  {(diff.beforeImage||diff.afterImage)&&<div className="git-image-diff">{diff.beforeImage&&<figure><img src={diff.beforeImage} alt={uiText('git.imageBefore')}/><figcaption>{uiText('git.imageBefore')}</figcaption></figure>}{diff.afterImage&&<figure><img src={diff.afterImage} alt={uiText('git.imageAfter')}/><figcaption>{uiText('git.imageAfter')}</figcaption></figure>}</div>}
  {diff.text?<pre className="git-diff">{diff.text.split('\n').map((line,index)=><span key={index} className={line.startsWith('@@')?'git-diff-hunk':line.startsWith('+')&&!line.startsWith('+++')?'git-diff-added':line.startsWith('-')&&!line.startsWith('---')?'git-diff-removed':undefined}>{line}{'\n'}</span>)}</pre>:!diff.binary&&<p className="git-muted">{uiText('git.diffEmpty')}</p>}
 </div>;
}
export function GitIcon({name}:{name:'repo'|'branch'|'sync'|'refresh'|'more'|'graph'|'file'|'close'|'chevron'|'compare'}){
 const paths={repo:'M4 3h13v16H4z M7 3v16 M10 7h4 M10 11h4',branch:'M6 6v9 M6 10c8 0 10-1 10-4',sync:'M4 8a7 7 0 0 1 13-2l2 2 M19 3v5h-5 M18 14a7 7 0 0 1-13 2l-2-2 M3 19v-5h5',refresh:'M18 8a7 7 0 1 0 0 7 M18 3v5h-5',more:'M5 11h.1 M11 11h.1 M17 11h.1',graph:'M5 4v14 M5 8c8 0 11 3 11 10',file:'M5 3h8l4 4v12H5z M13 3v5h4 M8 12h6 M8 15h5',close:'M5 5l12 12 M17 5L5 17',chevron:'M6 9l5 5 5-5',compare:'M7 3v15 M3 7l4-4 4 4 M15 19V4 M11 15l4 4 4-4'};
 return <svg className="git-icon" width="20" height="20" viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={name==='more'?3:1.6} strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]}/>{name==='branch'&&<><circle cx="6" cy="4" r="2"/><circle cx="16" cy="4" r="2"/><circle cx="6" cy="17" r="2"/></>}{name==='graph'&&<><circle cx="5" cy="4" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="16" cy="18" r="2"/></>}</svg>;
}
