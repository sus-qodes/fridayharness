import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { ControlResult, TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';
import { attachedSession, codeOf, NO_WORKTREES, nextMessage, noMessage, raw, spawnedSession } from '../helpers/ui.js';

/** Pause, resume and halt by effect (docs/frontend/PLAN.md §5.5, FD-09). */

const ws = useTestWorkspace();

const control = async (
  td: Awaited<ReturnType<typeof startTestDaemon>>,
  what: 'pause' | 'resume' | 'halt',
  reason?: string,
) => {
  const r = await raw(td, 'POST', td.operator.projectPath(`/control/${what}`), {
    token: td.daemon.tokens.operator,
    body: JSON.stringify(reason ? { reason } : {}),
  });
  expect(r.status, r.text).toBe(200);
  return r.json as unknown as ControlResult;
};
const taskOf = async (td: Awaited<ReturnType<typeof startTestDaemon>>, id: string) =>
  (await td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${id}`))).task;

describe('pause', () => {
  it('holds an attached session at the tool boundary and refuses new assignments; resuming lifts it', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { pre, dir } = await attachedSession(td);
    const paused = await control(td, 'pause', 'lunch');
    expect(paused.control.paused).toBe(true);
    // An attached session is held, not stopped.
    expect(paused.tasks).toEqual([]);
    expect((await pre('Write', { file_path: path.join(dir, 'a.txt'), content: 'x' }))?.decision).toBe('deny');
    expect((await pre('Bash', { command: 'npm install left-pad' }))?.decision).toBe('deny');
    expect((await pre('Read', { file_path: path.join(dir, 'README.md') }))?.decision ?? 'allow').not.toBe('deny');
    const other = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'another',
      ready: true,
    });
    const assign = await raw(td, 'POST', td.operator.projectPath(`/tasks/${other.task_id}/assign`), {
      token: td.daemon.tokens.operator,
      body: JSON.stringify({ agent_key: 'dev-1' }),
    });
    expect(assign.status).toBe(403);
    expect(codeOf(assign)).toBe('COS-3000');
    await control(td, 'resume');
    expect((await pre('Write', { file_path: path.join(dir, 'a.txt'), content: 'x' }))?.decision ?? 'allow').not.toBe(
      'deny',
    );
  });

  it('withholds a start queued before it until the resume', async () => {
    const td = await startTestDaemon(ws(), { extraConfig: NO_WORKTREES });
    const { client } = await spawnedSession(td, { hooks: true });
    const second = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'second task',
      kind: 'docs',
      scope: { write: ['**'], read: [] },
      ready: true,
    });
    // The agent is busy with its first task: free it, then queue the second start.
    const first = (await td.operator.get<{ tasks: TaskView[] }>(td.operator.projectPath('/tasks'))).tasks.find(
      (t) => t.task_id !== second.task_id,
    ) as TaskView;
    await td.operator.post(td.operator.projectPath(`/tasks/${first.task_id}/cancel`), {});
    await nextMessage(client, 'task.cancel');
    await td.operator.post(td.operator.projectPath(`/tasks/${second.task_id}/assign`), { agent_key: 'sp-1' });
    await control(td, 'pause');
    expect(await noMessage(client, 'task.start')).toBe(true);
    await control(td, 'resume');
    const start = await nextMessage(client, 'task.start');
    expect((start.params as { task_id: string }).task_id).toBe(second.task_id);
  });

  it('does not apply a start delivered before it and accepted during it', async () => {
    const td = await startTestDaemon(ws(), { extraConfig: NO_WORKTREES });
    // Register, assign, and take delivery, but do not acknowledge yet.
    const client = await registerOnly(td);
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'late ack',
      kind: 'docs',
      scope: { write: ['**'], read: [] },
      ready: true,
    });
    await td.operator.post(td.operator.projectPath(`/tasks/${task.task_id}/assign`), { agent_key: 'sp-9' });
    const start = await nextMessage(client, 'task.start');
    await control(td, 'pause');
    const acked = await client.ack([{ message_id: start.message_id, accepted: true, session_ref: 's9' }]);
    expect(acked.current).not.toContain(start.message_id);
    expect((await taskOf(td, task.task_id)).status).toBe('ASSIGNED');
    await control(td, 'resume');
    const again = await nextMessage(client, 'task.start');
    expect(again.message_id).toBe(start.message_id);
    const ok = await client.ack([{ message_id: again.message_id, accepted: true, session_ref: 's9' }]);
    expect(ok.current).toContain(again.message_id);
    expect((await taskOf(td, task.task_id)).status).toBe('RUNNING');
  });

  it('stops a host that changes files without asking, its work released; one held by its hooks keeps running', async () => {
    const td = await startTestDaemon(ws(), { extraConfig: NO_WORKTREES });
    const held = await spawnedSession(td, { agentKey: 'cc-1', hooks: true, summary: 'held by hooks' });
    const unheld = await spawnedSession(td, { agentKey: 'cx-1', hooks: false, summary: 'not held' });
    const r = await control(td, 'pause', 'review time');
    expect(r.tasks).toEqual([{ task_id: unheld.task.task_id, preserved_ref: null, host: 'spawned', stop: 'sent' }]);
    expect((await taskOf(td, unheld.task.task_id)).status).toBe('READY');
    expect((await nextMessage(unheld.client, 'task.cancel')).params).toMatchObject({ task_id: unheld.task.task_id });
    expect((await taskOf(td, held.task.task_id)).status).toBe('RUNNING');
  });
});

describe('halt', () => {
  it('stops every running attempt, reports what it could stop, and leaves Friday paused', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()], extraConfig: NO_WORKTREES });
    const attached = await attachedSession(td);
    const spawned = await spawnedSession(td, { hooks: true, summary: 'spawned work' });
    const r = await control(td, 'halt', 'runaway');
    const byTask = Object.fromEntries(r.tasks.map((t) => [t.task_id, t]));
    expect(byTask[attached.task.task_id]).toMatchObject({ host: 'attached', stop: 'not_possible' });
    expect(byTask[spawned.task.task_id]).toMatchObject({ host: 'spawned', stop: 'sent' });
    for (const id of [attached.task.task_id, spawned.task.task_id]) {
      const t = await taskOf(td, id);
      expect(t.status).toBe('READY');
      expect(t.current_run_id).toBeNull();
    }
    await nextMessage(spawned.client, 'task.cancel');
    const c = td.daemon.state.q.control(td.project.project_id);
    expect(c.paused).toBe(true);
    expect(c.halted_at).not.toBeNull();
  });
});

/** A spawn harness registered without a task. */
async function registerOnly(td: Awaited<ReturnType<typeof startTestDaemon>>) {
  const client = new GenericHarnessClient(td.bootstrap, {
    harness_key: `generic:${td.project.project_id}:spawn:sp-9`,
    vendor: 'generic',
    name: 'Scripted host',
    version: '1.0.0',
    adapter_version: '0.1.0',
    attach_mode: 'spawn',
    project_id: td.project.project_id,
    capabilities: { task_start: true, task_cancel: true, hooks: true },
    agent_key: 'sp-9',
    role: 'developer',
    enforcement_level: 'L1',
    host: { pid: process.pid },
  });
  await client.register();
  return client;
}
