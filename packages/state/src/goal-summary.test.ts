/**
 * What Friday did for a goal (plan M12.7), counted from events made by hand through the state's
 * own commands: verdicts, rework, approvals asked, policy refusals, lost and resumed attempts, the
 * hosts' usage reports and the Master Brain's calls. Nothing estimated; a figure nobody reported
 * is null, never 0.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { type Actor, HarnessRegisterParams, type TaskView } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Caller, FridayState, type PlanTaskInput } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-user' };
const BRAIN: Actor = { kind: 'master_brain', id: 'master-brain' };

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-14T10:00:00.000Z');
  state = new FridayState({ db, clock, ids: sequentialIds() });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

/** An attached session for an agent; registering the same key again is the same harness coming back. */
function register(key: string): Caller {
  const r = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `claude-code:${PROJECT}:${key}`,
      vendor: 'claude-code',
      name: key,
      attach_mode: 'attach',
      project_id: PROJECT,
      agent: { agent_key: key, role: 'developer' },
      host: { session_id: `sess-${key}` },
    }),
  );
  return { harness_id: r.harness_id, agent_id: r.agent_id };
}

const planTask = (key: string): PlanTaskInput => ({
  key,
  change: 'new',
  task_id: null,
  kind: 'implementation',
  summary: `do ${key}`,
  description: null,
  acceptance_criteria: ['done'],
  depends_on: [],
  scope: { write: [`${key}/**`], read: [] },
  role: 'developer',
  priority: 'normal',
  risk_level: 'low',
  note: null,
});

/** A goal with an approved plan of these tasks, created without the Master Brain. */
function goal(keys: string[]): { goalId: string; tasks: Record<string, TaskView> } {
  const g = state.createGoal(PROJECT, human, { request: `a goal with ${keys.join(', ')}`, plan: false });
  const v = state.proposePlan(PROJECT, human, g.goal_id, {
    summary: 'the plan',
    rationale: '',
    needs_human: null,
    trigger: 'test',
    tasks: keys.map(planTask),
  });
  state.approvePlan(PROJECT, human, v.plan_id, v.version);
  return {
    goalId: g.goal_id,
    tasks: Object.fromEntries(state.q.goalTasks(PROJECT, g.goal_id).map((t) => [t.plan_key as string, t])),
  };
}

const claim = (caller: Caller, taskId: string) => state.claimTask(PROJECT, caller, { task_id: taskId }).run_id;

/** The host's report about its attempt, as a spawn adapter or the hooks record it. */
function reported(caller: Caller, taskId: string, runId: string, data: Record<string, unknown>) {
  state.recordObservation(
    PROJECT,
    { kind: 'agent', id: caller.agent_id },
    'agent.event',
    { task_id: taskId, run_id: runId, event_type: 'host.usage', summary: null, data },
    [
      { kind: 'task', id: taskId },
      { kind: 'run', id: runId },
    ],
  );
}

let claims = 0;
function claimDone(caller: Caller, taskId: string, runId: string) {
  claims += 1;
  state.submitResult(PROJECT, caller, {
    idempotency_key: `claim-${claims}`,
    task_id: taskId,
    run_id: runId,
    status: 'completed_claim',
    summary: 'done',
    changed_paths: [],
    checks: [],
    notes: [],
    risks: [],
  });
}

function verify(taskId: string, passed: boolean) {
  const { verification_id } = state.startVerification(PROJECT, human, taskId);
  state.finishVerification(PROJECT, human, verification_id, passed, passed ? 'passed' : 'tests failed');
}

/** The policy's verdict on a tool call, as the hooks router records it for the session's task. */
function judged(caller: Caller, taskId: string, decision: 'allow' | 'deny') {
  state.recordObservation(
    PROJECT,
    { kind: 'harness', id: caller.harness_id },
    'policy.evaluated',
    {
      tool: 'Write',
      kind: 'write',
      decision,
      rule: decision === 'deny' ? 'write.outside_scope' : 'write.in_scope',
      reason: decision === 'deny' ? 'outside the task scope' : 'in scope',
      targets: ['backend/x.ts'],
      task_id: taskId,
    },
    [
      { kind: 'task', id: taskId },
      { kind: 'harness', id: caller.harness_id },
    ],
  );
}

/** The session's lease runs out: degraded first, then lost, as the lease manager judges it. */
function lose() {
  clock.advance(21_000);
  state.tick(PROJECT);
  clock.advance(10_000);
  state.tick(PROJECT);
}

const plannerCall = (goalId: string, cost: number | null) =>
  state.recordModelCall(PROJECT, BRAIN, {
    goal_id: goalId,
    plan_id: null,
    purpose: 'plan',
    prompt_version: 'p1',
    provider: 'fake',
    model: 'fake-planner',
    remote: false,
    status: 'ok',
    error_code: null,
    error: null,
    attempt: 1,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    cost_usd: cost,
    cost_estimate_usd: cost === null ? 0.1 : null,
    latency_ms: 10,
    request_id: null,
  });

describe('what Friday did for a goal (plan M12.7)', () => {
  it('counts verdicts, rework, holds, refusals, lost and recovered sessions, and what the hosts reported', () => {
    const { goalId, tasks } = goal(['api', 'ui', 'docs']);
    const api = tasks.api?.task_id as string;
    const ui = tasks.ui?.task_id as string;
    const docs = tasks.docs?.task_id as string;
    const a = register('dev-1');
    const b = register('dev-2');

    // api: the first claim is refused by the checks and reworked; the second passes. Both attempts
    // report tokens and a cost.
    const r1 = claim(a, api);
    reported(a, api, r1, { input_tokens: 1000, output_tokens: 200, cost_usd: 0.3 });
    claimDone(a, api, r1);
    verify(api, false);
    state.reworkTask(PROJECT, human, api, 'fix the failing test');
    const r2 = claim(a, api);
    reported(a, api, r2, { input_tokens: 500, output_tokens: 100, cost_usd: 0.12 });
    claimDone(a, api, r2);
    verify(api, true);

    // ui: an action held for a human, one refused by policy (an allowed one is not counted), the
    // session lost and the same session back, which resumes the attempt; its host counts tokens
    // but names no cost.
    const r3 = claim(b, ui);
    state.requestPermission(
      PROJECT,
      b,
      {
        task_id: ui,
        run_id: r3,
        action_class: 'shell.git.push',
        command: 'git push',
        justification: 'release',
        ttl_s: 600,
      },
      { capability: 'shell.git.push', decision: 'review', risk: 'high', reason: 'manual', policy_version: 'v1' },
    );
    judged(b, ui, 'deny');
    judged(b, ui, 'allow');
    lose();
    expect(state.q.task(PROJECT, ui).status).toBe('HARNESS_LOST');
    const back = register('dev-2');
    expect(back.harness_id).toBe(b.harness_id);
    expect(state.claimTask(PROJECT, back, { task_id: ui })).toMatchObject({ run_id: r3, resumed: true });
    reported(back, ui, r3, { input_tokens: 2000, output_tokens: 300 });

    // docs: a host that reports nothing, arriving after the loss above (every lease ran out with
    // it); verified at the first claim.
    const c = register('dev-3');
    const r4 = claim(c, docs);
    claimDone(c, docs, r4);
    verify(docs, true);

    // Friday's own calls for the goal: one with a known cost, one whose cost is unknown.
    plannerCall(goalId, 0.05);
    plannerCall(goalId, null);

    expect(state.q.goalSummary(PROJECT, goalId)).toEqual({
      tasks: { total: 3, verified: 2 },
      claims_refused: 1,
      reworked: 1,
      held_for_human: 1,
      refused_by_policy: 1,
      sessions_lost: 1,
      sessions_recovered: 1,
      hosts: {
        attempts: 4,
        reported: 3,
        tokens: 1000 + 200 + 500 + 100 + 2000 + 300,
        tokens_reporters: 3,
        cost_usd: 0.42,
        cost_reporters: 2,
      },
      planning: { calls: 2, cost_usd: 0.05, unknown_cost_calls: 1 },
    });
  });

  it('shows no figure nobody reported, leaves cancelled tasks out, and never counts a lost session cancelled as recovered', () => {
    const { goalId, tasks } = goal(['api', 'ui']);
    const api = tasks.api?.task_id as string;
    const ui = tasks.ui?.task_id as string;
    const a = register('dev-1');
    const b = register('dev-2');
    const r1 = claim(a, api);
    claimDone(a, api, r1);
    verify(api, true);
    // ui is lost and then cancelled by a human: a lost session, not a recovered one, and the task
    // no longer counts among the goal's.
    claim(b, ui);
    lose();
    state.cancelTask(PROJECT, human, ui, 'not needed');

    expect(state.q.goalSummary(PROJECT, goalId)).toEqual({
      tasks: { total: 1, verified: 1 },
      claims_refused: 0,
      reworked: 0,
      held_for_human: 0,
      refused_by_policy: 0,
      sessions_lost: 1,
      sessions_recovered: 0,
      hosts: { attempts: 2, reported: 0, tokens: null, tokens_reporters: 0, cost_usd: null, cost_reporters: 0 },
      planning: { calls: 0, cost_usd: null, unknown_cost_calls: 0 },
    });
  });

  it('is all zeros and nulls for a goal without work, and refuses an unknown goal', () => {
    const g = state.createGoal(PROJECT, human, { request: 'nothing yet', plan: false });
    expect(state.q.goalSummary(PROJECT, g.goal_id)).toEqual({
      tasks: { total: 0, verified: 0 },
      claims_refused: 0,
      reworked: 0,
      held_for_human: 0,
      refused_by_policy: 0,
      sessions_lost: 0,
      sessions_recovered: 0,
      hosts: { attempts: 0, reported: 0, tokens: null, tokens_reporters: 0, cost_usd: null, cost_reporters: 0 },
      planning: { calls: 0, cost_usd: null, unknown_cost_calls: 0 },
    });
    expect(() => state.q.goalSummary(PROJECT, 'goal_00000000000000000000000000')).toThrow(/not found/);
  });
});
