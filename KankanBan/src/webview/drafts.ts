type Field = 'title' | 'content';

/** Keep local text until the exact revision is acknowledged by the writer. */
export class Drafts {
  private values = new Map<Field, { value: string; revision: number }>();
  private revision = 0;
  private pending = new Map<number, Promise<unknown>>();
  private save: (field: Field, value: string) => Promise<unknown>;
  constructor(save: (field: Field, value: string) => Promise<unknown>) { this.save = save; }
  set(field: Field, value: string): void { this.values.set(field, { value, revision: ++this.revision }); }
  has(field: Field): boolean { return this.values.has(field); }
  flush(): Promise<unknown> {
    for (const [field, draft] of this.values) {
      if (this.pending.has(draft.revision)) continue;
      const task = this.save(field, draft.value).then(() => {
        if (this.values.get(field)?.revision === draft.revision) this.values.delete(field);
      }).finally(() => this.pending.delete(draft.revision));
      this.pending.set(draft.revision, task);
    }
    return Promise.all([...this.pending.values()]);
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
