import {discardLegacyInk} from '../core/drawing.ts';
import type {ReactNode} from 'react';
import type {CardImage} from '../core/types.ts';
import {RichImageBody} from './RichImageBody.tsx';
import type {Request} from './controller.ts';
/** Text and image bodies share formatting and source-mapped task editing. */
export function Markdown({text,placeholder,images=[],id,send,prepare,compact=false}:{text:string;compact?:boolean;placeholder?:string;images?:CardImage[];id?:string;send?:(request:Request)=>Promise<unknown>;prepare?:(()=>Promise<unknown>)|undefined}):ReactNode {
 text=discardLegacyInk(text);
 if(!text.trim() && placeholder)return <div className="markdown body-placeholder">{placeholder}</div>;
 return <RichImageBody text={text} images={images} id={id} send={send} prepare={prepare} compact={compact}/>;
}
