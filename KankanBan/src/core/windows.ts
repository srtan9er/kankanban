/** Tree ownership and desktop expansions are independent.
 * One live card may have many dedicated windows; ancestor/descendant windows may coexist.
 * Closing or moving a card does not detach it or invalidate its window; deletion does.
 */
import {uiText} from '../i18n/text.ts';
import {windowAnchor} from './window-identity.ts';



import type { CoreState } from './state.ts';
import type { CardId } from './types.ts';


export const MAIN_ID: CardId = '000';


/** Root cards for the manager tree; this is not the window eligibility set. */
export function desktopCards(state: CoreState): CardId[] {
  const childIds = new Set<CardId>();
  for (const list of state.children.values()) {
    for (const entry of list) childIds.add(entry.id);
  }

  return [...state.cards.values()]
    .filter((card) => !card.deleted && !childIds.has(card.id))
    .map((card) => card.id)
    .sort();
}


/** Every live card may have an independent desktop expansion. */
export function windowCards(state: CoreState): CardId[] {
  return [...state.cards.values()].filter(card=>!card.deleted).map(card=>card.id).sort();
}


export function openWindowSet(state: CoreState, remembered: readonly CardId[]): CardId[] {
  const live = new Set(windowCards(state));
  const open = new Set([...new Set(remembered)].filter((id) => live.has(windowAnchor(id))));

  if (live.has(MAIN_ID)) open.add(MAIN_ID);

  return [...open].sort();
}


export function restorableWindows(
  state: CoreState,
  remembered: readonly CardId[],
  options: { restore?: boolean | undefined; mainId?: CardId | undefined } = {},
): CardId[] {
  if (options.restore === false) {
    const live = new Set(windowCards(state));
    const main = options.mainId ?? MAIN_ID;
    return live.has(main) ? [main] : [];
  }
  return openWindowSet(state, remembered);
}

export type WindowTransition = {

  opened: CardId[];

  closed: CardId[];
};


export function windowTransition(before: readonly CardId[], after: readonly CardId[]): WindowTransition {
  const wasOpen = new Set(before);
  const nowOpen = new Set(after);

  return {
    opened: after.filter((id) => !wasOpen.has(id)),
    closed: before.filter((id) => !nowOpen.has(id)),
  };
}


export function assertInvariantW(
  state: CoreState,
  context = uiText("core/windows.text001"),
  open?: readonly CardId[] | undefined,
): void {
  const childIds = new Set<CardId>();

  for (const [parentId, list] of state.children) {
    const parent = state.cards.get(parentId);
    if (parent === undefined) {
      throw new Error(uiText("core/windows.text002", {arg0: (context), arg1: (parentId)}));
    }
    if (parent.deleted) {
      throw new Error(uiText("core/windows.text003", {arg0: (context), arg1: (parentId)}));
    }

    for (const entry of list) {
      const child = state.cards.get(entry.id);
      if (child === undefined) {
        throw new Error(uiText("core/windows.text004", {arg0: (context), arg1: (entry.id), arg2: (parentId)}));
      }
      if (child.deleted) {
        throw new Error(uiText("core/windows.text005", {arg0: (context), arg1: (entry.id), arg2: (parentId)}));
      }
      if (childIds.has(entry.id)) {
        throw new Error(uiText("core/windows.text006", {arg0: (context), arg1: (entry.id)}));
      }
      childIds.add(entry.id);
    }
  }

  if (open === undefined) return;

  const desktop = new Set(windowCards(state));
  for (const id of open) {
    if (!desktop.has(windowAnchor(id))) {
      throw new Error(uiText("core/windows.text007", {arg0: (context), arg1: (id)}));
    }
  }

  if (desktop.has(MAIN_ID) && !open.includes(MAIN_ID)) {
    throw new Error(uiText("core/windows.text008", {arg0: (context)}));
  }
}
