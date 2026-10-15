import {uiText} from '../i18n/text.ts';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createServer} from './server.ts';
import {desktopToolCaller,desktopWorkspace} from './desktop-client.ts';
// A source-side MCP adapter. The running desktop remains the only writer.
const explicit=process.argv[2];
const server=createServer(desktopToolCaller(explicit));
await server.connect(new StdioServerTransport());
const shutdown=async()=>{await server.close();process.exit(0);};
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
process.stderr.write(uiText('mcp/desktop.connected',{arg0:desktopWorkspace(explicit)}));
