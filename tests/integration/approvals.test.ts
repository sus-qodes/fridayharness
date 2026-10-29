/**
 * Capability requests and bound approvals through the protocol, the hooks and the CLI (plan M6a,
 * ADR-0027; spec Part 07 §6, §13, §16).
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

/** A Claude Code session in the main checkout holding a task scoped to src/**. */
async function session(td: TestDaemon) {
  const pid = 7101;
  const sessionId = 'sess-approvals';
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
    summary: 'release work',
    scope: { write: ['src/**'], read: [] },
    assign_agent_key: 'dev-1',
  });
  await client.claim({ task_id: task.task_id });
  const pre = async (tool: string, input: Record<string, unknown>) => {
    const res = await postHook(daemon, 'PreToolUse', toolHook('PreToolUse', tool, input, vars), { claudePid: pid });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return decisionOf(res.body.hook_output)?.decision ?? 'allow';
  };
  return { client, task, pre };
}

const approval = (td: TestDaemon, id: string) =>
  td.daemon.state.q.approvals(td.project.project_id).find((a) => a.approval_id === id) as Record<string, unknown>;

describe('capability requests and approvals', () => {
  it('binds a grant to its task, attempt and exact target, uses it up, and lets a human revoke it', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { client, task, pre } = await session(td);
    const dir = ws().projectDir;

    // A push is manual: denied until a human approves exactly this command.
    expect(await pre('Bash', { command: 'git push' })).toBe('deny');
    const asked = await client.requestPermission({
      action_class: 'git.push',
      command: 'git push',
      justification: 'publish the reviewed release',
      ttl_s: 600,
      reuse: 'once',
    });
    expect(asked).toMatchObject({ status: 'pending', capability: 'shell.git.push', risk: 'high' });
    const id = asked.approval_id as string;
    expect(approval(td, id)).toMatchObject({ task_id: task.task_id, reuse: 'once', status: 'pending' });
    expect((await cli(['--project', dir, 'approve', id, '--note', 'reviewed'])).code).toBe(0);
    expect(await pre('Bash', { command: 'git push' })).toBe('allow');
    expect(approval(td, id)).toMatchObject({ status: 'used', uses: 1, decided_via: 'cli', note: 'reviewed' });
    expect(await pre('Bash', { command: 'git push' })).toBe('deny');
    // The grant was for that exact command.
    expect(await pre('Bash', { command: 'git push --force' })).toBe('deny');

    // An edit outside the scope, granted for the whole task, until a human revokes it.
    const outside = path.join(dir, 'docs', 'release.md');
    expect(await pre('Edit', { file_path: outside, old_string: 'a', new_string: 'b' })).toBe('deny');
    const doc = await client.requestPermission({
      action_class: 'file.write',
      resource: 'docs/release.md',
      justification: 'release notes',
      ttl_s: 600,
    });
    expect(doc).toMatchObject({ status: 'pending', risk: 'medium' });
    const listed = await cli(['--project', dir, 'approvals']);
    expect(listed.stdout).toContain(doc.approval_id as string);
    await cli(['--project', dir, 'approve', doc.approval_id as string, '--for', 'task', '--ttl', '1h']);
    expect(await pre('Edit', { file_path: outside, old_string: 'a', new_string: 'b' })).toBe('allow');
    expect(await pre('Edit', { file_path: outside, old_string: 'b', new_string: 'c' })).toBe('allow');
    expect(approval(td, doc.approval_id as string)).toMatchObject({ status: 'granted', reuse: 'task', uses: 2 });
    expect((await cli(['--project', dir, 'approvals', 'revoke', doc.approval_id as string])).code).toBe(0);
    expect(await pre('Edit', { file_path: outside, old_string: 'c', new_string: 'd' })).toBe('deny');

    // What the policy decides alone never waits for a human.
    const inScope = await client.requestPermission({
      action_class: 'file.write',
      resource: 'src/a.ts',
      justification: 'edit',
      ttl_s: 60,
    });
    expect(inScope).toMatchObject({ approval_id: null, status: 'granted' });
    const secret = await client.requestPermission({
      action_class: 'secret.resolve',
      resource: 'STRIPE_KEY',
      justification: 'test',
      ttl_s: 60,
    });
    expect(secret).toMatchObject({ approval_id: null, status: 'denied' });
    expect(secret.reason).toContain('never handed to agents');
  });
});
