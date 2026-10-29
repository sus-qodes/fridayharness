/**
 * The spending cap per task (plan M11.5): the cap travels in `task.start`; an attempt whose reported
 * cost reaches it is told to stop and stays open for a short grace, in which the report of how it
 * ended (a spawn adapter sends it right after the cost) is still recorded as what it is; with no such
 * report, the attempt ends once as a fatal error `budget_exceeded` and the task waits for a human.
 * The usage row shows the cap beside the cost either way. The reports here are made by hand, shaped
 * as a spawn adapter sends them.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { type Actor, AgentResultParams, HarnessRegisterParams, type TaskStartParams } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { BUDGET_STOP_GRACE_MS, type Caller, FridayState } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-user' };

let db: SqlDatabase;
let clock: FakeClock;

/** A state with the project's cap (null: none), as the daemon configures it from `routing.task_budget_usd`. */
function open(cap: number | null): FridayState {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-18T10:00:00.000Z');
  const state = new FridayState({ db, clock, ids: sequentialIds(), config: { taskBudgetUsd: cap } });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
  return state;
}

function register(state: FridayState, key: string, agent: string, mode: 'attach' | 'spawn') {
  return state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `${mode === 'spawn' ? 'generic' : 'claude-code'}:${PROJECT}:${key}`,
      vendor: mode === 'spawn' ? 'generic' : 'claude-code',
      name: key,
      attach_mode: mode,
      project_id: PROJECT,
      capabilities: { task_start: mode === 'spawn', task_cancel: mode === 'spawn' },
      agent: { agent_key: agent, role: 'developer' },
      host: { session_id: `sess-${key}` },
    }),
  );
}

/** A spawn harness takes a task: the queued `task.start` is accepted, and the run is this session's. */
function startSpawn(state: FridayState, key: string, agent: string) {
  const task = state.createTask(PROJECT, human, { summary: 'Add discount codes', ready: true });
  const fake = register(state, key, agent, 'spawn');
  state.assignTask(PROJECT, human, task.task_id, agent);
  const [start] = state.pollOutbox(PROJECT, fake.harness_id);
  if (!start) throw new Error('no task.start was queued');
  state.ackOutbox(PROJECT, fake.harness_id, [{ message_id: start.message_id, accepted: true }]);
  const params = start.params as TaskStartParams;
  const caller: Caller = { harness_id: fake.harness_id, agent_id: fake.agent_id };
  return { task, fake, caller, start: params, runId: params.run_id };
}

/** A `host.usage` report as a spawn adapter sends it over `agent.event`. */
function usage(state: FridayState, agentId: string, taskId: string, runId: string, data: Record<string, unknown>) {
  state.recordObservation(
    PROJECT,
    { kind: 'agent', id: agentId },
    'agent.event',
    { task_id: taskId, run_id: runId, event_type: 'host.usage', summary: null, data },
    [
      { kind: 'task', id: taskId },
      { kind: 'run', id: runId },
    ],
  );
}

/** The report of how the attempt ended, as a spawn adapter sends it right after the cost. */
function claim(state: FridayState, caller: Caller, taskId: string, runId: string, status = 'completed_claim') {
  return state.submitResult(
    PROJECT,
    caller,
    AgentResultParams.parse({
      idempotency_key: `claim-${runId}-${status}`,
      task_id: taskId,
      run_id: runId,
      status,
      summary: status === 'blocked' ? 'the payment provider needs a sandbox key' : 'discount codes added',
      changed_paths: ['src/discounts.ts'],
      ...(status === 'blocked' ? { blocked_reason: 'no sandbox key for the payment provider' } : {}),
    }),
  );
}

/** The cost report past the cap, as the daemon judges it: the host is told to stop, the run stays open. */
function reachCap(state: FridayState, s: ReturnType<typeof startSpawn>, cost = 0.0123, cap = 0.01) {
  usage(state, s.fake.agent_id, s.task.task_id, s.runId, {
    cost_usd: cost,
    input_tokens: 1200,
    output_tokens: 80,
    turns: 3,
  });
  const judged = state.enforceTaskBudget(PROJECT, { run_id: s.runId, cost_usd: cost, cap_usd: cap });
  expect(judged).toEqual({ stopped: true, task_status: 'RUNNING' });
  expect(state.q.run(s.runId)).toMatchObject({ status: 'ACTIVE' });
  expect(state.q.task(PROJECT, s.task.task_id)).toMatchObject({ status: 'RUNNING', current_run_id: s.runId });
  return judged;
}

/** The grace passes: the lease tick judges the stop. */
function graceOver(state: FridayState) {
  clock.advance(BUDGET_STOP_GRACE_MS + 1);
  return state.tick(PROJECT).budget_stopped;
}

const exceeded = (state: FridayState, runId: string) =>
  state.store.readByRef(PROJECT, 'run', runId).filter((e) => e.type === 'budget.exceeded');

const nothing = { stopped: false, task_status: null };

describe('the spending cap per task (plan M11.5)', () => {
  it('carries the cap in task.start, and at the cap records the figures once, tells the host to stop and keeps the run open', () => {
    const state = open(0.01);
    const s = startSpawn(state, 'fake-1', 'dev-1');
    const { task, fake, start, runId } = s;
    expect(start.budget_usd).toBe(0.01);
    expect(state.q.task(PROJECT, task.task_id).status).toBe('RUNNING');

    // Below the cap, a report without a cost, and no cap at all: nothing happens.
    usage(state, fake.agent_id, task.task_id, runId, { cost_usd: 0.004, input_tokens: 100 });
    expect(state.enforceTaskBudget(PROJECT, { run_id: runId, cost_usd: 0.004, cap_usd: 0.01 })).toEqual(nothing);
    expect(state.enforceTaskBudget(PROJECT, { run_id: runId, cost_usd: null, cap_usd: 0.01 })).toEqual(nothing);
    expect(state.enforceTaskBudget(PROJECT, { run_id: runId, cost_usd: undefined, cap_usd: 0.01 })).toEqual(nothing);
    expect(state.enforceTaskBudget(PROJECT, { run_id: runId, cost_usd: 5, cap_usd: null })).toEqual(nothing);
    expect(state.enforceTaskBudget(PROJECT, { run_id: runId, cost_usd: 5, cap_usd: 0 })).toEqual(nothing);
    expect(state.q.task(PROJECT, task.task_id).status).toBe('RUNNING');
    expect(exceeded(state, runId)).toEqual([]);

    // At the cap: the figures once, the host told to stop; the attempt is still open for its report.
    clock.advance(1000);
    reachCap(state, s);
    expect(exceeded(state, runId).map((e) => e.payload)).toEqual([
      { task_id: task.task_id, run_id: runId, attempt: 1, cost_usd: 0.0123, cap_usd: 0.01 },
    ]);
    const cancel = state.pollOutbox(PROJECT, fake.harness_id).find((m) => m.method === 'task.cancel');
    expect(cancel?.params).toMatchObject({
      task_id: task.task_id,
      run_id: runId,
      reason: expect.stringContaining('budget_exceeded'),
    });
    // Nothing is decided yet: no error, no question, the agent still on the task.
    expect(state.agentErrors(PROJECT, task.task_id)).toEqual([]);
    expect(state.q.escalations(PROJECT, 'pending')).toEqual([]);
    expect(state.q.agent(fake.agent_id)).toMatchObject({ status: 'BUSY', current_task_id: task.task_id });

    // The host's final figures during the grace: read, and judged once only.
    usage(state, fake.agent_id, task.task_id, runId, {
      cost_usd: 0.02,
      input_tokens: 1500,
      output_tokens: 90,
      turns: 4,
    });
    expect(state.enforceTaskBudget(PROJECT, { run_id: runId, cost_usd: 0.02, cap_usd: 0.01 })).toEqual(nothing);
    expect(exceeded(state, runId)).toHaveLength(1);
    expect(state.q.run(runId)).toMatchObject({ status: 'ACTIVE' });
  });

  it('records the completion claim that follows the cost within the grace: the task is ready for verification, the cap on record', () => {
    const state = open(0.01);
    const s = startSpawn(state, 'fake-2', 'dev-2');
    reachCap(state, s);
    clock.advance(200);
    const result = claim(state, s.caller, s.task.task_id, s.runId);
    expect(result.task_status).toBe('READY_FOR_VERIFICATION');
    expect(state.q.task(PROJECT, s.task.task_id)).toMatchObject({ status: 'READY_FOR_VERIFICATION' });
    expect(state.q.run(s.runId)).toMatchObject({ status: 'ENDED', outcome: 'completed_claim', ended_at: clock.now() });
    expect(state.q.agent(s.fake.agent_id)).toMatchObject({ status: 'AVAILABLE', current_task_id: null });
    // The cap was reached, and that stays on record; no error, no question: the work is done.
    expect(exceeded(state, s.runId)).toHaveLength(1);
    expect(state.agentErrors(PROJECT, s.task.task_id)).toEqual([]);
    expect(state.q.escalations(PROJECT, 'pending')).toEqual([]);
    // The grace passing changes nothing more.
    expect(graceOver(state)).toEqual([]);
    expect(state.q.task(PROJECT, s.task.task_id)).toMatchObject({ status: 'READY_FOR_VERIFICATION' });
    // The usage row: the cost beside the cap that was reached.
    const [row] = state.q.usageReport(PROJECT, { taskId: s.task.task_id }).rows;
    expect(row?.host).toMatchObject({ reported: true, cost_usd: 0.0123, cap_usd: 0.01, turns: 3 });
    // A cost reported past the cap once more, for an attempt that is over: read, not acted on.
    expect(state.enforceTaskBudget(PROJECT, { run_id: s.runId, cost_usd: 0.03, cap_usd: 0.01 })).toEqual(nothing);
  });

  it('with no report of the end, the grace passes and the attempt ends once as budget_exceeded, for a human', () => {
    const state = open(0.01);
    const s = startSpawn(state, 'fake-3', 'dev-3');
    const { task, fake, runId } = s;
    reachCap(state, s);

    // Within the grace, the tick leaves the attempt alone.
    clock.advance(BUDGET_STOP_GRACE_MS - 1000);
    expect(state.tick(PROJECT).budget_stopped).toEqual([]);
    expect(state.q.run(runId)).toMatchObject({ status: 'ACTIVE' });

    // The grace passes: the attempt ends, once, as Friday's decision.
    clock.advance(1001);
    expect(state.tick(PROJECT).budget_stopped).toEqual([runId]);
    expect(state.q.task(PROJECT, task.task_id)).toMatchObject({
      status: 'WAITING',
      waiting_reason: 'blocked',
      current_run_id: runId,
    });
    expect(state.q.run(runId)).toMatchObject({ status: 'ENDED', outcome: 'failed', ended_at: clock.now() });
    // The fatal error the recovery assessment names, with the figures of the report that reached the cap.
    expect(state.agentErrors(PROJECT, task.task_id)).toEqual([
      "budget_exceeded: attempt 1 reported $0.0123, at or above the task's spending cap of $0.01 (routing.task_budget_usd)",
    ]);
    // The agent is free again; a human is asked, with the figures and the recovery options.
    expect(state.q.agent(fake.agent_id)).toMatchObject({ status: 'AVAILABLE', current_task_id: null });
    const questions = state.q.escalations(PROJECT, 'pending');
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ kind: 'recovery_needed', task_id: task.task_id });
    expect(JSON.parse(String(questions[0]?.details_json))).toEqual({
      reason: 'budget_exceeded',
      run_id: runId,
      attempt: 1,
      cost_usd: 0.0123,
      cap_usd: 0.01,
    });
    expect(String(questions[0]?.question)).toContain('reported $0.0123 against routing.task_budget_usd $0.01');
    expect(JSON.parse(String(questions[0]?.options_json))).toEqual([
      `friday recover ${task.task_id} --action reassign`,
      `friday recover ${task.task_id} --action restart`,
      `friday task cancel ${task.task_id}`,
    ]);

    // Another tick, and a late claim: the attempt ended once, and is over.
    expect(graceOver(state)).toEqual([]);
    expect(() => claim(state, s.caller, task.task_id, runId)).toThrow(/invalid_state_transition|is ENDED/);
    expect(state.q.escalations(PROJECT, 'pending')).toHaveLength(1);
    expect(exceeded(state, runId)).toHaveLength(1);

    // The host's final figures after the stop: read, and nothing more happens.
    usage(state, fake.agent_id, task.task_id, runId, {
      cost_usd: 0.02,
      input_tokens: 1500,
      output_tokens: 90,
      turns: 4,
    });
    expect(state.enforceTaskBudget(PROJECT, { run_id: runId, cost_usd: 0.02, cap_usd: 0.01 })).toEqual(nothing);
    expect(state.q.task(PROJECT, task.task_id)).toMatchObject({ status: 'WAITING', waiting_reason: 'blocked' });

    // The usage row: the last report's cost, with the cap the attempt was stopped at beside it.
    const [row] = state.q.usageReport(PROJECT, { taskId: task.task_id }).rows;
    expect(row?.host).toEqual({
      reported: true,
      input_tokens: 1500,
      output_tokens: 90,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      cost_usd: 0.02,
      cap_usd: 0.01,
      turns: 4,
      model: null,
    });
  });

  it('refuses a claim from another session during the grace, and the attempt still ends at the cap', () => {
    const state = open(0.01);
    const s = startSpawn(state, 'fake-4', 'dev-4');
    const other = register(state, 'fake-other', 'dev-other', 'spawn');
    reachCap(state, s);
    expect(() =>
      claim(state, { harness_id: other.harness_id, agent_id: other.agent_id }, s.task.task_id, s.runId),
    ).toThrow(/permission_denied|another session/);
    expect(state.q.run(s.runId)).toMatchObject({ status: 'ACTIVE' });
    expect(state.q.task(PROJECT, s.task.task_id)).toMatchObject({ status: 'RUNNING', current_run_id: s.runId });
    expect(graceOver(state)).toEqual([s.runId]);
    expect(state.q.run(s.runId)).toMatchObject({ status: 'ENDED', outcome: 'failed' });
    expect(state.q.task(PROJECT, s.task.task_id)).toMatchObject({ status: 'WAITING', waiting_reason: 'blocked' });
  });

  it('ends the attempt at the cap when the stopped host reports its own fatal error, with both errors on record', () => {
    // Claude Code stopped by its own --max-budget-usd reports the error right after the usage it carries.
    const state = open(0.01);
    const s = startSpawn(state, 'fake-5', 'dev-5');
    const { task, runId } = s;
    reachCap(state, s, 0.011);
    const late = state.reportAgentError(PROJECT, s.caller, {
      task_id: task.task_id,
      run_id: runId,
      message: 'the Claude Code turn ended: error_max_budget_usd',
      fatal: true,
    });
    expect(late.task_status).toBe('WAITING');
    // The task waits for a human, not for the recovery sweep; the attempt ended once.
    expect(state.q.task(PROJECT, task.task_id)).toMatchObject({ status: 'WAITING', waiting_reason: 'blocked' });
    expect(state.q.run(runId)).toMatchObject({ status: 'ENDED', outcome: 'failed' });
    expect(state.agentErrors(PROJECT, task.task_id)).toEqual([
      'the Claude Code turn ended: error_max_budget_usd',
      "budget_exceeded: attempt 1 reported $0.011, at or above the task's spending cap of $0.01 (routing.task_budget_usd)",
    ]);
    const questions = state.q.escalations(PROJECT, 'pending');
    expect(questions).toHaveLength(1);
    expect(JSON.parse(String(questions[0]?.details_json))).toMatchObject({ reason: 'budget_exceeded', run_id: runId });
    // The grace passing afterwards changes nothing more.
    expect(graceOver(state)).toEqual([]);
    expect(state.q.escalations(PROJECT, 'pending')).toHaveLength(1);
  });

  it('records a blocked result within the grace as such, and the attempt ends at the cap when the grace passes', () => {
    const state = open(0.01);
    const s = startSpawn(state, 'fake-6', 'dev-6');
    reachCap(state, s);
    const result = claim(state, s.caller, s.task.task_id, s.runId, 'blocked');
    expect(result.task_status).toBe('WAITING');
    expect(state.q.task(PROJECT, s.task.task_id)).toMatchObject({ status: 'WAITING', waiting_reason: 'blocked' });
    const blocked = state.store
      .readByRef(PROJECT, 'task', s.task.task_id)
      .find(
        (e) =>
          e.type === 'task.waiting' &&
          String((e.payload as { transition?: { reason?: string } }).transition?.reason).includes('sandbox key'),
      );
    expect(blocked).toBeDefined();
    // A blocked result leaves the run open, as always; the cap closes it when the grace passes.
    expect(state.q.run(s.runId)).toMatchObject({ status: 'ACTIVE' });
    expect(graceOver(state)).toEqual([s.runId]);
    expect(state.q.run(s.runId)).toMatchObject({ status: 'ENDED', outcome: 'failed' });
    expect(state.q.task(PROJECT, s.task.task_id)).toMatchObject({ status: 'WAITING', waiting_reason: 'blocked' });
    expect(state.q.agent(s.fake.agent_id)).toMatchObject({ status: 'AVAILABLE', current_task_id: null });
    expect(state.q.escalations(PROJECT, 'pending')).toHaveLength(1);
  });

  it('judges an attached session’s attempt the same way, also while its task waits, with nothing to cancel', () => {
    const state = open(null);
    const task = state.createTask(PROJECT, human, { summary: 'Document the checkout', assign_agent_key: 'dev-7' });
    const cc = register(state, 'cc-7', 'dev-7', 'attach');
    const caller = { harness_id: cc.harness_id, agent_id: cc.agent_id };
    const run = state.claimTask(PROJECT, caller, { task_id: task.task_id });
    // The agent set its task waiting for an approval; the cost report reaches the cap meanwhile.
    state.updateTask(PROJECT, caller, {
      task_id: task.task_id,
      run_id: run.run_id,
      status: 'waiting',
      waiting_reason: 'human_approval',
    });
    expect(state.enforceTaskBudget(PROJECT, { run_id: run.run_id, cost_usd: 1, cap_usd: 0.5 })).toEqual({
      stopped: true,
      task_status: 'WAITING',
    });
    expect(state.pollOutbox(PROJECT, cc.harness_id)).toEqual([]);
    expect(exceeded(state, run.run_id)).toHaveLength(1);
    expect(state.q.task(PROJECT, task.task_id)).toMatchObject({ status: 'WAITING', waiting_reason: 'human_approval' });
    expect(graceOver(state)).toEqual([run.run_id]);
    expect(state.q.task(PROJECT, task.task_id)).toMatchObject({ status: 'WAITING', waiting_reason: 'blocked' });
    expect(state.q.run(run.run_id)).toMatchObject({ status: 'ENDED', outcome: 'failed' });
  });

  it('without a cap, task.start names none and no report is judged', () => {
    const state = open(null);
    const { task, fake, start, runId } = startSpawn(state, 'fake-8', 'dev-8');
    expect(start.budget_usd).toBeNull();
    usage(state, fake.agent_id, task.task_id, runId, { cost_usd: 100, input_tokens: 1 });
    expect(state.enforceTaskBudget(PROJECT, { run_id: runId, cost_usd: 100, cap_usd: undefined })).toEqual(nothing);
    expect(state.q.task(PROJECT, task.task_id).status).toBe('RUNNING');
    expect(exceeded(state, runId)).toEqual([]);
    expect(graceOver(state)).toEqual([]);
    const [row] = state.q.usageReport(PROJECT, { taskId: task.task_id }).rows;
    expect(row?.host).toMatchObject({ reported: true, cost_usd: 100, cap_usd: null });
  });
});
