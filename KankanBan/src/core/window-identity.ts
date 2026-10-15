/** A card may have multiple independent desktop views; tree identity never changes. */
export function windowAnchor(windowId:string):string { return windowId.split('__')[0]!; }
export function newExpansionId(cardId:string,nonce=crypto.randomUUID()):string { return `${cardId}__${nonce}`; }
export const MAIN_WINDOW_LABEL='main';
export const CARD_WINDOW_PREFIX='card-';
export function windowLabel(windowId:string):string { return `${CARD_WINDOW_PREFIX}${windowId}`; }
export function windowIdFromLabel(label:string):string|null {
 return label.startsWith(CARD_WINDOW_PREFIX) && label.length>CARD_WINDOW_PREFIX.length?label.slice(CARD_WINDOW_PREFIX.length):null;
}
export function cardIdFromLabel(label:string):string|null {
 const id=windowIdFromLabel(label);return id===null?null:windowAnchor(id);
}
