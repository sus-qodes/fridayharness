import { claudeCodeHooks } from '@friday/adapter-claude';
import type { TaskView } from '@friday/protocol';
import { useTestWorkspace, waitForPidGone } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';
import { postHook } from '../helpers/hooks.js';
import { startMcp } from '../helpers/mcp-rig.js';

const ws = useTestWorkspace();

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('friday-mcp over stdio', () => {
  it('exposes the friday server, its instructions, 14 tools (5 always loaded), resources and prompts', async () => {
    await startTestDaemon(ws(), { git: true });
    const mcp = await startMcp(ws());
    expect(mcp.client.getServerVersion()?.name).toBe('friday');
    const instructions = mcp.client.getInstructions() ?? '';
    expect(instructions.length).toBeGreaterThan(500);
    expect(instructions.length).toBeLessThanOrEqual(2000);
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'friday_acknowledge',
        'friday_ask_human',
        'friday_check_inbox',
        'friday_claim_done',
        'friday_communicate',
        'friday_report_progress',
        'friday_request_context',
        'friday_request_permission',
        'friday_session_bind',
        'friday_task_claim',
        'friday_task_current',
        'friday_task_next',
        'friday_task_release',
        'friday_whoami',
      ].sort(),
    );
    const pinned = tools
      .filter((t) => (t._meta as Record<string, unknown> | undefined)?.['anthropic/alwaysLoad'] === true)
      .map((t) => t.name);
    expect(pinned.sort()).toEqual([
      'friday_check_inbox',
      'friday_claim_done',
      'friday_report_progress',
      'friday_task_claim',
      'friday_whoami',
    ]);
    const prompts = await mcp.client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual(['handoff', 'start_task', 'status']);
    const start = await mcp.client.getPrompt({ name: 'start_task', arguments: {} });
    expect(JSON.stringify(start.messages)).toContain('friday_task_claim');
  });

  it('runs a task from claim to completion claim, and never shows a token', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Add discount codes',
      acceptance_criteria: ['tests pass'],
      scope: { write: ['src/**'], read: [] },
      assign_agent_key: 'dev-1',
    });
    const mcp = await startMcp(ws());
    const who = await eventually(
      () => mcp.call('friday_whoami'),
      (r) => r.structured.daemon !== undefined && (r.structured.daemon as { reachable: boolean }).reachable,
    );
    expect(who.text).toContain('You hold no task.');
    expect(who.text).toContain(task.task_id);
    // MCP alone proves no interception: L0 until the session's Friday hooks reach the daemon (review F09).
    expect(who.structured).toMatchObject({ agent_key: 'dev-1', enforcement_level: 'L0', shadow: false });
    expect(who.text).toContain('Enforcement: L0');
    expect(who.text).toContain('You cannot take work in this session');
    const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
    const start = await postHook(
      daemon,
      'SessionStart',
      { session_id: 'sess-test-1', cwd: ws().projectDir, hook_event_name: 'SessionStart', source: 'startup' },
      { claudePid: process.pid },
    );
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const linked = await mcp.call('friday_whoami');
    expect(linked.structured).toMatchObject({
      enforcement_level: 'L1',
      enforcement_status: 'enforcing',
      enforcement_gap: null,
      secrets_location: 'private',
    });
    expect(linked.text).toContain(
      'Enforcement: L1, enforcing (Friday hooks from this session; Claude Code 2.1.296 blocks when a hook fails)',
    );

    const claim = await mcp.call('friday_task_claim', { next: true });
    expect(claim.isError, claim.text).toBe(false);
    expect(claim.text).toContain('<friday-context');
    expect(claim.text).toContain('write: src/**');
    expect(
      (await td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${task.task_id}`))).task.status,
    ).toBe('RUNNING');

    const current = await mcp.call('friday_task_current');
    expect(current.text).toContain('Add discount codes');
    const ctx = await mcp.call('friday_request_context', { kind: 'task' });
    expect(ctx.text).toContain('Acceptance criteria');

    const progress = await mcp.call('friday_report_progress', {
      note: 'wrote the discount module',
      changed_paths: ['src/discount.ts'],
    });
    expect(progress.structured.task_status).toBe('RUNNING');

    const resource = await mcp.client.readResource({ uri: 'friday://task/current' });
    expect(JSON.stringify(resource.contents)).toContain('Add discount codes');

    const done = await mcp.call('friday_claim_done', {
      summary: 'discount codes added',
      changed_paths: ['src/discount.ts'],
      checks: [{ name: 'tests', kind: 'test', outcome: 'passed' }],
    });
    expect(done.structured.task_status).toBe('READY_FOR_VERIFICATION');
    expect(done.text).toContain('waits for verification');

    const again = await mcp.call('friday_report_progress', { note: 'more' });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('do not hold an active task');

    const outputs = JSON.stringify([who, claim, current, ctx, progress, done, again, resource]);
    for (const secret of [td.daemon.tokens.operator, td.daemon.tokens.bootstrap]) expect(outputs).not.toContain(secret);
    expect(mcp.stderr()).not.toContain(td.daemon.tokens.bootstrap);
  });

  it('reports a generic MCP client as L0 and says so to the agent (review F09)', async () => {
    const td = await startTestDaemon(ws());
    const mcp = await startMcp(ws(), { FRIDAY_HARNESS: 'generic' }, { name: 'some-editor', version: '1.0.0' });
    const who = await eventually(
      () => mcp.call('friday_whoami'),
      (r) => (r.structured.daemon as { reachable?: boolean } | undefined)?.reachable === true,
    );
    expect(who.structured, who.text).toMatchObject({ enforcement_level: 'L0', enforcement_status: 'observed' });
    expect(who.text).toContain('Friday cannot check your tool calls in this session');
    const h = td.daemon.state.q.harnesses(td.project.project_id).find((x) => x.vendor === 'generic');
    expect(h).toMatchObject({ version: '1.0.0', enforcement_level: 'L0' });
    expect(h?.adapter_version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('says honestly that acknowledging messages is not available yet (review F11)', async () => {
    await startTestDaemon(ws());
    const mcp = await startMcp(ws());
    const ack = await mcp.call('friday_acknowledge', { message_ids: ['msg_1'] });
    expect(ack.structured).toMatchObject({ acknowledged: [], supported: false });
    expect(ack.text).toContain('Nothing was acknowledged');
  });

  it('rejects invalid tool arguments without crashing', async () => {
    await startTestDaemon(ws());
    const mcp = await startMcp(ws());
    const bad = await mcp.call('friday_task_claim', { task_id: 42 });
    expect(bad.isError).toBe(true);
    const fine = await mcp.call('friday_whoami');
    expect(fine.isError).toBe(false);
  });

  it('explains when the daemon is not running instead of failing', async () => {
    const { initTestProject } = await import('../helpers/daemon.js');
    initTestProject(ws());
    const mcp = await startMcp(ws());
    const who = await mcp.call('friday_whoami');
    expect(who.isError).toBe(false);
    expect(who.text).toContain('friday run');
    expect(who.structured).toMatchObject({ daemon: { reachable: false } });
  });

  it('disconnects from Friday and exits when stdin closes (no orphan process)', async () => {
    const td = await startTestDaemon(ws());
    const mcp = await startMcp(ws());
    await eventually(
      () => mcp.call('friday_whoami'),
      (r) => r.structured.harness_id !== undefined,
    );
    const pid = mcp.pid as number;
    await mcp.close();
    expect(await waitForPidGone(pid, 5000)).toBe(true);
    const harnesses = await td.operator.get<{ harnesses: { status: string }[] }>(td.operator.projectPath('/harnesses'));
    expect(harnesses.harnesses.map((h) => h.status)).toEqual(['DISCONNECTED']);
  });
});
