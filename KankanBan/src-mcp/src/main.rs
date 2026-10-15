//! Headless stdio adapter. All workspace mutations stay inside the desktop app.
#[path = "../../src-tauri/src/i18n.rs"]
mod i18n;
use serde_json::{json, Value};
use std::{env, fs, io::{self, BufRead, BufReader, Read, Write}, net::{SocketAddr, TcpStream}, path::PathBuf, time::{Duration, Instant}};

const REQUEST_LIMIT: usize = 1_048_576;
const REPLY_LIMIT: usize = 16_777_216;
fn message(key: &str) -> String { i18n::text(key, &[]) }
fn app_directory() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let base = env::var_os("APPDATA").map(PathBuf::from).or_else(||env::var_os("USERPROFILE").map(|p|PathBuf::from(p).join("AppData/Roaming")));
    #[cfg(target_os="macos")]
    let base = env::var_os("HOME").map(|p|PathBuf::from(p).join("Library/Application Support"));
    #[cfg(all(not(windows),not(target_os="macos")))]
    let base = env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(||env::var_os("HOME").map(|p|PathBuf::from(p).join(".local/share")));
    base.map(|p|p.join("com.kankanban.app")).ok_or_else(||message("mcp/desktop.notRunning"))
}
fn workspace(explicit: &Option<PathBuf>) -> Result<PathBuf,String> {
    if let Some(root)=explicit {return Ok(root.clone());}
    let app=app_directory()?;
    if let Ok(saved)=fs::read_to_string(app.join("workspace-path.txt")) {if !saved.trim().is_empty(){return Ok(PathBuf::from(saved.trim()));}}
    Ok(app.join("workspace"))
}
fn forward(explicit: &Option<PathBuf>, name:&str, args:Value, context:&Value) -> Result<Value,String> {
    let root=workspace(explicit)?;
    let mut raw=Vec::new();
    fs::File::open(root.join(".kkb/mcp-bridge.json")).and_then(|file|file.take(8193).read_to_end(&mut raw)).map_err(|_|message("mcp/desktop.notRunning"))?;
    if raw.len()>8192 {return Err(message("mcp/desktop.invalidDiscovery"));}
    let d:Value=serde_json::from_slice(&raw).map_err(|_|message("mcp/desktop.invalidDiscovery"))?;
    let token=d["token"].as_str().unwrap_or("");
    let port=d["port"].as_u64().unwrap_or(0);
    let discovered=d["root"].as_str().ok_or_else(||message("mcp/desktop.invalidDiscovery"))?;
    if d["version"]!=1 || d["host"]!="127.0.0.1" || port==0 || port>65535 || token.len()!=64 || !token.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {return Err(message("mcp/desktop.invalidDiscovery"));}
    let canonical=fs::canonicalize(&root).map_err(|_|message("mcp/desktop.invalidDiscovery"))?;
    if canonical!=fs::canonicalize(discovered).map_err(|_|message("mcp/desktop.invalidDiscovery"))? {return Err(message("mcp/desktop.workspaceChanged"));}
    let wire=serde_json::to_vec(&json!({"token":token,"workspace":discovered,"tool":name,"args":args,"context":context})).unwrap();
    if wire.len()+1>REQUEST_LIMIT {return Err(message("native/mcpBridge.invalidRequest"));}
    let deadline=Instant::now()+Duration::from_secs(35);
    let address:SocketAddr=([127,0,0,1],port as u16).into();
    let mut socket=TcpStream::connect_timeout(&address,Duration::from_secs(3)).map_err(|_|message("mcp/desktop.connectionLost"))?;
    socket.set_write_timeout(Some(Duration::from_secs(5))).map_err(|_|message("mcp/desktop.connectionLost"))?;
    socket.write_all(&wire).and_then(|_|socket.write_all(b"\n")).map_err(|_|message("mcp/desktop.connectionLost"))?;
    socket.shutdown(std::net::Shutdown::Write).ok();
    let mut reply=Vec::new();let mut chunk=[0u8;8192];
    loop {
        let remaining=deadline.checked_duration_since(Instant::now()).ok_or_else(||message("mcp/desktop.timeout"))?;
        socket.set_read_timeout(Some(remaining)).map_err(|_|message("mcp/desktop.connectionLost"))?;
        let n=socket.read(&mut chunk).map_err(|e|message(if matches!(e.kind(),io::ErrorKind::TimedOut|io::ErrorKind::WouldBlock){"mcp/desktop.timeout"}else{"mcp/desktop.connectionLost"}))?;
        if n==0 {return Err(message("mcp/desktop.connectionLost"));}
        if reply.len()+n>REPLY_LIMIT {return Err(message("mcp/desktop.invalidReply"));}
        reply.extend_from_slice(&chunk[..n]);
        if let Some(end)=reply.iter().position(|b|*b==b'\n') {
            let value:Value=serde_json::from_slice(&reply[..end]).map_err(|_|message("mcp/desktop.invalidReply"))?;
            if let Some(error)=value["error"].as_str(){return Err(error.to_owned());}
            return value.get("result").cloned().ok_or_else(||message("mcp/desktop.invalidReply"));
        }
    }
}
fn actor(args:&Value)->Result<Value,String> {
    let id=args["id"].as_str().unwrap_or("");let name=args["name"].as_str().unwrap_or("");
    if id.is_empty() || id.len()>80 || !id.bytes().all(|b|b.is_ascii_alphanumeric() || b"._-".contains(&b)) || name.trim().is_empty() || name.encode_utf16().count()>80 || name.chars().any(|c|c<' ') || args.as_object().is_none_or(|a|a.keys().any(|k|k!="id" && k!="name")) {return Err(message("collaboration.invalidActor"));}
    Ok(json!({"kind":"ai","id":id,"name":name.trim()}))
}
struct Server {catalog:Value, context:Value, initialized:bool, explicit:Option<PathBuf>}
impl Server {
    fn new(explicit:Option<PathBuf>)->Self {Self{catalog:serde_json::from_str(include_str!("../tools.json")).unwrap(),context:json!({}),initialized:false,explicit}}
    fn tool(&mut self, params:&Value)->Result<Value,String> {
        let name=params["name"].as_str().unwrap_or("");
        let args=params.get("arguments").cloned().unwrap_or(json!({}));
        if !args.is_object() || !self.catalog["tools"].as_array().unwrap().iter().any(|t|t["name"]==name) {return Err(message("native/mcpBridge.invalidRequest"));}
        if name=="identify_actor" {
            let a=actor(&args)?;
            if self.context["actor"]["id"]!=a["id"] {self.context=json!({});}
            self.context["actor"]=a.clone();return Ok(json!({"content":[{"type":"text","text":json!({"actor":a}).to_string()}]}));
        }
        let result=forward(&self.explicit,name,args,&self.context)?;
        if name=="read_operations" {if let Some(token)=result["reviewToken"].as_str(){self.context["reviewToken"]=json!(token);}}
        if name=="capture_window" {if let (Some(data),Some(mime))=(result["data"].as_str(),result["mimeType"].as_str()) {let mut meta=result.clone();meta.as_object_mut().unwrap().remove("data");return Ok(json!({"content":[{"type":"image","data":data,"mimeType":mime},{"type":"text","text":meta.to_string()}]}));}}
        Ok(json!({"content":[{"type":"text","text":result.to_string()}]}))
    }
    fn handle(&mut self, request:Value)->Option<Value> {
        let id=request.get("id").cloned();
        if request["jsonrpc"]!="2.0" || !request["method"].is_string() || id.as_ref().is_some_and(|i|!i.is_string() && !i.is_number()) {
            return Some(json!({"jsonrpc":"2.0","id":id.unwrap_or(Value::Null),"error":{"code":-32600,"message":message("native/mcpBridge.invalidRequest")}}));
        }
        let id=id?;let method=request["method"].as_str().unwrap();
        let result=match method {
            "initialize"=>{
                let requested=request["params"]["protocolVersion"].as_str().unwrap_or("");
                let version=if ["2025-11-25","2025-06-18","2025-03-26","2024-11-05"].contains(&requested){requested}else{"2025-11-25"};
                self.initialized=true;
                Ok(json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"kankanban","version":self.catalog["version"]}}))
            },
            "ping"=>Ok(json!({})),
            "tools/list" if self.initialized=>Ok(json!({"tools":self.catalog["tools"]})),
            "tools/call" if self.initialized=>Ok(self.tool(&request["params"]).unwrap_or_else(|e|json!({"content":[{"type":"text","text":e}],"isError":true}))),
            _=>Err(json!({"code":-32601,"message":message("native/mcpBridge.invalidRequest")}))
        };
        Some(match result {Ok(r)=>json!({"jsonrpc":"2.0","id":id,"result":r}),Err(e)=>json!({"jsonrpc":"2.0","id":id,"error":e})})
    }
}
fn main()->io::Result<()> {
    let explicit=env::args_os().nth(1).map(PathBuf::from);
    let mut server=Server::new(explicit);
    let mut input=BufReader::new(io::stdin().lock());let mut output=io::stdout().lock();
    loop {
        let mut line=Vec::new();let count=input.by_ref().take((REQUEST_LIMIT+1) as u64).read_until(b'\n',&mut line)?;
        if count==0 {break;}
        // Closing an oversized input avoids unbounded memory and unsafe framing recovery.
        if count>REQUEST_LIMIT {return Err(io::Error::new(io::ErrorKind::InvalidData,message("native/mcpBridge.invalidRequest")));}
        if line.iter().all(u8::is_ascii_whitespace){continue;}
        let reply=match serde_json::from_slice(&line) {Ok(request)=>server.handle(request),Err(_)=>Some(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":message("native/mcpBridge.invalidRequest")}}))};
        if let Some(reply)=reply {serde_json::to_writer(&mut output,&reply)?;output.write_all(b"\n")?;output.flush()?;}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn identity_preserves_receipt_only_for_same_actor(){let mut s=Server::new(None);s.tool(&json!({"name":"identify_actor","arguments":{"id":"codex","name":"Codex"}})).unwrap();s.context["reviewToken"]=json!("read");s.tool(&json!({"name":"identify_actor","arguments":{"id":"codex","name":"New name"}})).unwrap();assert_eq!(s.context["reviewToken"],"read");s.tool(&json!({"name":"identify_actor","arguments":{"id":"other","name":"Other"}})).unwrap();assert!(s.context.get("reviewToken").is_none());}
    #[test] fn invalid_actor_rejected(){for args in [json!({"id":"x/y","name":"AI"}),json!({"id":"a","name":" "}),json!({"id":"a","name":"A\nB"})]{assert!(actor(&args).is_err());}}
    #[test] fn protocol_and_notifications(){let mut s=Server::new(None);assert!(s.handle(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());assert_eq!(s.handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}})).unwrap()["result"]["protocolVersion"],"2025-06-18");assert!(s.handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).unwrap()["result"]["tools"].as_array().unwrap().len()>20);}
}
