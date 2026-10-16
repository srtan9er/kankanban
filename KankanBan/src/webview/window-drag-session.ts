type Point={x:number;y:number};
type Invoke=(command:string,args:Record<string,unknown>)=>Promise<unknown>;
/** One native window movement owns one chain transaction. */
export function createWindowDragSession(invoke:Invoke,fixed:boolean){
 let queue=Promise.resolve(),begun=false,closed=false,cancelling=false;
 const enqueue=<T,>(operation:()=>Promise<T>):Promise<T>=>{
  const result=queue.then(operation);queue=result.then(()=>undefined,()=>undefined);return result;
 };
 const begin=async():Promise<void>=>{
  if(closed||cancelling||begun)return;
  await invoke('begin_window_drag',{fixed});begun=true;
 };
 return {
  begin:():Promise<void>=>enqueue(begin),
  move:(point:Point,finish=false):Promise<Record<string,boolean>>=>enqueue(async()=>{
   if(closed||cancelling)return {};
   await begin();
   if(cancelling)return {};
   const hint=await invoke('move_note',{...point,finish});if(finish)closed=true;
   return hint&&typeof hint==='object'?hint as Record<string,boolean>:{};
  }),
  cancel:():Promise<void>=>{
   cancelling=true;return enqueue(async()=>{if(closed)return;if(begun)await invoke('cancel_window_drag',{});closed=true;});
  },
 };
}
