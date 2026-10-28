#!/usr/bin/env node
/**
 * `friday-mcp`: the stdio MCP server Claude Code (or any MCP host) launches.
 * stdout carries the MCP protocol only; diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFridayMcpServer } from './server.js';
import { FridaySession } from './session.js';

const log = (msg: string) => process.stderr.write(`[friday-mcp] ${msg}\n`);

const session = new FridaySession({
  projectDir: process.env.CLAUDE_PROJECT_DIR ?? process.env.FRIDAY_PROJECT_DIR ?? process.cwd(),
  agentKey: process.env.FRIDAY_AGENT || undefined,
  hostPid: process.env.FRIDAY_HOST_PID ? Number(process.env.FRIDAY_HOST_PID) : process.ppid,
  hostSessionId: process.env.CLAUDE_CODE_SESSION_ID || undefined,
  vendor: process.env.FRIDAY_HARNESS === 'generic' ? 'generic' : 'claude-code',
  log,
});
const server = createFridayMcpServer(session);
const transport = new StdioServerTransport();

let exiting = false;
async function shutdown(reason: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  await session.stop(reason);
  process.exit(0);
}

transport.onclose = () => void shutdown('stdio_closed');
process.stdin.on('end', () => void shutdown('stdio_closed'));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void shutdown(`signal ${sig}`));

await server.connect(transport);
// Register after the MCP handshake so a slow or absent daemon never delays Claude Code's startup.
void session.start().then((ok) => {
  if (!ok) log(`not attached yet: ${session.problem}`);
});
