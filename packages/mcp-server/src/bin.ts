#!/usr/bin/env node
/**
 * `friday-mcp`: the stdio MCP server Claude Code (or any MCP host) launches.
 * stdout carries the MCP protocol only; diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFridayMcpServer } from './server.js';
import { FridaySession, sessionVendor } from './session.js';

// Windows looks for a program started by its bare name (git) in the current folder before PATH;
// this server runs inside a repository, whose content it does not trust (LESSONS D-52).
if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';

const log = (msg: string) => process.stderr.write(`[friday-mcp] ${msg}\n`);

// The host is the one the launcher's configuration names (`FRIDAY_HARNESS`); Claude Code's, unless named.
const vendor = sessionVendor(process.env.FRIDAY_HARNESS);
// Cursor's, Antigravity's and Gemini CLI's servers find their project from their own configuration:
// a Claude Code session's variables inherited from a terminal name another host's project and session.
const otherHost = vendor === 'cursor' || vendor === 'antigravity' || vendor === 'gemini';
const session = new FridaySession({
  projectDir:
    (otherHost ? undefined : process.env.CLAUDE_PROJECT_DIR) ?? process.env.FRIDAY_PROJECT_DIR ?? process.cwd(),
  agentKey: process.env.FRIDAY_AGENT || undefined,
  hostPid: process.env.FRIDAY_HOST_PID ? Number(process.env.FRIDAY_HOST_PID) : process.ppid,
  hostSessionId: (!otherHost && process.env.CLAUDE_CODE_SESSION_ID) || undefined,
  vendor,
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

// Register after the MCP handshake, so a slow or absent daemon never delays Claude Code's startup
// and the registration carries the host's own version from `initialize` (review F09).
let started = false;
const begin = () => {
  if (started) return;
  started = true;
  session.hostVersion = server.server.getClientVersion()?.version;
  void session.start().then((ok) => {
    if (!ok) log(`not attached yet: ${session.problem}`);
  });
};
server.server.oninitialized = begin;
await server.connect(transport);
// A client that never completes the handshake still gets a session.
setTimeout(begin, 3000).unref();
