import {layoutNextLine,type PreparedTextWithSegments,type LayoutCursor} from '@chenglou/pretext';
export type PreviewLine={text:string;slotWidth:number;measuredWidth:number};
export function previewLayout(prepared:PreparedTextWithSegments,width:number,maxLines:number,reservedWidth:number):{lines:PreviewLine[];overflow:boolean}{
 const limit=Math.max(1,Math.floor(maxLines)),narrow=Math.max(1,width-reservedWidth);
 for(let count=1;count<=limit;count++){
  const lines:PreviewLine[]=[];let cursor:LayoutCursor={segmentIndex:0,graphemeIndex:0};
  for(let i=0;i<count;i++){
   const slotWidth=reservedWidth>0 && i>=count-2?narrow:width,line=layoutNextLine(prepared,cursor,slotWidth);
   if(!line)break;lines.push({text:line.text,slotWidth,measuredWidth:line.width});cursor=line.end;
  }
  const overflow=layoutNextLine(prepared,cursor,narrow)!==null;
  if(!overflow || count===limit){
   // A blank footer row may be needed to keep the icon below a full-width row.
   if(reservedWidth>0)while(lines.length<count)lines.push({text:'',slotWidth:narrow,measuredWidth:0});
   return {lines,overflow};
  }
 }
 return {lines:[],overflow:false};
}
