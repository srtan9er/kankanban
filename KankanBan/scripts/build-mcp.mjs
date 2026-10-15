import {writeFileSync, mkdirSync, copyFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {toolListPayload} from '../src/mcp/tools.ts';
import packageInfo from '../package.json' with {type:'json'};
const root=fileURLToPath(new URL('../',import.meta.url));
writeFileSync(resolve(root,'src-mcp/tools.json'),JSON.stringify({version:packageInfo.version,tools:toolListPayload()},null,2)+'\n');
if(!process.argv.includes('--catalog-only')){
 const run=(args)=>{const result=spawnSync(args[0],args.slice(1),{cwd:root,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status ?? 1);};
 const host=spawnSync('rustc',['-vV'],{encoding:'utf8'});if(host.status!==0)throw host.error ?? new Error(host.stderr);
 const target=process.env.TAURI_ENV_TARGET_TRIPLE ?? /host: (\S+)/.exec(host.stdout)?.[1];
 if(!target || !/^[a-zA-Z0-9_-]+$/.test(target))throw new Error('Invalid Rust target');
 run(['cargo','build','--manifest-path','src-mcp/Cargo.toml','--release','--target',target,'--locked']);
 const suffix=target.includes('windows')?'.exe':'';
 mkdirSync(resolve(root,'src-tauri/binaries'),{recursive:true});
 copyFileSync(resolve(root,`src-mcp/target/${target}/release/kankanban-mcp${suffix}`),resolve(root,`src-tauri/binaries/kankanban-mcp-${target}${suffix}`));
}
