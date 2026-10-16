import '../src/node/bootstrap.ts';
import {mkdtempSync,mkdirSync,readdirSync,renameSync,existsSync,lstatSync,rmSync,readFileSync,writeFileSync,unlinkSync,realpathSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename,join,resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSession,ensureBuiltins} from '../src/core/workspace.ts';
import {ensureTutorial,TUTORIAL_EDITION} from '../src/core/tutorial.ts';
import {tutorialCards} from '../src/core/tutorial-template.ts';
import {collectSubtree} from '../src/core/subtree.ts';
import {normalizeBoards} from '../src/core/boards.ts';
import {emptyViewState,windowViewFor,writeViewState,readViewState} from '../src/core/view-state.ts';
import {GITIGNORE_MARKER} from '../src/core/storage/gitignore.ts';
import {nodeFsOps} from '../src/node/node-fs-ops.ts';
import {acquireWorkspace} from '../src/node/workspace-lock.ts';
import {uiText} from '../src/i18n/text.ts';
import {tutorialAssets} from '../src/tutorial/assets.ts';
import {parseCardImages} from '../src/core/image-markdown.ts';
import {validCardImages} from '../src/core/card-images.ts';

function ensureTutorialIgnore(root){
 const path=join(root,'.gitignore');if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error(uiText('tutorialBuild.unsafePath'));
 const original=existsSync(path)?readFileSync(path):Buffer.alloc(0);let ignored=false;
 for(const line of original.toString('latin1').split('\n')){
  const value=line.trim();if(/^\/?\.kkb\/?$/.test(value))ignored=true;if(/^!\/?\.kkb\/?$/.test(value))ignored=false;
 }
 if(ignored)return;
 const separator=original.length&&original.at(-1)!==10?'\n':'';
 const content=Buffer.concat([original,Buffer.from(`${separator}\n${GITIGNORE_MARKER}\n.kkb/\n`)]);
 const pending=join(root,`.gitignore.kkb-tutorial-${randomUUID()}.tmp`);
 try{writeFileSync(pending,content,{flag:'wx'});renameSync(pending,path);}finally{if(existsSync(pending))unlinkSync(pending);}
}

function verify(root,id){
 const s=openSession(root,{ops:nodeFsOps,clientId:'tutorial-check'}),tree=collectSubtree(s.state,id);
 // The 7A source lives in the real prefab library, outside the course root.
 const keys=new Set(['root']);let previous;
 do{previous=keys.size;for(const card of tutorialCards)if(keys.has(card.parent))keys.add(card.key);}while(keys.size!==previous);
 const libraryKeys=new Set(tutorialCards.filter(c=>c.parent==='003').map(c=>c.key));
 do{previous=libraryKeys.size;for(const card of tutorialCards)if(libraryKeys.has(card.parent))libraryKeys.add(card.key);}while(libraryKeys.size!==previous);
 const libraryEntries=s.state.children.get('003') ?? [];
 const libraryIds=libraryEntries.flatMap(entry=>collectSubtree(s.state,entry.id).ids);
 const allIds=[...tree.ids,...libraryIds];
 if(keys.size+libraryKeys.size!==tutorialCards.length || tree.ids.length!==keys.size || libraryIds.length!==libraryKeys.size || allIds.some(id=>{const c=s.state.cards.get(id);return !c?.title||!c.content||c.prefabRef&&!s.state.cards.get(c.prefabRef)?.isPrefab;}))throw new Error(uiText('tutorialBuild.invalidGraph'));
 for(const card of s.state.cards.values())if(!card.deleted){
  const children=s.state.children.get(card.id) ?? [];
  if(card.layout==='columns'&&children.length!==3 || card.layout==='plane'&&children.some(c=>!('x' in c)))throw new Error(uiText('tutorialBuild.invalidGraph'));
  if(!validCardImages(card.images ?? []))throw new Error(uiText('tutorialBuild.invalidGraph'));
  for(const image of parseCardImages(card.content,card.images ?? [])){
   if(!image.image)throw new Error(uiText('tutorialBuild.invalidGraph'));
   const path=join(root,'.kkb','assets','images',image.assetId);
   if(!existsSync(path)||lstatSync(path).isSymbolicLink())throw new Error(uiText('tutorialBuild.invalidGraph'));
   const bytes=readFileSync(path);
   if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||createHash('sha256').update(bytes).digest('hex')+'.png'!==image.assetId||bytes.readUInt32BE(16)!==image.image.width||bytes.readUInt32BE(20)!==image.image.height)throw new Error(uiText('tutorialBuild.invalidGraph'));
  }
 }
 const view=readViewState(root,nodeFsOps);if(view.tutorialCardId!==id||view.tutorialEdition!==TUTORIAL_EDITION)throw new Error(uiText('tutorialBuild.invalidGraph'));
 return s.state.cards.size;
}
/** Rebuild only the named tutorial fixture. Generate+verify first; publish under the writer lease. */
export function rebuildTutorialWorkspace(workspace,{replace=false,check=false}={}){
 const target=resolve(workspace);if(basename(target).toLowerCase()!=='kkbtutorial')throw new Error(uiText('tutorialBuild.invalidTarget'));
 if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw new Error(uiText('tutorialBuild.unsafePath'));
 const data=join(target,'.kkb');if(existsSync(data)&&lstatSync(data).isSymbolicLink())throw new Error(uiText('tutorialBuild.unsafePath'));
 const temp=mkdtempSync(join(tmpdir(),'kkb-tutorial-build-')),stage=join(temp,'workspace'),previous=join(temp,'previous');let release,cleanup=true,retainLease=false;
 try{
  const s=openSession(stage,{ops:nodeFsOps,clientId:'codex',builtins:false});s.actor={kind:'ai',id:'codex',name:'Codex'};ensureBuiltins(s);
  const assets=join(stage,'.kkb','assets','images');mkdirSync(assets,{recursive:true});
  for(const asset of Object.values(tutorialAssets))writeFileSync(join(assets,asset.assetId),Buffer.from(asset.base64,'base64'),{flag:'wx'});
  const id=ensureTutorial(s);normalizeBoards(s);const empty=emptyViewState();
  writeViewState(stage,{...empty,tutorialCardId:id,tutorialEdition:TUTORIAL_EDITION,openWindows:[id],windows:{[id]:{...windowViewFor(empty,id),childArea:{width:280,height:180},bounds:{x:120,y:90,width:1060,height:740}}}},nodeFsOps);
  const count=verify(stage,id);const result={workspace:target,rootId:id,cards:count,tutorialCards:tutorialCards.length,edition:TUTORIAL_EDITION,status:check?'checked':'rebuilt'};
  if(check)return result;
  if(existsSync(data)&&readdirSync(data).length&&!replace)throw new Error(uiText('tutorialBuild.notEmpty'));
  mkdirSync(target,{recursive:true});release=acquireWorkspace(target);mkdirSync(previous);
  if(relative(realpathSync(target),realpathSync(data))!=='.kkb')throw new Error(uiText('tutorialBuild.unsafePath'));
  const oldNames=readdirSync(data).filter(name=>name!=='writer.lock'),newData=join(stage,'.kkb'),newNames=readdirSync(newData);const moved=[],installed=[];
  try{
   // The lease stays at its original path; only entries inside the resolved .kkb are moved.
   if(relative(target,resolve(data))!=='.kkb')throw new Error(uiText('tutorialBuild.unsafePath'));
   for(const name of oldNames){renameSync(join(data,name),join(previous,name));moved.push(name);}
   for(const name of newNames){renameSync(join(newData,name),join(data,name));installed.push(name);}
   verify(target,id);ensureTutorialIgnore(target);
  }catch(error){
   try{for(const name of installed.reverse())renameSync(join(data,name),join(newData,name));for(const name of moved)renameSync(join(previous,name),join(data,name));}
   catch(recoveryError){
    cleanup=false;retainLease=true;
    writeFileSync(join(data,'writer.lock','pid'),'tutorial-recovery');
    writeFileSync(join(data,'writer.lock','recovery.json'),JSON.stringify({previous,error:String(error),recoveryError:String(recoveryError)}));
    throw new Error(uiText('tutorialBuild.rollbackFailed',{arg0:temp,arg1:String(error)}));
   }
   throw error;
  }
  return result;
 }finally{
  if(!retainLease)release?.();
  // Recursive cleanup is confined to the exact fresh temporary directory, never the target workspace.
  const parent=resolve(tmpdir()),actual=resolve(temp);if(cleanup&&actual.startsWith(parent+sep)&&basename(actual).startsWith('kkb-tutorial-build-'))rmSync(actual,{recursive:true,force:true});
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),position=args.indexOf('--workspace');
 if(position<0||!args[position+1]||args.some((a,i)=>i!==position+1&&!['--workspace','--replace','--check'].includes(a))||!args.includes('--check')&&!args.includes('--replace'))throw new Error(uiText('tutorialBuild.invalidArgs'));
 console.log(JSON.stringify(rebuildTutorialWorkspace(args[position+1],{replace:args.includes('--replace'),check:args.includes('--check')})));
}
