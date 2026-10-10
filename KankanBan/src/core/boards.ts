import {uiText} from '../i18n/text.ts';
import { createCard, moveCard, transact, type Session } from './workspace.ts';
import { isBoard } from './renderer.ts';

const TITLES = [uiText("core/boards.text001"), uiText("core/boards.text002"), uiText("core/boards.text003")] as const;

/** Upgrade old boards without deleting cards: keep overflow columns as cards in the last column. */
export function normalizeBoards(session: Session): void {
  transact(session, s => {
    for (const board of [...s.state.cards.values()]) {
      if (board.deleted || !isBoard(s.state, board.id)) continue;
      let columns = s.state.children.get(board.id) ?? [];
      while (columns.length < 3) {
        createCard(s, { parentId: board.id, title: TITLES[columns.length]!, layout: 'ordered', isPrefab: board.isPrefab });
        columns = s.state.children.get(board.id)!;
      }
      let last = columns[2]!.id;
      // Legacy columns can themselves be boards. Land inside their last column,
      // rather than accidentally attempting to create a fourth structural column.
      while (columns.length > 3 && isBoard(s.state, last)) {
        let nested = s.state.children.get(last) ?? [];
        while (nested.length < 3) {
          createCard(s, { parentId: last, title: TITLES[nested.length]!, layout: 'ordered', isPrefab: board.isPrefab });
          nested = s.state.children.get(last)!;
        }
        last = nested[2]!.id;
      }
      // An old third column may use a plane: provide a placement when necessary.
      for (const extra of columns.slice(3)) {
        const count = s.state.children.get(last)?.length ?? 0;
        moveCard(s, extra.id, last, count, { x: 32, y: 32 + count * 144, w: 220, h: 120, z: count });
      }
    }
  });
}
