import path from 'node:path';
import type { TestWorkspace } from '@friday/test-support';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REPO_ROOT } from './cli.js';

const MCP_SOURCE = path.join(REPO_ROOT, 'packages', 'mcp-server', 'src', 'bin.ts');

export interface McpRig {
  client: Client;
  transport: StdioClientTransport;
  pid: number | null;
  stderr: () => string;
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ text: string; structured: Record<string, unknown>; isError: boolean }>;
  close(): Promise<void>;
}

/**
 * Starts `friday-mcp` from source the way Claude Code starts it: stdio, CLAUDE_PROJECT_DIR, no token.
 * The client introduces itself as Claude Code 2.1.296, so the server reports that host version.
 */
export async function startMcp(
  ws: TestWorkspace,
  env: Record<string, string> = {},
  clientInfo: { name: string; version: string } = { name: 'claude-code', version: '2.1.296' },
): Promise<McpRig> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--conditions', 'development', '--import', 'tsx', MCP_SOURCE],
    cwd: REPO_ROOT,
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PROJECT_DIR: ws.projectDir,
      FRIDAY_STATE_DIR: ws.stateDir,
      FRIDAY_AGENT: 'dev-1',
      CLAUDE_CODE_SESSION_ID: 'sess-test-1',
      ...env,
    },
    stderr: 'pipe',
  });
  let errText = '';
  transport.stderr?.on('data', (c: Buffer) => {
    errText += c.toString('utf8');
  });
  const client = new Client(clientInfo);
  await client.connect(transport);
  const rig: McpRig = {
    client,
    transport,
    pid: transport.pid,
    stderr: () => errText,
    async call(name, args = {}) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content?: { type: string; text?: string }[];
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };
      return {
        text: (res.content ?? []).map((c) => c.text ?? '').join('\n'),
        structured: res.structuredContent ?? {},
        isError: Boolean(res.isError),
      };
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
  ws.track({ close: () => rig.close() });
  return rig;
}
