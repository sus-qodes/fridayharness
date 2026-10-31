/** Fault injection regressions for recovery, fencing, and delivery. */
import type { Actor, TaskStartParams, TaskView } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchRpc } from '../../apps/daemon/src/rpc.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
const HUMAN: Actor = { kind: 'human', id: 'reliability-review' };
let savedStateDir: string | undefined;
beforeEach(() => {
  savedStateDir = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = savedStateDir;
});

async function project() {
  const clock = new FakeClock(new Date().toISOString());
  const td = await startTestDaemon(ws(), { git: true, clock });
  return { td, clock };
}

async function running(td: TestDaemon, taskId: string, runId?: string) {
  await vi.waitFor(
    () => {
      const task = td.daemon.state.q.task(td.project.project_id, taskId);
      expect(task.status).toBe('RUNNING');
      if (runId) expect(task.current_run_id).toBe(runId);
    },
    { timeout: 20_000, interval: 20 },
  );
}

async function take(td: TestDaemon, agentKey: string, sessionId?: string) {
  const fake = await FakeHarness.connect(td, {
    agentKey,
    ...(sessionId ? { sessionId } : {}),
  });
  ws().track(fake);
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: 'reliability fault probe',
    scope: { write: ['src/**'], read: [] },
    ready: true,
  });
  await td.operator.post(td.operator.projectPath(`/tasks/${task.task_id}/assign`), { agent_key: agentKey });
  const start = (await fake.waitFor('task.start', 20_000)).params as TaskStartParams;
  await running(td, task.task_id, start.run_id);
  return { fake, start, taskId: task.task_id };
}

describe('reliability audit fault probes', () => {
  it('does not let an old poll consume the new registration’s resume message', async () => {
    const { td } = await project();
    const { fake, start } = await take(td, 'review-old-poll');
    await fake.crash();
    const { state } = td.daemon;
    const auth = state.resolveToken(fake.client.registration.harness_token);
    if (!auth) throw new Error('missing test credential');
    const polled = vi.spyOn(state, 'pollOutbox');
    const oldPoll = dispatchRpc(
      {
        state,
        project: td.project,
        pollIntervalMs: 5,
        compile: async () => {
          throw new Error('unused');
        },
      },
      auth,
      { jsonrpc: '2.0', id: 'old-poll', method: 'harness.poll', params: { wait_ms: 1000, max: 10 } },
    );
    await vi.waitFor(() => expect(polled).toHaveBeenCalled());
    await fake.client.register();
    const old = await oldPoll;
    expect(old).toHaveProperty('error');
    expect(await fake.client.poll()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'task.resume', params: expect.objectContaining({ run_id: start.run_id }) }),
      ]),
    );
  });
  it('holds task transitions and tool writes while recovery changes the checkout', async () => {
    const { td } = await project();
    const { fake, start, taskId } = await take(td, 'review-lock');
    const { state } = td.daemon;
    const pid = td.project.project_id;
    const lock = state.holdTaskRecovery(pid, taskId, state.recoveryVersion(pid, taskId));
    try {
      expect(() => state.releaseTask(pid, HUMAN, taskId, 'concurrent release')).toThrow(/being recovered/);
      expect(() => state.cancelTask(pid, HUMAN, taskId, 'concurrent cancel')).toThrow(/being recovered/);
      const judged = await fake.client.call('tool.check', {
        task_id: taskId,
        run_id: start.run_id,
        tool: 'Write',
        action: { kind: 'write', paths: ['src/locked.ts'] },
      });
      expect(judged).toMatchObject({ decision: 'deny', rule: 'task.recovering' });
      expect(state.q.task(pid, taskId).current_run_id).toBe(start.run_id);
    } finally {
      lock.release();
    }
    expect(state.releaseTask(pid, HUMAN, taskId, 'recovery finished').status).toBe('READY');
  });

  it('keeps automatic recovery blocked when worker termination was not confirmed', async () => {
    const { td } = await project();
    const { fake, start, taskId } = await take(td, 'review-unconfirmed', 'adapter-still-alive');
    await fake.crash();
    await fake.client.reportError({
      task_id: taskId,
      run_id: start.run_id,
      message: 'stop failed',
      fatal: true,
      worker_stopped: false,
    });
    expect(await td.daemon.recovery.sweep()).toEqual([`${taskId}: needs_human`]);
  });
  it('does not release a successor run using an earlier recovery assessment', async () => {
    const { td } = await project();
    const { fake, start, taskId } = await take(td, 'review-race');
    const { state, recovery } = td.daemon;
    const projectId = td.project.project_id;
    const old = await recovery.assess(taskId);
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    // Pause at the asynchronous inspection boundary, as a slow Git call would.
    vi.spyOn(recovery, 'assess').mockImplementationOnce(async () => {
      enter();
      await gate;
      return old;
    });
    const recovering = recovery.perform(taskId, 'reassign', HUMAN, 'recover the first attempt');
    await entered;
    let successor: TaskStartParams;
    try {
      state.releaseTask(projectId, HUMAN, taskId, 'an independent operator replaced the attempt');
      await td.operator.post(td.operator.projectPath(`/tasks/${taskId}/assign`), { agent_key: 'review-race' });
      successor = (
        await fake.waitFor('task.start', 20_000, (m) => (m.params as TaskStartParams).run_id !== start.run_id)
      ).params as TaskStartParams;
      await running(td, taskId, successor.run_id);
    } finally {
      resume();
      await expect(recovering).rejects.toThrow(/stale recovery assessment/);
    }
    expect(state.q.task(projectId, taskId).current_run_id).toBe(successor.run_id);
    expect(state.q.run(successor.run_id).status).toBe('ACTIVE');
  });

  it('can automatically recover a failed worker while its adapter process remains alive', async () => {
    const { td } = await project();
    const { fake, start, taskId } = await take(td, 'review-pid', 'adapter-still-alive');
    // End all simulated worker effects, leaving the registered adapter process alive.
    await fake.crash();
    await fake.client.reportError({
      task_id: taskId,
      run_id: start.run_id,
      message: 'worker exited',
      fatal: true,
      worker_stopped: true,
    });
    expect(td.daemon.state.q.run(start.run_id).status).toBe('ENDED');
    const assessment = await td.daemon.recovery.assess(taskId);
    expect(assessment.harness?.process_alive).toBe(true);
    const assess = vi.spyOn(td.daemon.recovery, 'assess');
    expect(await td.daemon.recovery.sweep()).toEqual([`${taskId}: reassign`]);
    expect(assess).toHaveBeenCalledOnce();
  });

  it('keeps a worker with no progress RUNNING for an hour when the adapter heartbeats', async () => {
    const { td, clock } = await project();
    const { fake, taskId } = await take(td, 'review-silent');
    await fake.crash();
    const stoppedAt = fake.workDone(taskId);
    for (let i = 0; i < 360; i += 1) {
      clock.advance(10_000);
      await fake.client.heartbeat();
      td.daemon.tick();
    }
    expect(fake.workDone(taskId)).toBe(stoppedAt);
    expect(td.daemon.state.q.task(td.project.project_id, taskId).status).toBe('RUNNING');
    expect(await td.daemon.recovery.sweep()).toEqual([]);
  });

  it('shows reconnect as available for the same window the lease manager actually permits', async () => {
    const { td, clock } = await project();
    const { fake, taskId } = await take(td, 'review-window');
    await fake.crash();
    // Friday notices expiry late, as after a stall or laptop suspension.
    clock.advance(90_000);
    td.daemon.tick();
    clock.advance(61_000);
    td.daemon.tick();
    const assessment = await td.daemon.recovery.assess(taskId);
    expect(assessment.harness?.status).toBe('DISCONNECTED');
    expect(assessment.options.find((o) => o.action === 'reconnect')?.available).toBe(true);
  });
});
