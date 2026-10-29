/**
 * The spending cap per task through the daemon (plan M11.5): `routing.task_budget_usd` stops an
 * attempt whose reported cost reaches it, once, for any host that reports a cost. The report of how
 * the attempt ended, which a spawn adapter sends right after the cost, is still recorded as what it
 * is; with none, the attempt ends for a human once the grace passes. Unset, nothing changes. A
 * FakeHarness plays a spawned host that reports past the cap.
 */
import type { RecoveryAssessment, TaskStartParams, TaskView, UsageReport } from '@friday/protocol';
import { BUDGET_STOP_GRACE_MS } from '@friday/state';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

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

/** The project's cap, appended to the generated config.yaml as a top-level block. */
const CAP = 'routing:\n  task_budget_usd: 0.01\n';

/** A daemon with the cap, on a clock the test advances past the grace. */
async function capped() {
  const clock = new FakeClock(new Date().toISOString());
  const td = await startTestDaemon(ws(), { git: true, brain: false, extraConfig: CAP, clock });
  // A moment after the start: on this frozen clock a stop would otherwise fall on the very instant
  // Friday began holding its lease judgements, and be held with them as a stop from before a pause.
  clock.advance(1_000);
  return { td, clock, pid: td.project.project_id };
}

async function assigned(td: TestDaemon, agent: string): Promise<string> {
  const t = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: `work of ${agent}`,
    scope: { write: ['src/**'], read: [] },
    ready: true,
  });
  await td.operator.post(td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: agent });
  return t.task_id;
}

async function eventually<T>(fn: () => T, ok: (v: T) => boolean, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The host accepted the start: the task runs on this attempt. */
async function started(td: TestDaemon, fake: FakeHarness, taskId: string): Promise<TaskStartParams> {
  const start = (await fake.waitFor('task.start', 30_000)).params as TaskStartParams;
  await eventually(
    () => td.daemon.state.q.task(td.project.project_id, taskId).status,
    (s) => s === 'RUNNING',
    'the accepted start',
  );
  return start;
}

const exceeded = (td: TestDaemon, runId: string) =>
  td.daemon.state.store.readByRef(td.project.project_id, 'run', runId).filter((e) => e.type === 'budget.exceeded');

/** The attempt reports its cost past the cap: Friday records the figures once and tells the host to stop. */
async function reachCap(td: TestDaemon, fake: FakeHarness, ids: { task_id: string; run_id: string }) {
  await fake.client.emitEvent({
    ...ids,
    event_type: 'host.usage',
    data: { cost_usd: 0.0123, input_tokens: 1200, output_tokens: 80, turns: 3 },
  });
  const pid = td.project.project_id;
  expect(td.daemon.state.q.task(pid, ids.task_id)).toMatchObject({ status: 'RUNNING', current_run_id: ids.run_id });
  expect(td.daemon.state.q.run(ids.run_id)).toMatchObject({ status: 'ACTIVE' });
  expect(exceeded(td, ids.run_id).map((e) => e.payload)).toEqual([
    { task_id: ids.task_id, run_id: ids.run_id, attempt: 1, cost_usd: 0.0123, cap_usd: 0.01 },
  ]);
  const cancel = await fake.waitFor('task.cancel', 10_000);
  expect(cancel.params).toMatchObject({ ...ids, reason: expect.stringContaining('budget_exceeded') });
}

describe('the spending cap per task (plan M11.5)', () => {
  it('stops a host that reports past the cap, once, and the task waits for a human when no report of the end follows', async () => {
    const { td, clock, pid } = await capped();
    const fake = await FakeHarness.connect(td, { agentKey: 'spawned' });
    const taskId = await assigned(td, 'spawned');
    const start = await started(td, fake, taskId);
    // The start carries the cap, for a spawn adapter whose host enforces one.
    expect(start.budget_usd).toBe(0.01);
    const ids = { task_id: taskId, run_id: start.run_id };
    const task = () => td.daemon.state.q.task(pid, taskId);

    // A report without a cost, and one below the cap, change nothing.
    await fake.client.emitEvent({ ...ids, event_type: 'host.usage', data: { cost_usd: null, input_tokens: 10 } });
    await fake.client.emitEvent({ ...ids, event_type: 'host.usage', data: { cost_usd: 0.009, input_tokens: 900 } });
    expect(task().status).toBe('RUNNING');
    expect(exceeded(td, start.run_id)).toEqual([]);

    // At the cap: the figures once, the host told to stop; the attempt stays open for its report.
    await reachCap(td, fake, ids);
    // The simulated work really stops.
    const settled = await eventually(
      () => fake.workDone(taskId),
      () => true,
      'the work counter',
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.workDone(taskId)).toBe(settled);

    // The host's final figures arrive during the grace: recorded, and judged once only.
    await fake.client.emitEvent({
      ...ids,
      event_type: 'host.usage',
      data: { cost_usd: 0.02, input_tokens: 1500, output_tokens: 90, turns: 4 },
    });
    expect(exceeded(td, start.run_id)).toHaveLength(1);
    expect(task()).toMatchObject({ status: 'RUNNING' });
    expect(td.daemon.state.q.escalations(pid, 'pending').filter((e) => e.task_id === taskId)).toEqual([]);

    // No report of the end follows: when the grace passes, the attempt ends as a fatal error.
    clock.advance(BUDGET_STOP_GRACE_MS + 1_000);
    expect(td.daemon.tick().budget_stopped).toEqual([start.run_id]);
    expect(task()).toMatchObject({ status: 'WAITING', waiting_reason: 'blocked', current_run_id: start.run_id });
    expect(td.daemon.state.q.run(start.run_id)).toMatchObject({ status: 'ENDED', outcome: 'failed' });

    // A human is asked once, with the figures; recovery names the error and offers its actions,
    // none of them automatic: the sweep leaves the task to the human.
    const questions = td.daemon.state.q.escalations(pid, 'pending').filter((e) => e.task_id === taskId);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ kind: 'recovery_needed' });
    expect(JSON.parse(String(questions[0]?.details_json))).toMatchObject({
      reason: 'budget_exceeded',
      run_id: start.run_id,
      cost_usd: 0.0123,
      cap_usd: 0.01,
    });
    const { assessment } = await td.operator.get<{ assessment: RecoveryAssessment }>(
      td.operator.projectPath(`/tasks/${taskId}/recovery`),
    );
    expect(assessment.errors).toEqual({
      total: 1,
      same_as_last: 1,
      last: "budget_exceeded: attempt 1 reported $0.0123, at or above the task's spending cap of $0.01 (routing.task_budget_usd)",
    });
    expect(assessment.options.find((o) => o.action === 'reassign')).toMatchObject({
      available: true,
      recommended: false,
    });
    expect(assessment.options.find((o) => o.action === 'cancel')).toMatchObject({ available: true });
    expect(await td.daemon.recovery.sweep()).toEqual([]);
    expect(task()).toMatchObject({ status: 'WAITING', waiting_reason: 'blocked' });

    // A claim that comes after the stop is refused: the attempt is over.
    await expect(
      fake.client.reportResult({
        ...ids,
        status: 'completed_claim',
        summary: 'done late',
        changed_paths: [],
        checks: [],
      }),
    ).rejects.toMatchObject({ code: 'COS-2002' });
    expect(td.daemon.tick().budget_stopped).toEqual([]);

    // The usage row shows the cap beside the cost that reached it.
    const report = await td.operator.get<UsageReport>(td.operator.projectPath(`/usage?task=${taskId}`));
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.host).toMatchObject({ reported: true, cost_usd: 0.02, cap_usd: 0.01, turns: 4 });
    await fake.close();
  }, 60_000);

  it('records the completion claim that follows the cost past the cap: the work is verified, not run again', async () => {
    const { td, clock, pid } = await capped();
    const fake = await FakeHarness.connect(td, { agentKey: 'spawned' });
    const taskId = await assigned(td, 'spawned');
    const start = await started(td, fake, taskId);
    const ids = { task_id: taskId, run_id: start.run_id };
    const task = () => td.daemon.state.q.task(pid, taskId);

    // The adapter delivers the attempt's cost, then at once how the attempt ended: a claim.
    await reachCap(td, fake, ids);
    const result = await fake.client.reportResult({
      ...ids,
      status: 'completed_claim',
      summary: 'discount codes added',
      changed_paths: [],
      checks: [],
    });
    expect(result.task_status).toBe('READY_FOR_VERIFICATION');
    expect(td.daemon.state.q.run(start.run_id)).toMatchObject({ status: 'ENDED', outcome: 'completed_claim' });
    expect(task().status).not.toBe('WAITING');
    // The cap was reached, and that stays on record; no error, no question: the work is done.
    expect(exceeded(td, start.run_id)).toHaveLength(1);
    expect(td.daemon.state.q.escalations(pid, 'pending').filter((e) => e.task_id === taskId)).toEqual([]);
    const { assessment } = await td.operator.get<{ assessment: RecoveryAssessment }>(
      td.operator.projectPath(`/tasks/${taskId}/recovery`),
    );
    expect(assessment.errors.total).toBe(0);

    // The grace passing changes nothing more.
    clock.advance(BUDGET_STOP_GRACE_MS + 1_000);
    expect(td.daemon.tick().budget_stopped).toEqual([]);
    expect(task().status).not.toBe('WAITING');
    expect(td.daemon.state.q.escalations(pid, 'pending').filter((e) => e.task_id === taskId)).toEqual([]);

    // The usage row shows the cost beside the cap it reached.
    const report = await td.operator.get<UsageReport>(td.operator.projectPath(`/usage?task=${taskId}`));
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.host).toMatchObject({ reported: true, cost_usd: 0.0123, cap_usd: 0.01, turns: 3 });
    await fake.close();
  }, 60_000);

  it('a cap unset changes nothing', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const pid = td.project.project_id;
    const fake = await FakeHarness.connect(td, { agentKey: 'free' });
    const taskId = await assigned(td, 'free');
    const start = await started(td, fake, taskId);
    expect(start.budget_usd).toBeNull();
    const ids = { task_id: taskId, run_id: start.run_id };
    await fake.client.emitEvent({ ...ids, event_type: 'host.usage', data: { cost_usd: 100, input_tokens: 1 } });
    expect(td.daemon.state.q.task(pid, taskId)).toMatchObject({ status: 'RUNNING', current_run_id: start.run_id });
    expect(exceeded(td, start.run_id)).toEqual([]);
    expect(fake.received.some((m) => m.method === 'task.cancel')).toBe(false);
    expect(td.daemon.state.q.escalations(pid, 'pending')).toEqual([]);
    expect(td.daemon.tick().budget_stopped).toEqual([]);
    const report = await td.operator.get<UsageReport>(td.operator.projectPath(`/usage?task=${taskId}`));
    expect(report.rows[0]?.host).toMatchObject({ reported: true, cost_usd: 100, cap_usd: null });
    await fake.close();
  }, 60_000);
});
