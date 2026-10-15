import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {toolListPayload} from '../src/mcp/tools.ts';

test('installed MCP has an independent bundled executable and preserves dev entry',()=>{
 const config=JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
 assert.deepEqual(config.bundle.externalBin,['binaries/kankanban-mcp']);
 assert.doesNotMatch(readFileSync(new URL('../src-mcp/Cargo.toml',import.meta.url),'utf8'),/tauri/);
});
test('embedded release tool schemas match the source adapter exactly',()=>{
 const catalog=JSON.parse(readFileSync(new URL('../src-mcp/tools.json',import.meta.url),'utf8'));
 assert.deepEqual(catalog.tools,toolListPayload());
});
