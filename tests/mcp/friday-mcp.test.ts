import type { TaskView } from '@friday/protocol';
import { useTestWorkspace, waitForPidGone } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';
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
    const td = await startTestDaemon(ws(), { git: true });
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
    expect(who.structured).toMatchObject({
      agent_key: 'dev-1',
      enforcement_level: 'L1',
      secrets_location: 'private',
      shadow: false,
    });

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
