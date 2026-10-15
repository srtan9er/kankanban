export type GitCommit={id:string;parents:string[];author:string;date:string;subject:string;refs:string};
export type GraphEdge={from:number;to:number;parent:boolean};
export type GraphRow={commit:GitCommit;lane:number;edges:GraphEdge[];width:number};
/** Graph lanes are derived from the whole loaded prefix so pagination cannot reset them. */
export function graphRows(commits:readonly GitCommit[]):GraphRow[]{
 let lanes:string[]=[];const rows:GraphRow[]=[];
 for(const commit of commits){let lane=lanes.indexOf(commit.id);if(lane<0){lane=lanes.length;lanes.push(commit.id);}const before=[...lanes];
  const after=[...lanes];after.splice(lane,1);
  for(let i=0;i<commit.parents.length;i++){const parent=commit.parents[i]!;if(!after.includes(parent))after.splice(Math.min(lane+i,after.length),0,parent);}
  const edges:GraphEdge[]=before.flatMap((id,from)=>id===commit.id?[]:after.includes(id)?[{from,to:after.indexOf(id),parent:false}]:[]);
  for(const parent of commit.parents)edges.push({from:lane,to:after.indexOf(parent),parent:true});
  rows.push({commit,lane,edges,width:Math.max(1,before.length,after.length)});lanes=after;
 }
 return rows;
}
