export type TutorialBuildResult = {
  workspace:string;
  rootId:string;
  cards:number;
  tutorialCards:number;
  edition:number;
  status:'checked'|'rebuilt';
};
export function rebuildTutorialWorkspace(workspace:string,options?:{replace?:boolean;check?:boolean}):TutorialBuildResult;
