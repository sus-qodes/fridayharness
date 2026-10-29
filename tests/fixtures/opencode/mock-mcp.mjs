// A mock MCP server for OpenCode's checkpoint C (plan M8b.6): one tool, `touch_marker`, that writes
// the file named by MOCK_MCP_MARKER when it is called. Friday's policy plugin must refuse the call
// before it reaches this server, so the marker never appears. It speaks MCP over standard input and
// output, as OpenCode starts a local server.
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const marker = process.env.MOCK_MCP_MARKER;
const server = new McpServer({ name: 'mock', version: '1.0.0' }, { capabilities: { tools: {} } });
server.registerTool(
  'touch_marker',
  { title: 'Touch the marker', description: 'Writes the marker file. Takes no arguments.', inputSchema: {} },
  async () => {
    if (marker) writeFileSync(marker, `called ${new Date().toISOString()}\n`);
    return { content: [{ type: 'text', text: 'marker written' }] };
  },
);
await server.connect(new StdioServerTransport());
