export type WindowPositionUpdate={windowId:string;cardId:string;x:number;y:number;sequence:number};
/** Runtime screen positions are separate from card coordinates in their parent's canvas. */
export class WindowPositions {
 readonly values=new Map<string,WindowPositionUpdate>();
 private listeners=new Set<(position:WindowPositionUpdate)=>void>();
 subscribe=(listener:(position:WindowPositionUpdate)=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 accept(position:WindowPositionUpdate):void {
  if(!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isInteger(position.sequence))return;
  if((this.values.get(position.windowId)?.sequence ?? -1)>=position.sequence)return;
  this.values.set(position.windowId,position);for(const listener of this.listeners)listener(position);
 }
}
