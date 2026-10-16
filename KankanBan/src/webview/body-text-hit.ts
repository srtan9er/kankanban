/** Only active text input owns selection; idle text keeps the window-move gesture. */
export function bodyTextHit(target:Element):boolean{
 const body=target.closest('.card-body-editor[data-body-editing="true"]');if(!body)return false;
 if(target.closest('button,input,textarea,select,.image-placement,.editable-table,[data-drawing-surface]'))return false;
 const editor=target.closest('[data-markdown-editor][contenteditable="true"]');if(!editor||!body.contains(editor))return false;
 if(!editor.hasAttribute('data-visual-editor'))return true;
 const fragment=target.closest('.rich-image-text,.rich-text-paragraph,.rich-flow-line,[data-source-start]');
 return !!fragment && body.contains(fragment) && !!fragment.textContent?.length;
}
