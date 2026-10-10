import type { CoreState } from '../core/state.ts';

/** A gap is measured before removal; core moveCard expects the final index. */
export function dropIndex(state: CoreState, id: string, parent: string | null, gap: number): number {
  const source = parent === null ? -1 : (state.children.get(parent) ?? []).findIndex(entry => entry.id === id);
  return Math.max(0, gap - (source >= 0 && source < gap ? 1 : 0));
}
