use serde_json::{json,Value};
use std::{fs,io::{Read,Write},path::{Path,PathBuf,Component},process::{Command,Stdio},thread,time::{Duration,Instant}};
use base64::Engine;
const LIMIT:u64=8*1024*1024;
fn error(key:&str)->String{crate::i18n::text(key,&[])}
fn development_source_repository(root:&Path)->bool{
 cfg!(debug_assertions) && fs::canonicalize(env!("CARGO_MANIFEST_DIR")).is_ok_and(|source|source.starts_with(root))
}
fn ensure_worktree_write_allowed(root:&Path,method:&str)->Result<(),String>{
 if development_source_repository(root) && ["switch","merge","pull","discard","resolve","abortMerge"].contains(&method){return Err(error("git.developmentSourceWarning"));}Ok(())
}
pub fn protected(path:&str)->bool{path.replace('\\',"/").split('/').any(|p|p.eq_ignore_ascii_case(".kkb") || p.eq_ignore_ascii_case(".git"))}
pub fn canonical_directory(root:&Path)->Result<PathBuf,String>{let p=fs::canonicalize(root).map_err(|_|error("git.invalidPath"))?;if !p.is_dir() || p.parent().is_none() || protected(&p.to_string_lossy()){return Err(error("git.invalidPath"));}Ok(p)}
pub fn validate_config(args:&Value,default:&Path)->Result<PathBuf,String>{
 let object=args.as_object().ok_or_else(||error("extensions.invalidConfig"))?;
 if object.keys().any(|k|k!="root") || object.get("root").is_some_and(|r|!r.is_string() || r.as_str().unwrap().trim().is_empty()){return Err(error("extensions.invalidConfig"));}
 canonical_directory(args["root"].as_str().map(Path::new).unwrap_or(default))
}
fn redact(text:&str)->String{
 let mut out=text.to_owned();for word in text.split_whitespace(){if let Some(start)=word.find("://"){if let Some(at)=word[start+3..].find('@'){let secret=&word[start+3..start+3+at];out=out.replace(secret,"***");}}}out
}
fn raw(root:&Path,args:&[String])->Result<(bool,Vec<u8>,String),String>{
 let mut cmd=Command::new("git");
 #[cfg(windows)]{use std::os::windows::process::CommandExt;cmd.creation_flags(0x08000000);}
 cmd.current_dir(root).args(["--no-pager","-c","core.quotepath=false","-c","color.ui=false"]).args(args).env("LC_ALL","C").env("GIT_TERMINAL_PROMPT","0").env("GIT_OPTIONAL_LOCKS","0").env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE").stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
 let mut child=cmd.spawn().map_err(|_|error("git.missingGit"))?;
 let stdout=child.stdout.take().unwrap();let stderr=child.stderr.take().unwrap();
 let a=thread::spawn(move||{let mut v=Vec::new();stdout.take(LIMIT+1).read_to_end(&mut v).map(|_|v)});
 let b=thread::spawn(move||{let mut v=Vec::new();stderr.take(LIMIT+1).read_to_end(&mut v).map(|_|v)});
 let start=Instant::now();let status=loop{match child.try_wait().map_err(|e|e.to_string())?{Some(s)=>break s,None=>{if start.elapsed()>Duration::from_secs(120){child.kill().ok();child.wait().ok();return Err(error("git.timeout"));}thread::sleep(Duration::from_millis(20));}}};
 let stdout=a.join().map_err(|_|error("git.invalid"))?.map_err(|e|e.to_string())?;
 let stderr=b.join().map_err(|_|error("git.invalid"))?.map_err(|e|e.to_string())?;
 if stdout.len() as u64>LIMIT || stderr.len() as u64>LIMIT{return Err(error("git.tooLarge"));}
 Ok((status.success(),stdout,redact(&String::from_utf8_lossy(&stderr))))
}
fn strings(args:&[&str])->Vec<String>{args.iter().map(|v|v.to_string()).collect()}
fn run(root:&Path,args:&[String])->Result<Vec<u8>,String>{let (ok,out,err)=raw(root,args)?;if !ok{return Err(crate::i18n::text("git.operationError",&[("arg0",err.trim().to_owned())]));}Ok(out)}
fn text(root:&Path,args:&[&str])->Result<String,String>{Ok(String::from_utf8_lossy(&run(root,&strings(args))?).trim().to_owned())}
fn strarg<'a>(args:&'a Value,key:&str)->Result<&'a str,String>{let v=args[key].as_str().ok_or_else(||error("git.invalid"))?;if v.is_empty() || v.contains(['\0','\r','\n']) || v.len()>4096{return Err(error("git.invalid"));}Ok(v)}
fn paths(args:&Value)->Result<Vec<String>,String>{let a=args["paths"].as_array().ok_or_else(||error("git.invalid"))?;if a.is_empty() || a.len()>1000{return Err(error("git.invalid"));}a.iter().map(|v|{let p=v.as_str().ok_or_else(||error("git.invalidPath"))?.replace('\\',"/");if p.is_empty() || protected(&p) || p.contains(['\0','\r','\n']) || Path::new(&p).components().any(|c|!matches!(c,Component::Normal(_))){return Err(error("git.invalidPath"));}Ok(p)}).collect()}
fn index_paths(root:&Path,args:&Value)->Result<Vec<String>,String>{
 let mut selected=paths(args)?;let entries=zero_paths(&run(root,&strings(&["status","--porcelain=v1","-z","--untracked-files=all"]))?);let mut i=0;
 while i<entries.len(){let row=&entries[i];i+=1;if row.len()<3 || !row.as_bytes()[..2].is_ascii() || row.as_bytes()[2]!=b' '{return Err(error("git.invalid"));}
  let renamed=row.as_bytes()[..2].contains(&b'R');let copied=row.as_bytes()[..2].contains(&b'C');if !renamed&&!copied{continue;}
  let original=entries.get(i).ok_or_else(||error("git.invalid"))?;i+=1;let current=&row[3..];
  if renamed&&(selected.iter().any(|p|p==current||p==original)){if !selected.iter().any(|p|p==current){selected.push(current.to_owned());}if !selected.contains(original){selected.push(original.clone());}}
 }
 let validated=paths(&json!({"paths":selected}))?;for path in &validated{safe_path(root,path)?;}Ok(validated)
}
fn ensure_expected_repository(args:&Value,directory:&Path,root:&Path)->Result<(),String>{
 if let Some(expected)=args.get("repository"){let path=expected.as_str().ok_or_else(||error("git.invalid"))?;let expected=canonical_directory(Path::new(path))?;if expected!=directory && expected!=root{return Err(error("git.repositoryChanged"));}}
 Ok(())
}
fn ensure_ignore(root:&Path)->Result<(),String>{
 let path=root.join(".gitignore");if path.is_symlink(){return Err(error("git.invalidPath"));}
 let source=if path.exists(){fs::read(&path).map_err(|e|e.to_string())?}else{Vec::new()};
 // Git ignore rules are byte-oriented; legacy comments need not be UTF-8.
 // Decode only for finding our ASCII rule; never re-encode the existing file.
 let mut ignored=false;for line in String::from_utf8_lossy(&source).lines(){let s=line.trim();if [".kkb/","/.kkb/",".kkb","/.kkb"].contains(&s){ignored=true;}if s.starts_with('!') && (s.contains(".kkb") || s=="!*"){ignored=false;}}
 if ignored {ignored=raw(root,&strings(&["check-ignore","--no-index","--quiet","--",".kkb/__kkb_probe__"]))?.0;}
 if !ignored{let mut file=fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e|e.to_string())?;if !source.is_empty() && !source.ends_with(b"\n"){file.write_all(b"\n").map_err(|e|e.to_string())?;}file.write_all(b"\n.kkb/\n").map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;}
 Ok(())
}
fn zero_paths(data:&[u8])->Vec<String>{data.split(|b|*b==0).filter(|v|!v.is_empty()).map(|v|String::from_utf8_lossy(v).into_owned()).collect()}
fn protected_tracked(root:&Path)->Result<Vec<String>,String>{Ok(zero_paths(&run(root,&strings(&["ls-files","-z"]))?).into_iter().filter(|p|protected(p)).collect())}
struct CommitReference {full:String,name:String,object:String}
fn commit_references(root:&Path)->Result<Vec<CommitReference>,String>{
 let output=text(root,&["for-each-ref","--format=%(refname)%00%(refname:short)%00%(objecttype)%00%(*objecttype)%00%(objectname)","refs/heads","refs/remotes","refs/tags"])?;
 let mut refs=Vec::new();
 for line in output.lines(){let fields=line.split('\0').collect::<Vec<_>>();if fields.len()!=5{return Err(error("git.invalid"));}
  let commit=fields[2]=="commit" || (fields[2]=="tag" && fields[3]=="commit") || (fields[2]=="tag" && fields[3]=="tag" && ensure_target_for_read(root,fields[0]).is_ok());
  if commit{refs.push(CommitReference{full:fields[0].to_owned(),name:fields[1].to_owned(),object:fields[4].to_owned()});}
 }
 Ok(refs)
}
fn ensure_push_history(root:&Path,remote:&str)->Result<(),String>{
 // Refresh remote reachability; deletion-only commits may remove already published data,
 // but new commits containing private board content must never be uploaded by KKB.
 run(root,&strings(&["fetch","--prune",remote]))?;
 let history=run(root,&strings(&["log","-m","--full-history","--no-renames","--format=","--name-only","-z","--diff-filter=ACMRTUXB","HEAD","--not",&format!("--remotes={remote}")]))?;
 if zero_paths(&history).iter().any(|p|protected(p.trim_start_matches(['\r','\n']))){return Err(error("git.historyProtected"));}Ok(())
}
fn ensure_target(root:&Path,target:&str)->Result<String,String>{
 if target.starts_with('-') || target.contains(['\0','\r','\n']) || target.len()>256{return Err(error("git.invalid"));}
 let oid=text(root,&["rev-parse","--verify","--end-of-options",&format!("{target}^{{commit}}")])?;
 if zero_paths(&run(root,&strings(&["ls-tree","-r","--name-only","-z",&oid]))?).iter().any(|p|protected(p)){return Err(error("git.targetProtected"));}Ok(oid)
}
fn refname(root:&Path,name:&str)->Result<(),String>{if name.starts_with('-'){return Err(error("git.invalid"));}run(root,&strings(&["check-ref-format","--branch",name]))?;Ok(())}
fn file_bytes(root:&Path,path:&str)->Result<Vec<u8>,String>{
 let p=fs::canonicalize(root.join(path)).map_err(|_|error("git.invalidPath"))?;if !p.starts_with(root) || protected(&p.to_string_lossy()) || fs::metadata(&p).map_err(|e|e.to_string())?.len()>LIMIT{return Err(error("git.invalidPath"));}fs::read(p).map_err(|e|e.to_string())
}
fn safe_path(root:&Path,path:&str)->Result<(),String>{
 let mut candidate=root.join(path);while !candidate.exists(){candidate=candidate.parent().ok_or_else(||error("git.invalidPath"))?.to_path_buf();}
 let actual=fs::canonicalize(&candidate).map_err(|_|error("git.invalidPath"))?;if !actual.starts_with(root) || protected(&actual.to_string_lossy()){return Err(error("git.invalidPath"));}Ok(())
}
fn remove_untracked(root:&Path,entry:&Path,resolved:&Path)->Result<(),String>{
 if !entry.starts_with(root) || !resolved.starts_with(root) || protected(&resolved.to_string_lossy()){return Err(error("git.invalidPath"));}
 fs::remove_file(entry).map_err(|e|e.to_string())
}
fn image(bytes:&[u8],path:&str)->Option<String>{if bytes.is_empty(){return None;}let ext=Path::new(path).extension()?.to_str()?.to_ascii_lowercase();let mime=match ext.as_str(){"png"=>"image/png","jpg"|"jpeg"=>"image/jpeg","webp"=>"image/webp","gif"=>"image/gif",_=>return None};Some(format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes)))}
/// User-requested desktop effects stay in the provider, outside generic scheduling.
pub fn execute_desktop(directory:&Path,method:&str,args:&Value)->Result<Value,String>{
 let value=execute(directory,method,args)?;
 if method=="openFile"{if let Some(path)=value["path"].as_str(){
  let mut cmd=crate::desktop::command(if cfg!(windows){"explorer.exe"}else{"xdg-open"});
  if cfg!(windows) && ["exe","com","bat","cmd","ps1","vbs","js","jse","wsf","lnk","url","msi","scr"].contains(&Path::new(path).extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase().as_str()){cmd.arg("/select,");}
  cmd.arg(path).spawn().map_err(|e|crate::i18n::text("git.operationError",&[("arg0",e.to_string())]))?;
 }}
 Ok(value)
}
pub fn execute(directory:&Path,method:&str,args:&Value)->Result<Value,String>{
 let directory=canonical_directory(directory)?;
 if method=="init"{ensure_expected_repository(args,&directory,&directory)?;run(&directory,&strings(&["init","-b","main"]))?;ensure_ignore(&directory)?;return Ok(json!({"initialized":true}));}
 if method=="clone"{ensure_expected_repository(args,&directory,&directory)?;let url=strarg(args,"url")?;validate_url(url)?;if fs::read_dir(&directory).map_err(|e|e.to_string())?.next().is_some(){return Err(error("git.invalidPath"));}run(&directory,&strings(&["clone","--",url,"."]))?;ensure_ignore(&directory)?;return Ok(json!({"cloned":true}));}
 let (ok,out,diagnostic)=raw(&directory,&strings(&["rev-parse","--show-toplevel"]))?;
 if !ok{
  let marker=directory.ancestors().any(|p|fs::symlink_metadata(p.join(".git")).is_ok());
  if !marker && diagnostic.contains("not a git repository"){if method=="status"{return Ok(json!({"repository":false,"root":crate::desktop::display_path(&directory)}));}return Err(error("git.noRepo"));}
  return Err(crate::i18n::text("git.repositoryProbeFailed",&[("arg0",crate::desktop::display_path(&directory)),("arg1",diagnostic.trim().to_owned())]));
 }
 let root=canonical_directory(Path::new(String::from_utf8_lossy(&out).trim()))?;ensure_expected_repository(args,&directory,&root)?;ensure_worktree_write_allowed(&root,method)?;ensure_ignore(&root)?;
 if directory!=root && directory.join(".kkb").exists(){ensure_ignore(&directory)?;}
 let protected_files=protected_tracked(&root)?;
 if let Some(list)=args["paths"].as_array(){for path in list{if let Some(path)=path.as_str(){safe_path(&root,path)?;}}}
 let readonly=["status","graph","commitDetail","diff","compare","openFile"];
 if !readonly.contains(&method) && method!="untrackKkb" && !protected_files.is_empty(){return Err(error("git.protectedError"));}
 match method {
 "status"=>{
  let wire=run(&root,&strings(&["status","--porcelain=v1","-z","--branch","--untracked-files=all"]))?;
  let chunks=zero_paths(&wire);let mut files=Vec::new();let mut i=0;
  while i<chunks.len(){let row=&chunks[i];i+=1;if row.starts_with("##"){continue;}if row.len()<3 || !row.as_bytes()[..2].is_ascii() || row.as_bytes()[2]!=b' '{return Err(error("git.invalid"));}
   let index=&row[0..1];let worktree=&row[1..2];let path=row[3..].to_owned();let renamed=index=="R" || index=="C" || worktree=="R" || worktree=="C";let original=if renamed{let p=chunks.get(i).cloned();i+=1;p}else{None};
   if protected(&path) || original.as_ref().is_some_and(|p|protected(p)){continue;}
   let conflict=["DD","AU","UD","UA","DU","AA","UU"].contains(&&row[..2]);files.push(json!({"path":path,"original":original,"index":index,"worktree":worktree,"conflict":conflict}));
  }
  let branch=text(&root,&["branch","--show-current"])?;
  let refs=commit_references(&root)?;
  let remotes=text(&root,&["remote"])?;
  let upstream=text(&root,&["rev-parse","--abbrev-ref","--symbolic-full-name","@{upstream}"]).unwrap_or_default();
  let counts=text(&root,&["rev-list","--left-right","--count","HEAD...@{upstream}"]).unwrap_or_default();let mut counts=counts.split_whitespace();let ahead=counts.next().unwrap_or("0").parse::<u64>().unwrap_or(0);let behind=counts.next().unwrap_or("0").parse::<u64>().unwrap_or(0);
  let merge_file=text(&root,&["rev-parse","--git-path","MERGE_HEAD"])?;let merging=root.join(merge_file).exists();
  let head=text(&root,&["rev-parse","--verify","HEAD"]).unwrap_or_default();let refs_state=refs.iter().map(|r|format!("{} {}",r.full,r.object)).collect::<Vec<_>>().join("\n");
  Ok(json!({"repository":true,"root":crate::desktop::display_path(&root),"developmentSource":development_source_repository(&root),"branch":branch,"head":head,"refsState":refs_state,"files":files,"refs":refs.iter().map(|r|&r.name).collect::<Vec<_>>(),"remotes":remotes.lines().collect::<Vec<_>>(),"upstream":upstream,"ahead":ahead,"behind":behind,"merging":merging,"protectedFiles":protected_files}))
 },
 "graph"=>{
  let offset=args["offset"].as_u64().unwrap_or(0);if offset>100000{return Err(error("git.invalid"));}
  let count=args["limit"].as_u64().unwrap_or(60).clamp(1,200);
  let mut starts=commit_references(&root)?.into_iter().map(|r|r.full).collect::<Vec<_>>();if let Ok(head)=ensure_target_for_read(&root,"HEAD"){starts.push(head);}
  if starts.is_empty(){return Ok(json!({"commits":[],"nextOffset":null}));}
  let mut command=strings(&["log","--topo-order",&format!("--skip={offset}"),&format!("-{}",count+1),"--decorate=short","--decorate-refs=HEAD","--decorate-refs=refs/heads/*","--decorate-refs=refs/remotes/*","--decorate-refs=refs/tags/*","--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D%x00"]);command.extend(starts);command.push("--".into());let out=run(&root,&command)?;
  let cells=out.split(|b|*b==0).collect::<Vec<_>>();let mut commits=Vec::new();for row in cells.chunks(6){if row.len()<6{break;}let s=|n:usize|String::from_utf8_lossy(row[n]).trim_start_matches(['\r','\n']).to_owned();commits.push(json!({"id":s(0),"parents":s(1).split_whitespace().collect::<Vec<_>>(),"author":s(2),"date":s(3),"subject":s(4),"refs":s(5)}));}
  let more=commits.len()>count as usize;commits.truncate(count as usize);Ok(json!({"commits":commits,"nextOffset":if more{Some(offset+count)}else{None}}))
 },
 "commitDetail"=>{let oid=ensure_target_for_read(&root,strarg(args,"ref")?)?;let description=text(&root,&["show","-s","--format=%B",&oid])?;let wire=run(&root,&strings(&["diff-tree","--root","-m","--no-commit-id","--name-only","-r","-z",&oid]))?;let mut files=zero_paths(&wire).into_iter().filter(|p|!protected(p)).collect::<Vec<_>>();files.sort();files.dedup();Ok(json!({"id":oid,"description":description,"files":files}))},
 "diff"=>{
  let path=strarg(args,"path")?.to_owned();paths(&json!({"paths":[path.clone()]}))?;let staged=args["staged"]==true;
  let reference=args["ref"].as_str().map(|r|ensure_target_for_read(&root,r)).transpose()?;
  let mut cmd=strings(&["diff","--no-ext-diff","--no-textconv"]);
  if let Some(ref oid)=reference{let parents=text(&root,&["show","-s","--format=%P",oid])?;if let Some(parent)=parents.split_whitespace().next(){cmd.push(parent.to_owned());cmd.push(oid.clone());}else{cmd=strings(&["show","--format=","--no-ext-diff","--no-textconv",oid]);}}else if staged{cmd.push("--cached".into());}
  cmd.extend(strings(&["--",&format!(":(literal){path}")]));let patch=String::from_utf8_lossy(&run(&root,&cmd)?).into_owned();
  let before_ref=if let Some(ref oid)=reference{text(&root,&["show","-s","--format=%P",oid]).unwrap_or_default().split_whitespace().next().unwrap_or("").to_owned()}else if staged{"HEAD".to_owned()}else{String::new()};
  let before_spec=if before_ref.is_empty(){format!(":{path}")}else{format!("{before_ref}:{path}")};let before=if reference.is_some() && before_ref.is_empty(){Vec::new()}else{run(&root,&strings(&["show",&before_spec])).unwrap_or_default()};
  let after=if let Some(ref oid)=reference{run(&root,&strings(&["show",&format!("{oid}:{path}")])).unwrap_or_default()}else if staged{run(&root,&strings(&["show",&format!(":{path}")])).unwrap_or_default()}else{file_bytes(&root,&path).unwrap_or_default()};
  let binary=before.contains(&0) || after.contains(&0);let preview=if patch.is_empty() && !binary{String::from_utf8_lossy(&after).to_string()}else{patch};
  Ok(json!({"text":preview,"binary":binary,"beforeImage":image(&before,&path),"afterImage":image(&after,&path)}))
 },
 "compare"=>{let a=ensure_target_for_read(&root,strarg(args,"base")?)?;let b=ensure_target_for_read(&root,strarg(args,"tip")?)?;Ok(json!({"text":text(&root,&["diff","--no-ext-diff","--no-textconv",&a,&b,"--",".",":(exclude,icase,glob)**/.kkb/**",":(exclude,icase).kkb/**"])?}))},
 "stage"|"unstage"=>{let p=if method=="unstage"{index_paths(&root,args)?}else{paths(args)?};let mut cmd=if method=="stage"{strings(&["add","--"])}else if text(&root,&["rev-parse","--verify","HEAD"]).is_ok(){strings(&["reset","--quiet","HEAD","--"])}else{strings(&["rm","--cached","--ignore-unmatch","--"])};cmd.extend(p.iter().map(|p|format!(":(literal){p}")));run(&root,&cmd)?;Ok(json!({"changed":true}))},
 "stageAll"=>{let all=zero_paths(&run(&root,&strings(&["ls-files","-z","--cached","--others","--exclude-standard"]))?).into_iter().filter(|p|!protected(p)).collect::<Vec<_>>();for batch in all.chunks(64){let mut cmd=strings(&["add","-A","--"]);cmd.extend(batch.iter().map(|p|format!(":(literal){p}")));run(&root,&cmd)?;}Ok(json!({"changed":true}))},
 "unstageAll"=>{if text(&root,&["rev-parse","--verify","HEAD"]).is_ok(){run(&root,&strings(&["reset","--quiet","HEAD","--",".",":(exclude,icase,glob)**/.kkb/**",":(exclude,icase).kkb/**"]))?;}else{let all=zero_paths(&run(&root,&strings(&["ls-files","-z"]))?).into_iter().filter(|p|!protected(p)).collect::<Vec<_>>();if !all.is_empty(){let mut cmd=strings(&["rm","--cached","--ignore-unmatch","--"]);cmd.extend(all.iter().map(|p|format!(":(literal){p}")));run(&root,&cmd)?;}}Ok(json!({"changed":true}))},
 "commit"=>{let message=args["message"].as_str().ok_or_else(||error("git.invalid"))?;if message.contains('\0') || message.len()>100000 || message.trim().is_empty(){return Err(error("git.invalid"));}let staged=zero_paths(&run(&root,&strings(&["diff","--cached","--name-only","-z"]))?);if staged.is_empty(){return Err(error("git.noStaged"));}let additions=zero_paths(&run(&root,&strings(&["diff","--cached","--diff-filter=ACMRTUXB","--name-only","-z"]))?);if additions.iter().any(|p|protected(p)){return Err(error("git.protectedError"));}let out=text(&root,&["commit","-m",message])?;Ok(json!({"output":out}))},
 "branch"=>{let name=strarg(args,"name")?;refname(&root,name)?;let mut command=strings(&["branch",name]);if let Some(from)=args["from"].as_str(){command.push(ensure_target_for_read(&root,from)?);}run(&root,&command)?;Ok(json!({"changed":true}))},
 "switch"|"merge"=>{let target=strarg(args,"ref")?;let oid=ensure_target(&root,target)?;ensure_clean(&root)?;if method=="switch"{if text(&root,&["show-ref","--verify",&format!("refs/heads/{target}")]).is_ok(){run(&root,&strings(&["switch","--",target]))?;}else if text(&root,&["show-ref","--verify",&format!("refs/remotes/{target}")]).is_ok(){let name=target.split_once('/').ok_or_else(||error("git.invalid"))?.1;refname(&root,name)?;if text(&root,&["show-ref","--verify",&format!("refs/heads/{name}")]).is_ok(){return Err(error("git.localBranchExists"));}run(&root,&strings(&["switch","--track","-c",name,"--",target]))?;}else{run(&root,&strings(&["switch","--detach",&oid]))?;}Ok(json!({"changed":true}))}else{let (ok,out,stderr)=raw(&root,&strings(&["merge","--no-edit",&oid]))?;let conflicts=run(&root,&strings(&["diff","--name-only","--diff-filter=U"])).unwrap_or_default();if !ok && conflicts.is_empty(){return Err(redact(&stderr));}Ok(json!({"changed":true,"conflicts":!conflicts.is_empty(),"output":String::from_utf8_lossy(&out)}))}},
 "fetch"|"push"|"pull"=>{let remote=args["remote"].as_str().unwrap_or("origin");if remote.starts_with('-') || remote.contains(['\0','\r','\n']){return Err(error("git.invalid"));}if method=="fetch"{run(&root,&strings(&["fetch","--prune",remote]))?;}else if method=="push"{let branch=text(&root,&["branch","--show-current"])?;refname(&root,&branch)?;ensure_push_history(&root,remote)?;run(&root,&strings(&["push","--set-upstream",remote,&branch]))?;}else{ensure_clean(&root)?;run(&root,&strings(&["fetch",remote]))?;let target=text(&root,&["rev-parse","--abbrev-ref","--symbolic-full-name","@{upstream}"])?;let oid=ensure_target(&root,&target)?;run(&root,&strings(&["merge","--ff-only",&oid]))?;}Ok(json!({"changed":true}))},
 "addRemote"=>{let name=strarg(args,"name")?;if !name.bytes().all(|b|b.is_ascii_alphanumeric() || b"._-".contains(&b)) || name.starts_with('-'){return Err(error("git.invalid"));}let url=strarg(args,"url")?;validate_url(url)?;run(&root,&strings(&["remote","add",name,url]))?;Ok(json!({"changed":true}))},
 "resolve"=>{let p=paths(args)?;let side=strarg(args,"side")?;if !["ours","theirs","edited"].contains(&side){return Err(error("git.invalid"));}if side!="edited" && args["confirmed"]!=true{return Err(error("git.invalid"));}for path in &p{let conflicts=run(&root,&strings(&["ls-files","-u","-z","--",&format!(":(literal){path}")]))?;if conflicts.is_empty(){return Err(error("git.invalid"));}if side=="edited"{if let Ok(bytes)=file_bytes(&root,path){if String::from_utf8_lossy(&bytes).lines().any(|l|l.starts_with("<<<<<<< ") || l.starts_with(">>>>>>> ")){return Err(error("git.markers"));}}}else{let stages=zero_paths(&run(&root,&strings(&["ls-files","-u","-z","--",&format!(":(literal){path}")]))?);let stage=if side=="ours"{"2"}else{"3"};if stages.iter().any(|l|l.split_once('\t').is_some_and(|(meta,_)|meta.ends_with(stage))){run(&root,&strings(&["checkout",&format!("--{side}"),"--",&format!(":(literal){path}")]))?;}else{let candidate=root.join(path);if candidate.exists(){if fs::canonicalize(&candidate).map_err(|_|error("git.invalidPath"))?.starts_with(&root){fs::remove_file(candidate).map_err(|e|e.to_string())?;}else{return Err(error("git.invalidPath"));}}}}run(&root,&strings(&["add","-A","--",&format!(":(literal){path}")]))?;}Ok(json!({"resolved":true}))},
 "continueMerge"=>{let merging=text(&root,&["rev-parse","--git-path","MERGE_HEAD"])?;if !root.join(merging).exists(){return Err(error("git.notMerge"));}run(&root,&strings(&["commit","--no-edit"]))?;Ok(json!({"changed":true}))},
 "abortMerge"=>{if args["confirmed"]!=true{return Err(error("git.invalid"));}run(&root,&strings(&["merge","--abort"]))?;Ok(json!({"changed":true}))},
 "discard"=>{if args["confirmed"]!=true{return Err(error("git.invalid"));}let p=paths(args)?;for path in p{let tracked=run(&root,&strings(&["ls-files","--error-unmatch","--",&format!(":(literal){path}")])).is_ok();if tracked{run(&root,&strings(&["restore","--worktree","--",&format!(":(literal){path}")]))?;}else{let candidate=fs::canonicalize(root.join(&path)).map_err(|_|error("git.invalidPath"))?;remove_untracked(&root,&root.join(&path),&candidate)?;}}Ok(json!({"changed":true}))},
 "untrackKkb"=>{if args["confirmed"]!=true{return Err(error("git.invalid"));}if !protected_files.is_empty(){let mut cmd=strings(&["rm","--cached","-r","--"]);cmd.extend(protected_files.iter().map(|p|format!(":(literal){p}")));run(&root,&cmd)?;}Ok(json!({"untracked":protected_files.len()}))},
 "openFile"=>{let p=paths(&json!({"paths":[strarg(args,"path")?]}))?;let path=fs::canonicalize(root.join(&p[0])).map_err(|_|error("git.invalidPath"))?;if !path.starts_with(&root) || protected(&path.to_string_lossy()){return Err(error("git.invalidPath"));}Ok(json!({"path":path.to_string_lossy()}))},
 _=>Err(error("git.invalid"))
 }
}
fn ensure_target_for_read(root:&Path,target:&str)->Result<String,String>{if target.starts_with('-') || target.contains(['\0','\r','\n']){return Err(error("git.invalid"));}text(root,&["rev-parse","--verify","--end-of-options",&format!("{target}^{{commit}}")])}
fn ensure_clean(root:&Path)->Result<(),String>{let status=run(root,&strings(&["status","--porcelain","--untracked-files=all","--",".",":(exclude,icase,glob)**/.kkb/**",":(exclude,icase).kkb/**"]))?;if !status.is_empty(){return Err(error("git.dirty"));}Ok(())}
fn validate_url(url:&str)->Result<(),String>{if url.starts_with('-') || url.contains(['\0','\r','\n']){return Err(error("git.invalid"));}if let Some(start)=url.find("://"){if let Some(at)=url[start+3..].find('@'){if !url[..start].eq_ignore_ascii_case("ssh") || url[start+3..start+3+at].contains(':'){return Err(error("git.credentialUrl"));}}}Ok(())}

#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn stale_window_cannot_discard_a_file_in_another_repository(){
  let first=fixture();let second=fixture();execute(&first,"init",&json!({})).unwrap();execute(&second,"init",&json!({})).unwrap();fs::write(second.join("same.txt"),"keep this repository").unwrap();
  let result=execute(&second,"discard",&json!({"repository":first.to_string_lossy(),"paths":["same.txt"],"confirmed":true}));assert!(result.is_err(),"a window bound to another repository must not write here");assert_eq!(fs::read_to_string(second.join("same.txt")).unwrap(),"keep this repository");for p in [first,second]{fs::remove_dir_all(p).unwrap();}
 }
 #[test] fn unstaging_a_rename_restores_both_index_paths_and_keeps_the_working_file(){
  let p=fixture();execute(&p,"init",&json!({})).unwrap();git(&p,&["config","user.name","Test"]);git(&p,&["config","user.email","test@example.invalid"]);fs::write(p.join("before.txt"),"content").unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"commit",&json!({"message":"Base"})).unwrap();git(&p,&["mv","before.txt","after.txt"]);
  execute(&p,"unstage",&json!({"paths":["after.txt"]})).unwrap();assert!(text(&p,&["diff","--cached","--name-only"]).unwrap().is_empty(),"unstaging a rename must not leave the original path staged as deleted");assert_eq!(fs::read_to_string(p.join("after.txt")).unwrap(),"content");assert!(!p.join("before.txt").exists());fs::remove_dir_all(p).unwrap();
 }
 #[test] fn development_source_worktree_changes_are_blocked_without_blocking_staging(){
  let source=canonical_directory(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap()).unwrap();
  for method in ["switch","merge","pull","discard","resolve","abortMerge"]{assert_eq!(ensure_worktree_write_allowed(&source,method).is_err(),cfg!(debug_assertions),"development source guard for {method}");}
  for method in ["status","graph","stage","unstage","stageAll","unstageAll","commit","fetch","push"]{assert!(ensure_worktree_write_allowed(&source,method).is_ok());}
  let p=fixture();assert!(ensure_worktree_write_allowed(&canonical_directory(&p).unwrap(),"switch").is_ok());fs::remove_dir_all(p).unwrap();
 }
 #[test] fn non_utf8_ignore_comments_do_not_break_stage_unstage_or_discard(){
  let p=fixture();git(&p,&["init","-b","main"]);let ignore=b"# legacy comment \xff\n.kkb/\n";fs::write(p.join(".gitignore"),ignore).unwrap();fs::write(p.join("new.txt"),"keep until discarded").unwrap();
  execute(&p,"stage",&json!({"paths":["new.txt"]})).unwrap();execute(&p,"unstage",&json!({"paths":["new.txt"]})).unwrap();assert_eq!(fs::read_to_string(p.join("new.txt")).unwrap(),"keep until discarded");execute(&p,"discard",&json!({"paths":["new.txt"],"confirmed":true})).unwrap();assert!(!p.join("new.txt").exists());assert_eq!(fs::read(p.join(".gitignore")).unwrap(),ignore);fs::remove_dir_all(p).unwrap();
 }
 #[test] fn only_public_commit_references_are_listed_and_graphed(){
  let p=fixture();execute(&p,"init",&json!({})).unwrap();git(&p,&["config","user.name","Test"]);git(&p,&["config","user.email","test@example.invalid"]);fs::write(p.join("project"),"base").unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"commit",&json!({"message":"Public base"})).unwrap();
  let tree=text(&p,&["rev-parse","HEAD^{tree}"]).unwrap();git(&p,&["update-ref","refs/codex/checkpoint-tree",&tree]);git(&p,&["update-ref","refs/codex/checkpoint-commit","HEAD"]);git(&p,&["tag","tree-only",&tree]);git(&p,&["tag","release"]);git(&p,&["tag","-a","annotated","-m","Release"]);
  git(&p,&["switch","--detach"]);fs::write(p.join("private-checkpoint"),"internal").unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"commit",&json!({"message":"Internal checkpoint"})).unwrap();git(&p,&["update-ref","refs/codex/private","HEAD"]);git(&p,&["switch","main"]);
  let status=execute(&p,"status",&json!({})).unwrap();let refs=status["refs"].as_array().unwrap();assert!(!refs.iter().any(|r|r.as_str().unwrap().starts_with("codex/") || r=="tree-only"),"internal/noncommit references leaked into UI: {refs:?}");assert!(refs.iter().any(|r|r=="release"));assert!(refs.iter().any(|r|r=="annotated"));
  let graph=execute(&p,"graph",&json!({})).unwrap();assert_eq!(graph["commits"].as_array().unwrap().len(),1);assert!(!graph["commits"][0]["refs"].as_str().unwrap().contains("codex"));assert_eq!(text(&p,&["rev-parse","refs/codex/checkpoint-tree"]).unwrap(),tree);fs::remove_dir_all(p).unwrap();
 }
 #[test] fn invalid_existing_repository_reports_its_error_instead_of_claiming_no_repository(){
  let p=fixture();fs::write(p.join(".git"),"invalid git marker").unwrap();let result=execute(&p,"status",&json!({}));assert!(result.is_err(),"existing repository errors must not be swallowed: {result:?}");fs::remove_dir_all(p).unwrap();
 }
 #[test] fn web_remote_urls_cannot_embed_access_tokens(){
  assert!(validate_url("https://private_token@example.invalid/repo.git").is_err());assert!(validate_url("https://user:password@example.invalid/repo.git").is_err());assert!(validate_url("ssh://git@example.invalid/repo.git").is_ok());assert!(validate_url("git@example.invalid:repo.git").is_ok());assert!(validate_url("https://example.invalid/repo.git").is_ok());
 }
 #[test] fn discard_removes_requested_entry_instead_of_the_validated_target(){
  let p=fixture();let root=canonical_directory(&p).unwrap();let entry=root.join("entry");let target=root.join("target");fs::write(&entry,"link representation").unwrap();fs::write(&target,"keep").unwrap();remove_untracked(&root,&entry,&target).unwrap();assert_eq!(fs::read_to_string(&target).unwrap(),"keep");assert!(!entry.exists());fs::remove_dir_all(p).unwrap();
 }
 #[test] fn unstage_discard_and_tracking_branch_switch_preserve_board_data(){
  let remote=fixture();git(&remote,&["init","--bare","-b","main"]);let p=fixture();execute(&p,"init",&json!({})).unwrap();git(&p,&["config","core.autocrlf","false"]);git(&p,&["config","user.name","Test"]);git(&p,&["config","user.email","test@example.invalid"]);fs::create_dir(p.join(".kkb")).unwrap();fs::write(p.join(".kkb/keep"),"private").unwrap();fs::write(p.join("file.txt"),"base").unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"unstageAll",&json!({})).unwrap();assert!(text(&p,&["ls-files"]).unwrap().is_empty());execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"commit",&json!({"message":"Base"})).unwrap();
  fs::write(p.join("file.txt"),"changed").unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"unstageAll",&json!({})).unwrap();assert!(text(&p,&["diff","--cached"]).unwrap().is_empty());execute(&p,"discard",&json!({"paths":["file.txt"],"confirmed":true})).unwrap();assert_eq!(fs::read_to_string(p.join("file.txt")).unwrap(),"base");assert!(execute(&p,"discard",&json!({"paths":[".kkb/keep"],"confirmed":true})).is_err());assert!(execute(&p,"stage",&json!({"paths":["../outside"]})).is_err());
  execute(&p,"addRemote",&json!({"name":"origin","url":remote.to_string_lossy()})).unwrap();execute(&p,"push",&json!({})).unwrap();execute(&p,"branch",&json!({"name":"feature"})).unwrap();git(&p,&["push","origin","feature"]);let q=fixture();execute(&q,"clone",&json!({"url":remote.to_string_lossy()})).unwrap();execute(&q,"switch",&json!({"ref":"origin/feature"})).unwrap();assert_eq!(text(&q,&["branch","--show-current"]).unwrap(),"feature");assert_eq!(fs::read_to_string(p.join(".kkb/keep")).unwrap(),"private");for dir in [remote,p,q]{fs::remove_dir_all(dir).unwrap();}
 }
 #[test] fn detached_commit_is_in_graph_and_root_image_has_no_before_image(){
  let p=fixture();execute(&p,"init",&json!({})).unwrap();git(&p,&["config","user.name","Test"]);git(&p,&["config","user.email","test@example.invalid"]);fs::write(p.join("image.png"),b"\x89PNG\0example").unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"commit",&json!({"message":"Root"})).unwrap();
  let diff=execute(&p,"diff",&json!({"path":"image.png","ref":"HEAD"})).unwrap();assert!(diff["beforeImage"].is_null(),"a root commit has no previous image");assert!(diff["afterImage"].is_string());
  git(&p,&["switch","--detach"]);fs::write(p.join("note"),"detached").unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"commit",&json!({"message":"Detached"})).unwrap();let head=text(&p,&["rev-parse","HEAD"]).unwrap();let graph=execute(&p,"graph",&json!({})).unwrap();assert!(graph["commits"].as_array().unwrap().iter().any(|c|c["id"]==head));fs::remove_dir_all(p).unwrap();
 }
 #[test] fn configuration_rejects_unknown_keys_and_non_string_roots(){
  let p=fixture();assert!(validate_config(&json!({"root":12}),&p).is_err());assert!(validate_config(&json!({"unexpected":true}),&p).is_err());assert!(validate_config(&json!([]),&p).is_err());assert_eq!(validate_config(&json!({}),&p).unwrap(),canonical_directory(&p).unwrap());fs::remove_dir_all(p).unwrap();
 }
 #[test] fn untracked_kkb_history_cannot_be_pushed_to_a_new_remote(){
  let remote=fixture();git(&remote,&["init","--bare","-b","main"]);let p=fixture();execute(&p,"init",&json!({})).unwrap();git(&p,&["config","user.name","Test"]);git(&p,&["config","user.email","test@example.invalid"]);
  fs::create_dir(p.join(".kkb")).unwrap();fs::write(p.join(".kkb/secret"),"private").unwrap();git(&p,&["add","-f",".kkb/secret"]);git(&p,&["commit","-m","Old private data"]);
  execute(&p,"untrackKkb",&json!({"confirmed":true})).unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"commit",&json!({"message":"Exclude"})).unwrap();execute(&p,"addRemote",&json!({"name":"origin","url":remote.to_string_lossy()})).unwrap();
  assert!(execute(&p,"push",&json!({})).is_err(),"untracking must not leak earlier private commits");assert!(text(&remote,&["rev-parse","--verify","refs/heads/main"]).is_err());assert_eq!(fs::read_to_string(p.join(".kkb/secret")).unwrap(),"private");for dir in [remote,p]{fs::remove_dir_all(dir).unwrap();}
 }
 fn fixture()->PathBuf{static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);let p=std::env::temp_dir().join(format!("kkb-git-{}-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)));fs::create_dir_all(&p).unwrap();p}
 fn git(p:&Path,args:&[&str]){let output=Command::new("git").current_dir(p).args(args).output().unwrap();assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));}
 #[test] fn initialize_stage_commit_graph_excludes_all_kkb_data(){let p=fixture();let result=execute(&p,"init",&json!({}));assert!(result.is_ok(),"{result:?}");git(&p,&["config","core.autocrlf","false"]);git(&p,&["config","user.name","Test"]);git(&p,&["config","user.email","test@example.invalid"]);fs::create_dir(p.join(".kkb")).unwrap();fs::write(p.join(".kkb/private.txt"),"private").unwrap();fs::write(p.join("hello.txt"),"hello").unwrap();execute(&p,"stage",&json!({"paths":["hello.txt",".gitignore"]})).unwrap();execute(&p,"commit",&json!({"message":"First"})).unwrap();let graph=execute(&p,"graph",&json!({})).unwrap();assert_eq!(graph["commits"].as_array().unwrap().len(),1);assert!(execute(&p,"stage",&json!({"paths":[".kkb/private.txt"]})).is_err());let out=Command::new("git").current_dir(&p).args(["ls-files"]).output().unwrap();assert!(!String::from_utf8_lossy(&out.stdout).contains(".kkb"));fs::remove_dir_all(p).unwrap();}
 #[test] fn tracked_kkb_blocks_writes_and_untracking_keeps_disk_file(){let p=fixture();git(&p,&["init","-b","main"]);git(&p,&["config","core.autocrlf","false"]);git(&p,&["config","user.name","Test"]);git(&p,&["config","user.email","test@example.invalid"]);fs::create_dir(p.join(".kkb")).unwrap();fs::write(p.join(".kkb/private.txt"),"private").unwrap();git(&p,&["add","-f",".kkb/private.txt"]);git(&p,&["commit","-m","Old"]);assert!(execute(&p,"commit",&json!({"message":"No"})).is_err());execute(&p,"untrackKkb",&json!({"confirmed":true})).unwrap();assert_eq!(fs::read_to_string(p.join(".kkb/private.txt")).unwrap(),"private");execute(&p,"stage",&json!({"paths":[".gitignore"]})).unwrap();execute(&p,"commit",&json!({"message":"Exclude"})).unwrap();assert!(execute(&p,"switch",&json!({"ref":"HEAD~1"})).is_err());fs::remove_dir_all(p).unwrap();}
 #[test] fn resolving_a_stale_nonconflict_must_not_delete_the_file(){let p=fixture();execute(&p,"init",&json!({})).unwrap();fs::write(p.join("file.txt"),"keep").unwrap();let result=execute(&p,"resolve",&json!({"paths":["file.txt"],"side":"ours","confirmed":true}));assert!(result.is_err());assert_eq!(fs::read_to_string(p.join("file.txt")).unwrap(),"keep");fs::remove_dir_all(p).unwrap();}
 #[test] fn divergent_branches_merge_and_resolve_without_touching_kkb(){let p=fixture();execute(&p,"init",&json!({})).unwrap();git(&p,&["config","core.autocrlf","false"]);git(&p,&["config","user.name","Test"]);git(&p,&["config","user.email","test@example.invalid"]);fs::write(p.join("file.txt"),"base\n").unwrap();fs::create_dir(p.join(".kkb")).unwrap();fs::write(p.join(".kkb/private"),"secret").unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"commit",&json!({"message":"Base"})).unwrap();execute(&p,"branch",&json!({"name":"feature"})).unwrap();execute(&p,"switch",&json!({"ref":"feature"})).unwrap();fs::write(p.join("file.txt"),"feature\n").unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"commit",&json!({"message":"Feature\n\nDetails"})).unwrap();execute(&p,"switch",&json!({"ref":"main"})).unwrap();fs::write(p.join("file.txt"),"main\n").unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"commit",&json!({"message":"Main"})).unwrap();assert_eq!(execute(&p,"merge",&json!({"ref":"feature"})).unwrap()["conflicts"],true);assert!(execute(&p,"resolve",&json!({"paths":["file.txt"],"side":"edited"})).is_err());execute(&p,"resolve",&json!({"paths":["file.txt"],"side":"ours","confirmed":true})).unwrap();execute(&p,"continueMerge",&json!({})).unwrap();assert_eq!(fs::read_to_string(p.join("file.txt")).unwrap(),"main\n");assert_eq!(fs::read_to_string(p.join(".kkb/private")).unwrap(),"secret");assert_eq!(execute(&p,"graph",&json!({})).unwrap()["commits"][0]["parents"].as_array().unwrap().len(),2);fs::remove_dir_all(p).unwrap();}
 #[test] fn local_remote_clone_push_pull_roundtrip(){let remote=fixture();git(&remote,&["init","--bare","-b","main"]);let p=fixture();execute(&p,"init",&json!({})).unwrap();git(&p,&["config","core.autocrlf","false"]);git(&p,&["config","user.name","Test"]);git(&p,&["config","user.email","test@example.invalid"]);fs::write(p.join("file.txt"),"first").unwrap();execute(&p,"stageAll",&json!({})).unwrap();execute(&p,"commit",&json!({"message":"First"})).unwrap();execute(&p,"addRemote",&json!({"name":"origin","url":remote.to_string_lossy()})).unwrap();execute(&p,"push",&json!({})).unwrap();let q=fixture();execute(&q,"clone",&json!({"url":remote.to_string_lossy()})).unwrap();git(&q,&["config","core.autocrlf","false"]);git(&q,&["config","user.name","Test"]);git(&q,&["config","user.email","test@example.invalid"]);fs::write(q.join("file.txt"),"second").unwrap();execute(&q,"stageAll",&json!({})).unwrap();execute(&q,"commit",&json!({"message":"Second"})).unwrap();execute(&q,"push",&json!({})).unwrap();execute(&p,"pull",&json!({})).unwrap();assert_eq!(fs::read_to_string(p.join("file.txt")).unwrap(),"second");assert_eq!(execute(&p,"graph",&json!({})).unwrap()["commits"].as_array().unwrap().len(),2);for dir in [remote,p,q]{fs::remove_dir_all(dir).unwrap();}}

}
