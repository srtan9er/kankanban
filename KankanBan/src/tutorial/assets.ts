import data from './assets-data.json' with {type:'json'};
import type {CardImage} from '../core/types.ts';
import {uiText,type TextKey} from '../i18n/text.ts';

export type TutorialAssetKey=keyof typeof data;
export const tutorialAssets=data;
const labels:Record<TutorialAssetKey,TextKey>={star:'tutorialAssets.starName',starLarge:'tutorialAssets.starLargeName',sunrise:'tutorialAssets.sunriseName',night:'tutorialAssets.nightName'};
export function tutorialImage(asset:TutorialAssetKey,id:string):CardImage {
 const source=data[asset];return {id,assetId:source.assetId,name:uiText(labels[asset]),mime:'image/png',width:source.width,height:source.height};
}
export function tutorialAssetInputs(){return (Object.keys(data) as TutorialAssetKey[]).map(key=>({name:uiText(labels[key])+'.png',base64:data[key].base64}));}
