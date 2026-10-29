/**
 * One session, one harness, whichever of a host's hooks and its `friday` MCP server reaches Friday
 * first (plan M8b): Cursor, Antigravity and Gemini CLI run their hooks through a shell, so a hook's
 * parent is never the process that started the MCP server, and the server is not told the
 * session's id. And the level each attached session reaches comes from its hooks (plan B21).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { Vendor } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { OTHER_VENDORS, type OtherVendor, postVendorHook } from './host-rig.js';

const ws = useTestWorkspace();
/** The pid of the host process that started the MCP server; its hooks run under shells, each its own pid. */
const HOST_PID = 424_242;
let shellPid = 500_000;

/** The `friday` MCP server of a host, registering as `friday-mcp` does for it. */
function mcpServer(td: TestDaemon, vendor: OtherVendor, agentKey = 'dev-1') {
  const pid = td.project.project_id;
  return new GenericHarnessClient(td.bootstrap, {
    harness_key: `${vendor}:${pid}:pid:${HOST_PID}`,
    vendor: vendor as Vendor,
    name: vendor,
    attach_mode: 'attach',
    project_id: pid,
    agent_key: agentKey,
    capabilities: { mcp_tools: true, hooks: true, context_request: true },
    host: { pid: HOST_PID, cwd: td.project.root },
  });
}

/** One of the host's hooks, as its launcher posts it: from a new shell each time. */
function hook(
  td: TestDaemon,
  vendor: OtherVendor,
  event: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
) {
  shellPid += 1;
  const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
  return postVendorHook(daemon, vendor, event, {
    host_pid: shellPid,
    agent_key: null,
    hook: { hook_event_name: event, session_id: sessionId, ...extra },
    host: { vendor, event, version: vendor === 'cursor' ? '3.24.0' : null, can_ask: true },
  });
}

const live = (td: TestDaemon) =>
  td.daemon.state.q.harnesses(td.project.project_id).filter((h) => !['DISCONNECTED', 'TERMINATED'].includes(h.status));

describe('a host whose hooks and MCP server register apart', () => {
  for (const vendor of OTHER_VENDORS) {
    it(`${vendor}: the hooks find the MCP server's session when it registered first`, async () => {
      const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
      const pid = td.project.project_id;
      const reg = await mcpServer(td, vendor).register();
      expect(reg.shadow).toBe(false);
      expect((await hook(td, vendor, 'SessionStart', `${vendor}-s1`)).status).toBe(200);
      expect((await hook(td, vendor, 'PreToolUse', `${vendor}-s1`, { tool_name: 'Read', tool_input: {} })).status).toBe(
        200,
      );
      // One harness: the server's, linked to the session and carrying its hooks' evidence.
      expect(live(td).map((h) => h.harness_id)).toEqual([reg.harness_id]);
      const h = td.daemon.state.q.harnessBySession(pid, vendor, `${vendor}-s1`);
      expect(h?.harness_id).toBe(reg.harness_id);
      expect(h?.hooks_seen_at).toBeTruthy();
      expect(h?.enforcement_level).toBe('L1');
    });

    it(`${vendor}: the MCP server takes the session over when the hooks registered first`, async () => {
      const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
      const pid = td.project.project_id;
      expect((await hook(td, vendor, 'SessionStart', `${vendor}-s2`)).status).toBe(200);
      const first = td.daemon.state.q.harnessBySession(pid, vendor, `${vendor}-s2`);
      expect(first?.capabilities).toMatchObject({ hooks_route: true });
      const reg = await mcpServer(td, vendor).register();
      // Not a shadow of the hooks' harness: the agent has one harness, with what its hooks showed.
      expect(reg.shadow).toBe(false);
      expect(live(td).map((h) => h.harness_id)).toEqual([reg.harness_id]);
      const h = td.daemon.state.q.harnessBySession(pid, vendor, `${vendor}-s2`);
      expect(h?.harness_id).toBe(reg.harness_id);
      expect([h?.enforcement_level, Boolean(h?.hooks_seen_at)]).toEqual(['L1', true]);
      expect(td.daemon.state.q.findHarness(first?.harness_id as string)?.status).toBe('TERMINATED');
      // Later hooks reach the server's harness by the session's id.
      await hook(td, vendor, 'PreToolUse', `${vendor}-s2`, { tool_name: 'Read', tool_input: {} });
      expect(live(td)).toHaveLength(1);
    });
  }

  it('a second session of the same host and agent is a shadow, linked to its own server', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const pid = td.project.project_id;
    const a = await mcpServer(td, 'gemini').register();
    await hook(td, 'gemini', 'SessionStart', 'g-a');
    const b = await new GenericHarnessClient(td.bootstrap, {
      harness_key: `gemini:${pid}:pid:${HOST_PID + 1}`,
      vendor: 'gemini',
      name: 'gemini',
      attach_mode: 'attach',
      project_id: pid,
      agent_key: 'dev-1',
      capabilities: { mcp_tools: true, hooks: true },
      host: { pid: HOST_PID + 1 },
    }).register();
    expect(b.shadow).toBe(true);
    await hook(td, 'gemini', 'SessionStart', 'g-b');
    expect(td.daemon.state.q.harnessBySession(pid, 'gemini', 'g-a')?.harness_id).toBe(a.harness_id);
    expect(td.daemon.state.q.harnessBySession(pid, 'gemini', 'g-b')?.harness_id).toBe(b.harness_id);
  });
});

describe('the level an attached session reaches, from its hooks', () => {
  /** Writes the project's .cursor/hooks.json with Friday's permission hooks, failing closed or not. */
  function cursorHooks(root: string, failClosed: boolean) {
    mkdirSync(path.join(root, '.cursor'), { recursive: true });
    const entry = (e: string) => ({
      type: 'command',
      command: `node .friday/harness/cursor/hook.mjs cursor ${e}`,
      ...(failClosed ? { failClosed: true } : {}),
    });
    const events = ['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile'];
    writeFileSync(
      path.join(root, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: Object.fromEntries(events.map((e) => [e, [entry(e)]])) }),
    );
  }

  for (const [failClosed, status] of [
    [true, 'enforcing'],
    [false, 'degraded'],
  ] as const) {
    it(`Cursor: ${status} when its permission hooks ${failClosed ? 'fail closed' : 'lack failClosed'}, on a documented version`, async () => {
      const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
      cursorHooks(td.project.root, failClosed);
      await mcpServer(td, 'cursor').register();
      await hook(td, 'cursor', 'SessionStart', 'c-1');
      expect(td.daemon.state.q.harnessBySession(td.project.project_id, 'cursor', 'c-1')).toMatchObject({
        enforcement_level: 'L1',
        enforcement_status: status,
      });
    });
  }

  it('a Gemini CLI session reaches L1 degraded, and require_enforcing_hooks refuses it, naming the host', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      extensions: [claudeCodeHooks()],
      extraConfig: 'security:\n  enforcement_required: L1\n  require_enforcing_hooks: true\n',
    });
    const pid = td.project.project_id;
    const client = mcpServer(td, 'gemini');
    await client.register();
    const before = td.daemon.state.q.harnessByKey(pid, `gemini:${pid}:pid:${HOST_PID}`);
    expect(td.daemon.state.enforcementGap(before as NonNullable<typeof before>)).toContain(
      'friday harness config gemini',
    );
    await hook(td, 'gemini', 'SessionStart', 'g-1');
    const h = td.daemon.state.q.harnessBySession(pid, 'gemini', 'g-1');
    expect(h).toMatchObject({ enforcement_level: 'L1', enforcement_status: 'degraded' });
    expect(td.daemon.state.enforcementGap(h as NonNullable<typeof h>)).toContain(
      'Gemini CLI lets a call through when a hook fails',
    );
  });
});
