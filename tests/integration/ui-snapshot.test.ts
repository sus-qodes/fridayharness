import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { UI_API_VERSION } from '@friday/daemon';
import type { DomainEvent, TaskStartParams, TaskView, UiSnapshot } from '@friday/protocol';
import { createTestWorkspace, FakeClock, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it, vi } from 'vitest';
import { UI_API } from '../../apps/ui/src/shell/version.js';
import { escalationFromEvent } from '../../apps/ui/src/sync/rows.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';
import { postHook, toolHook } from '../helpers/hooks.js';
import { attachedSession, NO_WORKTREES, raw, signIn } from '../helpers/ui.js';

/** The board snapshot (docs/frontend/PLAN.md §5.3, FD-08). */

const ws = useTestWorkspace();

const snapshotOf = (td: TestDaemon) => td.operator.get<UiSnapshot>(td.operator.projectPath('/ui/snapshot'));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('the board snapshot', () => {
  it('holds the board at the event head, with what the interface needs about the daemon', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { task, client, run_id } = await attachedSession(td);
    await client.update({
      task_id: task.task_id,
      run_id,
      status: 'waiting',
      waiting_reason: 'blocked',
      note: 'need the API key name',
    });
    const token = await signIn(td);
    const snap = (await raw(td, 'GET', td.operator.projectPath('/ui/snapshot'), { token }))
      .json as unknown as UiSnapshot;
    const head = (await td.operator.get<{ head: number }>(td.operator.projectPath('/events?limit=1'))).head;
    expect(snap.head).toBe(head);
    expect(snap.ui_api).toBe(UI_API_VERSION);
    expect(snap.project).toMatchObject({ has_commit: true, worktrees_mode: 'per_task' });
    expect(snap.config.loaded_hash).toBe(snap.config.current_hash);
    expect(snap.verification).toEqual({ checks: [], auto_on_completion: false });
    const t = snap.tasks.find((x) => x.task_id === task.task_id);
    expect(t).toMatchObject({ status: 'WAITING', agent_key: 'dev-1', waiting_note: 'need the API key name' });
    expect(snap.runs[task.task_id]?.base_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.agents.map((a) => a.agent_key)).toContain('dev-1');
    expect(snap.harnesses[0]).toHaveProperty('observed_model');
    expect(snap.control.paused).toBe(false);
    expect(snap.brain_jobs).toEqual([]);
    expect(snap.truncated).toEqual({});
  });

  it('speaks the API version the page was built for', () => {
    expect(UI_API).toBe(UI_API_VERSION);
  });

  it('says when config.yaml changed since Friday started', async () => {
    const td = await startTestDaemon(ws());
    appendFileSync(path.join(ws().fridayDir, 'config.yaml'), '\n# edited\n');
    const snap = await td.operator.get<UiSnapshot>(td.operator.projectPath('/ui/snapshot'));
    expect(snap.config.current_hash).not.toBe(snap.config.loaded_hash);
  });

  it('carries inbox previews, not bodies, and why a READY task waits', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { client, task } = await attachedSession(td);
    await client.communicate({
      to: 'human',
      mode: 'notification',
      subject: 'long',
      content: `start ${'x'.repeat(5000)}`,
      task_id: task.task_id,
    });
    const loose = await td.operator.post<{ task_id: string }>(td.operator.projectPath('/tasks'), {
      summary: 'nobody can take this',
      kind: 'docs',
      scope: { write: ['**'], read: [] },
      ready: true,
    });
    await td.operator.post(td.operator.projectPath('/brain/run-once'), {});
    const snap = await td.operator.get<UiSnapshot>(td.operator.projectPath('/ui/snapshot'));
    const item = snap.inbox[0] as unknown as Record<string, unknown>;
    expect(item).not.toHaveProperty('body');
    expect(String(item.preview).length).toBe(200);
    const ready = snap.tasks.find((t) => t.task_id === loose.task_id);
    expect(ready?.status).toBe('READY');
    expect(typeof ready?.delegation_note === 'string' || ready?.delegation_note === null).toBe(true);
  });

  it('counts goal progress over all the goal’s tasks, also those finished more than a day ago (review R4)', async () => {
    const clock = new FakeClock(new Date().toISOString());
    const td = await startTestDaemon(ws(), {
      git: true,
      clock,
      extraConfig: NO_WORKTREES,
      brain: { autoStart: false },
    });
    const op = td.operator;
    const goal = await op.post<{ goal_id: string }>(op.projectPath('/goals'), {
      request: 'Two readme changes',
      plan: false,
    });
    const scope = { write: ['README.md'], read: ['**'] };
    const v1 = await op.post<{ plan_id: string; version: number }>(op.projectPath(`/goals/${goal.goal_id}/plans`), {
      draft: {
        objective: 'Two readme changes',
        summary: 'Change the readme twice',
        tasks: [
          { key: 'one', summary: 'Change the readme', acceptance_criteria: ['it changed'], scope, depends_on: [] },
          { key: 'two', summary: 'Change it again', acceptance_criteria: ['it changed'], scope, depends_on: ['one'] },
        ],
      },
    });
    await op.post(op.projectPath(`/plans/${v1.plan_id}/versions/${v1.version}/approve`), {});
    const detail = await op.get<{ active: { tasks: { key: string; task_id: string }[] } }>(
      op.projectPath(`/goals/${goal.goal_id}`),
    );
    const one = detail.active.tasks.find((t) => t.key === 'one')?.task_id as string;
    const two = detail.active.tasks.find((t) => t.key === 'two')?.task_id as string;

    // An agent does the first task and a human verifies it.
    const fake = await FakeHarness.connect(td, { agentKey: 'dev-1' });
    await op.post(op.projectPath(`/tasks/${one}/assign`), { agent_key: 'dev-1' });
    const start = (await fake.waitFor('task.start', 20_000)).params as TaskStartParams;
    await until(
      () => op.get<{ task: TaskView }>(op.projectPath(`/tasks/${one}`)),
      (r) => r.task.status === 'RUNNING',
      'the first task to run',
    );
    writeFileSync(path.join(start.working_directory, 'README.md'), '# test project\n\nchanged\n');
    await fake.client.reportResult({
      task_id: one,
      run_id: start.run_id,
      status: 'completed_claim',
      summary: 'changed the readme',
      changed_paths: ['README.md'],
      checks: [],
    });
    await fake.close();
    const verified = await op.post<{ task: TaskView }>(
      op.projectPath(`/tasks/${one}/verify`),
      {},
      { timeoutMs: 120_000 },
    );
    expect(verified.task.status).toBe('COMPLETED');
    expect((await snapshotOf(td)).goal_progress[goal.goal_id]).toEqual({ total: 2, completed: 1 });

    // A day later the finished task has left the list; the goal's progress still counts it.
    clock.advance(25 * 60 * 60 * 1000);
    const later = await snapshotOf(td);
    expect(later.goals.map((g) => g.goal_id)).toContain(goal.goal_id);
    expect(later.tasks.map((t) => t.task_id)).toEqual([two]);
    expect(later.goal_progress[goal.goal_id]).toEqual({ total: 2, completed: 1 });
    // Cancelled tasks are not part of the total.
    await op.post(op.projectPath(`/tasks/${two}/cancel`), { reason: 'not needed' });
    expect((await snapshotOf(td)).goal_progress[goal.goal_id]).toEqual({ total: 1, completed: 1 });
  });

  it('counts each task’s tool calls from the event log, the same on every read (review R13)', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { task, client, run_id, pre, dir } = await attachedSession(td);
    const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
    const vars = { projectDir: dir, sessionId: 'sess-ui' };
    const readme = { file_path: path.join(dir, 'README.md') };
    // Judged before it runs: a policy decision, not a call that ran.
    expect((await pre('Read', readme))?.decision ?? 'allow').toBe('allow');
    await postHook(daemon, 'PostToolUse', toolHook('PostToolUse', 'Read', readme, vars), { claudePid: 8301 });
    await postHook(
      daemon,
      'PostToolUseFailure',
      toolHook('PostToolUseFailure', 'Bash', { command: 'npm test' }, vars, { error: 'exit code 1' }),
      { claudePid: 8301 },
    );
    // A spawn adapter's report (Codex reports its commands and file changes this way).
    await client.emitEvent({
      task_id: task.task_id,
      run_id,
      event_type: 'tool.completed',
      data: { tool: 'commandExecution' },
    });
    // Not tool calls.
    await client.emitEvent({ task_id: task.task_id, run_id, event_type: 'progress', summary: 'halfway' });
    await client.emitEvent({ task_id: task.task_id, run_id, event_type: 'host.usage', data: { cost_usd: 0.1 } });
    const other = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'nobody touched this',
      kind: 'docs',
      scope: { write: ['**'], read: [] },
    });
    const first = await snapshotOf(td);
    expect(first.tasks.find((t) => t.task_id === task.task_id)?.tool_calls).toBe(3);
    expect(first.tasks.find((t) => t.task_id === other.task_id)?.tool_calls).toBe(0);
    const again = await snapshotOf(td);
    expect(again.tasks.find((t) => t.task_id === task.task_id)?.tool_calls).toBe(3);
  });

  it('counts tool calls only from the events since the last read, always equal to a full recount (review P1b)', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { task, client, run_id } = await attachedSession(td);
    const other = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'another task',
      kind: 'docs',
      scope: { write: ['**'], read: [] },
    });
    const { state } = td.daemon;
    const pid = td.project.project_id;
    // The count as it was taken before: every tool call event that references the task.
    const recount = (taskId: string) =>
      state.store
        .readByRef(pid, 'task', taskId, { types: ['agent.event'], limit: 10_000 })
        .filter((e) =>
          ['tool.completed', 'tool.failed'].includes(String((e.payload as { event_type?: unknown }).event_type)),
        ).length;
    const counted = vi.spyOn(state.q, 'toolCallCounts');
    const prepared = vi.spyOn(state.db, 'prepare');
    let head = 0;
    for (let round = 1; round <= 4; round++) {
      for (let i = 0; i < round; i++) {
        const event_type = i % 2 ? 'tool.failed' : 'tool.completed';
        await client.emitEvent({ task_id: task.task_id, run_id, event_type, data: { tool: 'Bash' } });
      }
      if (round % 2 === 0) {
        await client.emitEvent({ task_id: other.task_id, event_type: 'tool.completed', data: { tool: 'Read' } });
      }
      await client.emitEvent({ task_id: task.task_id, run_id, event_type: 'progress', summary: `round ${round}` });
      const snap = await snapshotOf(td);
      // This read counted the events after the previous one's head, up to its own.
      expect(counted.mock.lastCall?.slice(1)).toEqual([head, snap.head]);
      head = snap.head;
      for (const t of [task, other]) {
        expect(snap.tasks.find((x) => x.task_id === t.task_id)?.tool_calls).toBe(recount(t.task_id));
      }
    }
    expect(recount(task.task_id)).toBe(10);
    expect(recount(other.task_id)).toBe(2);
    // A read with nothing new counts nothing.
    const calls = counted.mock.calls.length;
    expect((await snapshotOf(td)).tasks.find((x) => x.task_id === task.task_id)?.tool_calls).toBe(10);
    expect(counted.mock.calls.length).toBe(calls);
    // The new events are found through the index on (project, type, sequence), not by a scan.
    const sql = prepared.mock.calls.map(([s]) => s).find((s) => s.includes("'tool.completed'")) as string;
    counted.mockRestore();
    prepared.mockRestore();
    const plan = state.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all<{ detail: string }>(pid, 0, head)
      .map((r) => r.detail)
      .join('\n');
    expect(plan).toMatch(
      /SEARCH events USING INDEX ix_events_project_type \(project_id=\? AND type=\? AND sequence>\?/,
    );
    expect(plan).not.toMatch(/SCAN|event_refs/);
  });

  it('keeps each daemon’s tool count to its own database, also for the same project id (review P1b)', async () => {
    const second = await createTestWorkspace();
    ws().track({ close: () => second.cleanup() });
    const a = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const b = await startTestDaemon(second, { git: true, extensions: [claudeCodeHooks()] });
    expect(b.project.project_id).toBe(a.project.project_id);
    const one = await attachedSession(a);
    const two = await attachedSession(b);
    const calls = async (s: typeof one, n: number) => {
      for (let i = 0; i < n; i++) {
        await s.client.emitEvent({ task_id: s.task.task_id, run_id: s.run_id, event_type: 'tool.completed' });
      }
    };
    const shown = async (td: TestDaemon, s: typeof one) =>
      (await snapshotOf(td)).tasks.find((t) => t.task_id === s.task.task_id)?.tool_calls;
    await calls(one, 3);
    const first = await snapshotOf(a);
    expect(first.tasks.find((t) => t.task_id === one.task.task_id)?.tool_calls).toBe(3);
    // The second log has its call early, and runs past the first's head before it is read.
    await calls(two, 1);
    while (b.daemon.state.store.head(b.project.project_id) <= first.head) {
      await two.client.emitEvent({ task_id: two.task.task_id, run_id: two.run_id, event_type: 'progress' });
    }
    expect(await shown(b, two)).toBe(1);
    await calls(one, 2);
    expect(await shown(a, one)).toBe(5);
    await calls(two, 2);
    expect(await shown(b, two)).toBe(3);
  });

  it('shows a question read from its event exactly as the snapshot lists it (review R2)', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { client, task, run_id } = await attachedSession(td);
    await client.escalate({
      task_id: task.task_id,
      run_id,
      question: 'Which plan names should the page show?',
      options: ['Basic and Pro', 'Free and Team'],
      context: 'the spec names none',
    });
    const { events } = await td.operator.get<{ events: DomainEvent[] }>(
      td.operator.projectPath('/events?type=escalation.requested'),
    );
    const shown = escalationFromEvent(events.at(-1) as DomainEvent);
    expect(shown).not.toBeNull();
    const listed = (await snapshotOf(td)).escalations.find((e) => e.escalation_id === shown?.escalation_id);
    expect(shown).toEqual(listed);
  });
});
