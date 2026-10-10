import metrics from './layout-metrics.json' with {type:'json'};
export const CARD_MIN_WIDTH = metrics.cardMinWidth;
export const CARD_MIN_HEIGHT = metrics.cardMinHeight;
export const GRID_CARD_MAX_HEIGHT = CARD_MIN_HEIGHT * 2;
export const CHILD_MIN_WIDTH = CARD_MIN_WIDTH + metrics.childPadding + metrics.scrollbar;
export const CHILD_MIN_HEIGHT = CARD_MIN_HEIGHT + metrics.childHeaderHeight;
export const BOARD_COLUMN_MIN_WIDTH = CARD_MIN_WIDTH + metrics.columnPadding + metrics.scrollbar;
export const BOARD_NOTE_MIN_WIDTH = 3 * BOARD_COLUMN_MIN_WIDTH + 2 * metrics.columnGap + metrics.notePadding + metrics.windowBorder;
export const BOARD_MAIN_MIN_WIDTH = BOARD_NOTE_MIN_WIDTH - metrics.notePadding + metrics.managerPadding + metrics.sidebarWidth;
export const BOARD_MAIN_MIN_HEIGHT = CARD_MIN_HEIGHT + metrics.boardMainChromeHeight;
export const layoutVariables = {
 '--grid-card-max-height': `${GRID_CARD_MAX_HEIGHT}px`,
 '--card-min-width': `${CARD_MIN_WIDTH}px`, '--card-min-height': `${CARD_MIN_HEIGHT}px`,
 '--board-column-min-width': `${BOARD_COLUMN_MIN_WIDTH}px`, '--board-gap': `${metrics.columnGap}px`,
 '--board-sidebar-width': `${metrics.sidebarWidth}px`,
};
