use std::{fs,path::{Path,PathBuf,Component},io::Read};
use serde_json::{json,Value};
use base64::Engine;
use tauri::Manager;
fn invalid()->String{crate::i18n::text("themes.invalid",&[])}
fn seed(root:&Path)->Result<(),String>{
 fs::create_dir_all(root).map_err(|e|e.to_string())?;
 for (name,source) in [("paper.css",include_str!("../../src/themes/paper.css")),("paper-dark.css",include_str!("../../src/themes/paper-dark.css")),("lightmind.css",include_str!("../../src/themes/lightmind.css"))]{
  match fs::OpenOptions::new().write(true).create_new(true).open(root.join(name)){Ok(mut file)=>{use std::io::Write;file.write_all(source.as_bytes()).map_err(|e|e.to_string())?;},Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(e)=>return Err(e.to_string())}
 }Ok(())
}
fn directory(app:&tauri::AppHandle)->Result<PathBuf,String>{let root=app.path().app_data_dir().map_err(|e|e.to_string())?.join("themes");seed(&root)?;Ok(root)}
fn bounded_read(path:&Path,limit:u64)->Result<Vec<u8>,String>{let mut bytes=Vec::new();fs::File::open(path).map_err(|e|e.to_string())?.take(limit+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;if bytes.len() as u64>limit{return Err(crate::i18n::text("themes.tooLarge",&[]));}Ok(bytes)}
fn read_asset(root:&Path,relative:&str)->Result<Value,String>{
 let path=Path::new(relative);if relative.contains(['\\',':','\0'])||!path.components().all(|c|matches!(c,Component::Normal(_))){return Err(invalid());}
 let base=fs::canonicalize(root).map_err(|e|e.to_string())?;let path=root.join(path);if !path.exists(){return Ok(Value::Null);}
 let path=fs::canonicalize(path).map_err(|e|e.to_string())?;if !path.starts_with(&base)||!path.is_file(){return Err(invalid());}
 let ext=path.extension().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase();let bytes=bounded_read(&path,if ext=="css"{1024*1024}else{8*1024*1024})?;
 if ext=="css"{return Ok(json!({"kind":"css","content":String::from_utf8(bytes).map_err(|_|invalid())?}));}
 let mime=match ext.as_str(){"woff2"=>"font/woff2","woff"=>"font/woff","ttf"=>"font/ttf","otf"=>"font/otf","png"=>"image/png","jpg"|"jpeg"=>"image/jpeg","gif"=>"image/gif","webp"=>"image/webp",_=>return Err(crate::i18n::text("themes.unsupported",&[]))};
 Ok(json!({"kind":"asset","content":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))}))
}
fn catalog(root:&Path)->Result<Vec<Value>,String>{
 let mut entries=Vec::new();for entry in fs::read_dir(root).map_err(|e|e.to_string())?{let entry=entry.map_err(|e|e.to_string())?;let path=entry.path();if path.is_symlink(){continue;}let folder=path.is_dir();let css=if folder{path.join("theme.css")}else{path.clone()};let name=entry.file_name().to_string_lossy().to_string();
  if !css.is_file()||css.extension().and_then(|v|v.to_str())!=Some("css")||name.ends_with(".user.css"){continue;}
  let id=if folder{format!("{name}/theme.css")}else{name.clone()};let metadata=if folder{path.join("theme.json")}else{path.with_extension("json")};
  let meta:Value=if metadata.is_file()&&!metadata.is_symlink(){serde_json::from_slice(&bounded_read(&metadata,64*1024)?).map_err(|_|invalid())?}else{Value::Null};
  let default_name=match id.as_str(){"paper.css"=>crate::i18n::text("themes.paper",&[]),"paper-dark.css"=>crate::i18n::text("themes.paperDark",&[]),"lightmind.css"=>crate::i18n::text("themes.lightmind",&[]),_=>name.trim_end_matches(".css").to_owned()};
  let mode=meta["mode"].as_str().filter(|v|["light","dark"].contains(v)).or(match id.as_str(){"paper.css"|"lightmind.css"=>Some("light"),"paper-dark.css"=>Some("dark"),_=>None});
  entries.push(json!({"id":id,"name":meta["name"].as_str().unwrap_or(&default_name),"mode":mode}));
 }entries.sort_by_key(|t|t["id"].as_str().unwrap_or("").to_owned());Ok(entries)
}
#[tauri::command]
pub async fn theme_catalog(app:tauri::AppHandle)->Result<Value,String>{let root=directory(&app)?;Ok(json!({"directory":crate::desktop::display_path(&root),"themes":catalog(&root)?}))}
#[tauri::command]
pub async fn theme_read(app:tauri::AppHandle,path:String)->Result<Value,String>{read_asset(&directory(&app)?,&path)}
#[tauri::command]
pub async fn theme_open_folder(app:tauri::AppHandle,window:tauri::WebviewWindow)->Result<(),String>{crate::desktop::require_main(&window)?;let root=directory(&app)?;crate::desktop::command(if cfg!(windows){"explorer.exe"}else{"xdg-open"}).arg(root).spawn().map_err(|_|crate::i18n::text("themes.folderFailed",&[]))?;Ok(())}

#[cfg(test)]
mod tests {
 use super::*;
 fn fixture()->std::path::PathBuf {static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);let p=std::env::temp_dir().join(format!("kkb-theme-{}-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)));std::fs::create_dir_all(&p).unwrap();p}
 #[test] fn css_and_bundled_themes_have_optional_metadata_and_user_overrides_are_not_themes(){
  let p=fixture();std::fs::write(p.join("simple.css"),":root{}").unwrap();std::fs::write(p.join("base.user.css"),"").unwrap();std::fs::create_dir(p.join("forest")).unwrap();std::fs::write(p.join("forest/theme.css"),"").unwrap();std::fs::write(p.join("forest/theme.json"),r#"{"name":"Forest","mode":"dark"}"#).unwrap();
  let entries=catalog(&p).unwrap();assert_eq!(entries.len(),2);assert!(entries.iter().any(|t|t["id"]=="forest/theme.css"&&t["name"]=="Forest"&&t["mode"]=="dark"));std::fs::remove_dir_all(p).unwrap();
 }
 #[test] fn theme_reads_are_confined_to_the_theme_directory_and_supported_file_types(){
  let p=fixture();std::fs::write(p.join("theme.css"),"p { color:red }").unwrap();std::fs::write(p.join("font.woff2"),b"font").unwrap();std::fs::write(p.join("private.json"),"secret").unwrap();
  assert_eq!(read_asset(&p,"theme.css").unwrap()["kind"],"css");assert!(read_asset(&p,"font.woff2").unwrap()["content"].as_str().unwrap().starts_with("data:font/woff2;base64,"));
  for path in ["../outside.css","/absolute.css","C:/outside.css","private.json"]{assert!(read_asset(&p,path).is_err(),"{path}");}std::fs::remove_dir_all(p).unwrap();
 }
 #[test] fn installing_examples_preserves_user_edited_files(){let p=fixture();seed(&p).unwrap();std::fs::write(p.join("paper.css"),"custom").unwrap();seed(&p).unwrap();assert_eq!(std::fs::read_to_string(p.join("paper.css")).unwrap(),"custom");std::fs::remove_dir_all(p).unwrap();}
 #[test] fn lightmind_is_installed_as_a_light_theme_without_replacing_personal_changes(){
  let p=fixture();seed(&p).unwrap();let entries=catalog(&p).unwrap();
  assert!(entries.iter().any(|t|t["id"]=="lightmind.css"&&t["mode"]=="light"));
  assert_eq!(read_asset(&p,"lightmind.css").unwrap()["kind"],"css");
  std::fs::write(p.join("lightmind.css"),"personal LightMind").unwrap();seed(&p).unwrap();
  assert_eq!(std::fs::read_to_string(p.join("lightmind.css")).unwrap(),"personal LightMind");std::fs::remove_dir_all(p).unwrap();
 }
}
