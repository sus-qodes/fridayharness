/**
 * Third-party MCP tools pass Friday's policy hook (plan M6d, ADR-0030 §1–§4): protected locations
 * never, a project's per-server levels, `auto` only after trust, `manual` after a bound approval.
 */
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { decisionOf, postHook, toolHook } from '../helpers/hooks.js';

const ws = useTestWorkspace();
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

const MCP = [
  'mcp:',
  '  servers:',
  '    github:',
  '      default: review',
  '      tools: { search_code: auto, merge_pull_request: manual }',
  '    shell:',
  '      default: never',
  '',
].join('\n');

/** A Claude Code session (its hooks reach the daemon) holding a task that may write anywhere. */
async function session(td: TestDaemon) {
  const pid = 8201;
  const sessionId = 'sess-mcp-tools';
  const client = new GenericHarnessClient(td.bootstrap, {
    harness_key: `claude-code:${td.project.project_id}:pid:${pid}`,
    vendor: 'claude-code',
    name: 'Claude Code',
    version: '2.1.296',
    adapter_version: '0.1.0',
    attach_mode: 'attach',
    project_id: td.project.project_id,
    capabilities: { hooks: true },
    agent_key: 'dev-1',
    role: 'developer',
    host: { pid, session_id: sessionId, cwd: ws().projectDir },
  });
  await client.register();
  const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
  const vars = { projectDir: ws().projectDir, sessionId };
  await postHook(
    daemon,
    'SessionStart',
    { session_id: sessionId, cwd: vars.projectDir, hook_event_name: 'SessionStart', source: 'startup' },
    { claudePid: pid },
  );
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: 'triage issues',
    scope: { write: ['**'], read: [] },
    assign_agent_key: 'dev-1',
  });
  await client.claim({ task_id: task.task_id });
  const pre = async (tool: string, input: Record<string, unknown>) => {
    const res = await postHook(daemon, 'PreToolUse', toolHook('PreToolUse', tool, input, vars), { claudePid: pid });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return decisionOf(res.body.hook_output) ?? { decision: 'allow', reason: '' };
  };
  return { client, task, pre };
}

describe('third-party MCP tools', () => {
  it('judges each server by the project policy: never, review, manual after an approval, auto after trust', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()], extraConfig: MCP });
    const { client, pre } = await session(td);
    const dir = ws().projectDir;
    const decision = async (tool: string, input: Record<string, unknown> = {}) => (await pre(tool, input)).decision;

    // Friday's own tools get no decision from the hook; protected locations never pass.
    expect(await decision('mcp__friday__friday_whoami')).toBe('allow');
    const hidden = await pre('mcp__github__create_file', { path: path.join(dir, '.claude', 'settings.json') });
    expect(hidden).toMatchObject({ decision: 'deny' });
    expect(hidden.reason).toContain('host.config');

    // Unlisted servers ask; never is never; auto waits for this clone's trust.
    expect(await decision('mcp__slack__post_message', { text: 'hi' })).toBe('ask');
    expect(await decision('mcp__shell__run', { command: 'ls' })).toBe('deny');
    expect(await decision('mcp__github__search_code', { query: 'checkout' })).toBe('ask');
    expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);
    expect(await decision('mcp__github__search_code', { query: 'checkout' })).toBe('allow');
    expect(await decision('mcp__github__list_issues', {})).toBe('ask');

    // manual: denied until a human approves that tool, then once.
    expect(await decision('mcp__github__merge_pull_request', { number: 7 })).toBe('deny');
    const asked = await client.requestPermission({
      action_class: 'mcp.call',
      resource: 'github/merge_pull_request',
      justification: 'merge the reviewed fix',
    });
    expect(asked).toMatchObject({ status: 'pending', capability: 'mcp.call', risk: 'medium' });
    expect((await cli(['--project', dir, 'approve', asked.approval_id as string])).code).toBe(0);
    expect(await decision('mcp__github__merge_pull_request', { number: 7 })).toBe('allow');
    expect(await decision('mcp__github__merge_pull_request', { number: 8 })).toBe('deny');

    // A request for a tool the policy never allows is refused outright, not put to a human.
    const never = await client.requestPermission({
      action_class: 'mcp.call',
      resource: 'shell/run',
      justification: 'list files',
    });
    expect(never).toMatchObject({ status: 'denied', approval_id: null });
  });
});
