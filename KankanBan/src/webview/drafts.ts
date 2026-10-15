type Field = 'title' | 'content';

/** Keep local text until the exact revision is acknowledged by the writer. */
export class Drafts {
  private values=new Map<Field,{value:string;revision:number;before?:string|undefined}>();
  private revision=0;
  private flight:Promise<unknown>|null=null;
  private save:(field:Field,value:string,before?:string)=>Promise<unknown>;
  constructor(save:(field:Field,value:string,before?:string)=>Promise<unknown>){this.save=save;}
  set(field:Field,value:string,before?:string):void {const old=this.values.get(field);this.values.set(field,{value,revision:++this.revision,before:old?.before ?? before});}
  has(field:Field):boolean{return this.values.has(field);}
  flush():Promise<unknown>{
    if(this.flight)return this.flight;
    const run=async()=>{
      while(this.values.size){
        const batch=[...this.values];
        await Promise.all(batch.map(async([field,draft])=>{
          await this.save(field,draft.value,draft.before);
          const current=this.values.get(field);
          if(current?.revision===draft.revision)this.values.delete(field);
          else if(current)current.before=draft.value;
        }));
      }
    };
    const flight=run().finally(()=>{if(this.flight===flight)this.flight=null;});this.flight=flight;return flight;
  }
}

export function prepareEditors(): Promise<unknown> {
  const tasks: Promise<unknown>[] = [];
  document.dispatchEvent(new window.CustomEvent('kkb:prepare-close', { detail: tasks }));
  return Promise.all(tasks);
}

export function registerEditor(event: Event, task: Promise<unknown>): void {
  const tasks = (event as CustomEvent<Promise<unknown>[] | undefined>).detail;
  if (Array.isArray(tasks)) tasks.push(task);
  else void task.catch(() => undefined);
}
