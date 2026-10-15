import {layoutNextRichInlineLineRange,materializeRichInlineLineRange,type PreparedRichInline,type RichInlineCursor,type RichInlineFragment} from '@chenglou/pretext/rich-inline';
export type ImageExclusion={x:number;y:number;width:number;height:number};
export type ImageTextLine={x:number;y:number;width:number;height:number;fragments:RichInlineFragment[]};
export function imageTextSlots(width:number,y:number,height:number,rectangles:readonly ImageExclusion[],gap=8):{x:number;width:number}[]{
 const intervals=rectangles.filter(r=>r.y-gap<y+height && r.y+r.height+gap>y).map(r=>({left:Math.max(0,r.x-gap),right:Math.min(width,r.x+r.width+gap)})).filter(r=>r.right>r.left).sort((a,b)=>a.left-b.left);
 const slots:{x:number;width:number}[]=[];let left=0;
 for(const interval of intervals){if(interval.left>left)slots.push({x:left,width:interval.left-left});left=Math.max(left,interval.right);}
 if(left<width)slots.push({x:left,width:width-left});return slots;
}
/** Text visits every free interval in reading order, advancing below fully occluded rows. */
export function flowImageText(prepared:PreparedRichInline,width:number,startY:number,lineHeight:number,rectangles:readonly ImageExclusion[],itemHeights:readonly number[]=[]):{lines:ImageTextLine[];height:number;end:RichInlineCursor|undefined}{
 const lines:ImageTextLine[]=[];let cursor:RichInlineCursor|undefined,y=startY;
 while(layoutNextRichInlineLineRange(prepared,Math.max(1,width),cursor)){
  let rowHeight=lineHeight,row:ImageTextLine[]=[],end=cursor;
  for(let attempt=0;attempt<3;attempt++){
   row=[];end=cursor;let needed=rowHeight;
   for(const slot of imageTextSlots(width,y,rowHeight,rectangles).filter(slot=>slot.width>=Math.min(24,width))){
    const range=layoutNextRichInlineLineRange(prepared,slot.width,end);if(!range)break;
    // Atomic inline images wait for a wide enough interval instead of painting over a float.
    if(range.width>slot.width+.01)continue;
    const line=materializeRichInlineLineRange(prepared,range);needed=Math.max(needed,...line.fragments.map(fragment=>itemHeights[fragment.itemIndex] ?? lineHeight));
    row.push({x:slot.x,y,width:slot.width,height:rowHeight,fragments:line.fragments});end=range.end;
   }
   if(needed<=rowHeight)break;rowHeight=needed;
  }
  if(row.length){for(const line of row)line.height=rowHeight;lines.push(...row);cursor=end;y+=rowHeight;}
  else{
   const next=rectangles.filter(r=>r.y+r.height+8>y).map(r=>r.y+r.height+8);
   if(!next.length){
    // A viewport narrower than one atomic item still retains it; normal text remains breakable.
    const range=layoutNextRichInlineLineRange(prepared,Math.max(1,width),cursor);if(!range)break;
    const line=materializeRichInlineLineRange(prepared,range);lines.push({x:0,y,width,height:rowHeight,fragments:line.fragments});cursor=range.end;y+=rowHeight;
   }else y=Math.max(y+lineHeight,Math.min(...next));
  }
 }
 return {lines,height:y,end:cursor};
}
