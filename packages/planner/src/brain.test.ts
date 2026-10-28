import { fileURLToPath } from 'node:url';
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, AgentResultParams, HarnessRegisterParams, type TaskView } from '@friday/protocol';
import { DOMAIN_TABLES, FridayState } from '@friday/state';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { type BrainSettings, MasterBrain } from './brain.js';
import { parsePlanDraft } from './parse.js';
import { proposalFromDraft } from './proposals.js';
import { FakePlannerModel } from './providers/fake.js';
import type { PlannerModel } from './providers/types.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };
const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/planner/stripe-subscriptions', import.meta.url));
const GOAL = 'Add Stripe subscriptions, keep one-time checkout working, add tests';

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-13T10:00:00.000Z');
  state = new FridayState({ db, clock, ids: sequentialIds() });
  state.ensureProject({ project_id: PROJECT, name: 'fixture-shop', root_path: 'C:/demo/shop' });
});

const SETTINGS: BrainSettings = {
  model: 'claude-opus-5-5',
  maxTokens: 16_000,
  autoApprove: false,
  escalateAfterFailures: 2,
  maxReplans: 3,
  allowRemote: false,
  dailyBudgetUsd: 5,
};

function brain(model: PlannerModel | null, settings: Partial<BrainSettings> = {}, plannerUnavailable?: string) {
  return new MasterBrain({
    state,
    projectId: PROJECT,
    model,
    ...(plannerUnavailable ? { plannerUnavailable } : {}),
    settings: { ...SETTINGS, ...settings },
    projectContext: () => 'fixture-shop: backend/, frontend/, shared/, infra/. Checks: node --test.',
  });
}

function spawnAgent(key: string, role: string) {
  return state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `fake:${key}`,
      vendor: 'generic',
      name: key,
      attach_mode: 'spawn',
      project_id: PROJECT,
      capabilities: { task_start: true },
      agent: { agent_key: key, role },
    }),
  );
}

type Reg = ReturnType<typeof spawnAgent>;

/** The harness accepts every pending task.start, as a FakeHarness would. */
function accept(reg: Reg): string[] {
  const msgs = state.pollOutbox(PROJECT, reg.harness_id, 10);
  state.ackOutbox(
    PROJECT,
    reg.harness_id,
    msgs.map((m) => ({ message_id: m.message_id, accepted: true, session_ref: 'fake' })),
  );
  return msgs.map((m) => (m.params as { task_id: string }).task_id);
}

/** The agent claims completion and verification records the outcome. */
function finish(reg: Reg, task: TaskView, passed: boolean): TaskView {
  const t = state.q.task(PROJECT, task.task_id);
  state.submitResult(
    PROJECT,
    { harness_id: reg.harness_id, agent_id: reg.agent_id },
    AgentResultParams.parse({
      protocol_version: '1.0',
      idempotency_key: `done-${t.task_id}-${t.current_run_id}`,
      task_id: t.task_id,
      run_id: t.current_run_id,
      status: 'completed_claim',
      summary: `finished ${t.plan_key}`,
      changed_paths: [],
    }),
  );
  const { verification_id } = state.startVerification(PROJECT, human, t.task_id);
  state.recordVerificationCheck(PROJECT, human, verification_id, {
    name: 'tests',
    kind: 'test',
    status: passed ? 'PASSED' : 'FAILED',
    exit_code: passed ? 0 : 1,
    artifact_ref: null,
    summary: passed ? 'pass 12, fail 0' : 'formatPrice expected "€10.89 incl. VAT"',
  });
  return state.finishVerification(
    PROJECT,
    human,
    verification_id,
    passed,
    passed ? '1/1 checks passed' : '0/1 checks passed',
  );
}

const byKey = (goalId: string) => Object.fromEntries(state.q.goalTasks(PROJECT, goalId).map((t) => [t.plan_key, t]));
const agentKeyOf = (t: TaskView | undefined) =>
  t?.assigned_agent_id ? state.q.findAgent(t.assigned_agent_id)?.agent_key : null;
const pending = () => state.q.escalations(PROJECT, 'pending');

describe('Master Brain', () => {
  it('plans a goal, waits for approval, delegates in parallel, revises on failure and asks a human', async () => {
    const b = brain(FakePlannerModel.fromDirectory(FIXTURES));
    const be = spawnAgent('be-1', 'backend');
    const fe = spawnAgent('fe-1', 'frontend');
    const goal = state.createGoal(PROJECT, human, { request: GOAL });

    await b.runOnce();
    const g = state.q.goal(PROJECT, goal.goal_id);
    expect(g).toMatchObject({ status: 'OPEN', objective: expect.stringContaining('Stripe subscription billing') });
    // The goal had no human constraints; the planner's are kept apart (review F07).
    expect(g.constraints).toEqual([]);
    expect(g.inferred_constraints).toHaveLength(3);
    const planId = g.plan_id as string;
    const v1 = state.q.planVersion(planId, 1);
    expect(v1).toMatchObject({
      status: 'PROPOSED',
      trigger: 'first plan',
      proposed_by: { kind: 'master_brain' },
      prompt_version: 'plan-2',
    });
    expect(v1?.tasks.map((t) => [t.key, t.change])).toEqual([
      ['billing-service', 'new'],
      ['subscribe-page', 'new'],
      ['stripe-webhooks', 'new'],
      ['lifecycle-tests', 'new'],
    ]);
    expect(state.q.modelCalls(PROJECT)).toMatchObject([
      { purpose: 'plan', status: 'ok', provider: 'fake', model: 'claude-opus-5-5', input_tokens: 2400 },
    ]);
    expect(state.q.goalTasks(PROJECT, goal.goal_id)).toEqual([]);

    // Approval materializes the plan; only tasks without open dependencies are READY.
    const approved = state.approvePlan(PROJECT, human, planId, 1);
    expect(approved.created.map((t) => [t.plan_key, t.status, t.plan_version, t.role])).toEqual([
      ['billing-service', 'READY', 1, 'backend'],
      ['subscribe-page', 'READY', 1, 'frontend'],
      ['stripe-webhooks', 'PROPOSED', 1, 'backend'],
      ['lifecycle-tests', 'PROPOSED', 1, 'qa'],
    ]);
    expect(state.q.goal(PROJECT, goal.goal_id).status).toBe('ACTIVE');
    let tasks = byKey(goal.goal_id);
    expect(tasks['lifecycle-tests']?.dependencies.sort()).toEqual(
      [tasks['stripe-webhooks']?.task_id, tasks['subscribe-page']?.task_id].sort(),
    );

    // Delegation: the two independent tasks go to the agents whose role fits, at the same time.
    await b.runOnce();
    tasks = byKey(goal.goal_id);
    expect([agentKeyOf(tasks['billing-service']), agentKeyOf(tasks['subscribe-page'])]).toEqual(['be-1', 'fe-1']);
    expect(state.q.assignments(tasks['billing-service']?.task_id as string)[0]).toMatchObject({
      mode: 'assigned',
      agent_key: 'be-1',
    });
    expect(accept(be)).toEqual([tasks['billing-service']?.task_id]);
    expect(accept(fe)).toEqual([tasks['subscribe-page']?.task_id]);

    // The backend task passes: its dependent becomes READY and goes back to be-1.
    finish(be, tasks['billing-service'] as TaskView, true);
    await b.runOnce();
    tasks = byKey(goal.goal_id);
    expect(tasks['stripe-webhooks']?.status).toBe('ASSIGNED');
    expect(agentKeyOf(tasks['stripe-webhooks'])).toBe('be-1');
    expect(tasks['lifecycle-tests']?.status).toBe('PROPOSED');
    accept(be);

    // The frontend task fails verification: the Master Brain proposes v2 with a rework, and asks a human.
    finish(fe, tasks['subscribe-page'] as TaskView, false);
    await b.runOnce();
    const v2 = state.q.planVersion(planId, 2);
    expect(v2).toMatchObject({
      status: 'PROPOSED',
      supersedes: 1,
      trigger: expect.stringContaining('verification failed'),
      prompt_version: 'replan-3',
    });
    expect(v2?.tasks.map((t) => [t.key, t.change])).toEqual([
      ['billing-service', 'keep'],
      ['subscribe-page', 'rework'],
      ['stripe-webhooks', 'keep'],
      ['lifecycle-tests', 'keep'],
    ]);
    // Newest call first: the revision reused the cached project context.
    expect(state.q.modelCalls(PROJECT)[0]).toMatchObject({
      purpose: 'replan',
      status: 'ok',
      cache_read_input_tokens: 3100,
    });
    const question = pending().find((e) => e.kind === 'ambiguous_intent');
    expect(question).toMatchObject({
      question: 'Should subscription prices on the subscribe page include VAT?',
      requested_by_kind: 'master_brain',
    });
    const details = JSON.parse(String(question?.details_json));
    expect(Object.keys(details).sort()).toEqual([
      'blocked',
      'capability',
      'evidence',
      'plan_id',
      'plan_version',
      'proposed_action',
      'requested_by',
      'why',
    ]);
    expect(state.q.planVersion(planId, 1)?.status).toBe('ACTIVE');

    // The human approves v2 and answers: the reworked task goes back to its agent; no further model call.
    state.approvePlan(PROJECT, human, planId, 2);
    state.answerEscalation(PROJECT, human, String(question?.escalation_id), 'show prices including VAT');
    const callsBefore = state.q.modelCalls(PROJECT).length;
    await b.runOnce();
    expect(state.q.modelCalls(PROJECT)).toHaveLength(callsBefore);
    tasks = byKey(goal.goal_id);
    expect(state.q.planVersion(planId, 1)?.status).toBe('SUPERSEDED');
    expect(tasks['subscribe-page']?.status).toBe('ASSIGNED');
    expect(agentKeyOf(tasks['subscribe-page'])).toBe('fe-1');
    accept(fe);

    // Everything passes: the dependents follow, and the goal completes.
    finish(be, tasks['stripe-webhooks'] as TaskView, true);
    finish(fe, tasks['subscribe-page'] as TaskView, true);
    await b.runOnce();
    tasks = byKey(goal.goal_id);
    expect(tasks['lifecycle-tests']?.status).toBe('ASSIGNED');
    const tester =
      state.q.findHarness(tasks['lifecycle-tests']?.assigned_harness_id as string)?.harness_key === 'fake:be-1'
        ? be
        : fe;
    accept(tester);
    finish(tester, tasks['lifecycle-tests'] as TaskView, true);
    await b.runOnce();
    expect(state.q.goal(PROJECT, goal.goal_id)).toMatchObject({
      status: 'COMPLETED',
      completed_at: expect.any(String),
    });
    expect(state.q.planVersion(planId, 2)?.status).toBe('COMPLETED');

    // Replay rebuilds exactly the same domain tables, goals and plans included.
    const dump = () =>
      Object.fromEntries(DOMAIN_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]));
    const before = dump();
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
  });

  it('escalates a second verification failure instead of revising again', async () => {
    const b = brain(FakePlannerModel.fromDirectory(FIXTURES));
    const fe = spawnAgent('fe-1', 'frontend');
    spawnAgent('be-1', 'backend');
    const goal = state.createGoal(PROJECT, human, { request: GOAL });
    await b.runOnce();
    const planId = state.q.goal(PROJECT, goal.goal_id).plan_id as string;
    state.approvePlan(PROJECT, human, planId, 1);
    await b.runOnce();
    accept(fe);
    finish(fe, byKey(goal.goal_id)['subscribe-page'] as TaskView, false);
    await b.runOnce();
    state.approvePlan(PROJECT, human, planId, 2);
    await b.runOnce();
    accept(fe);
    finish(fe, byKey(goal.goal_id)['subscribe-page'] as TaskView, false);
    const calls = state.q.modelCalls(PROJECT).length;
    await b.runOnce();
    expect(state.q.modelCalls(PROJECT)).toHaveLength(calls);
    expect(state.q.planVersion(planId, 3)).toBeUndefined();
    expect(pending().find((e) => e.kind === 'repeated_verification_failures')).toMatchObject({
      task_id: byKey(goal.goal_id)['subscribe-page']?.task_id,
      question: expect.stringContaining('failed verification again'),
    });
  });

  it('never calls a remote planner without consent, and says how to enable it', async () => {
    let called = 0;
    const remote: PlannerModel = {
      provider: 'anthropic',
      remote: true,
      complete: async () => {
        called += 1;
        throw new Error('no network in tests');
      },
    };
    const b = brain(remote, { allowRemote: false });
    const goal = state.createGoal(PROJECT, human, { request: GOAL });
    await b.runOnce();
    expect(called).toBe(0);
    expect(state.q.modelCalls(PROJECT)).toMatchObject([
      { status: 'refused', error_code: 'refused', provider: 'anthropic', cost_usd: 0 },
    ]);
    expect(pending()).toMatchObject([
      { kind: 'planner_unavailable', goal_id: goal.goal_id, question: expect.stringContaining('allow_remote: true') },
    ]);
    // A second pass does not repeat the escalation.
    await b.runOnce();
    expect(pending()).toHaveLength(1);
  });

  it('stops at the daily budget', async () => {
    const remote: PlannerModel = {
      provider: 'anthropic',
      remote: true,
      complete: async () => ({
        output: {},
        model: 'x',
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        stop_reason: 'end_turn',
        request_id: null,
      }),
    };
    state.recordModelCall(PROJECT, human, {
      goal_id: null,
      plan_id: null,
      purpose: 'plan',
      prompt_version: 'plan-2',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      remote: true,
      status: 'ok',
      error_code: null,
      error: null,
      attempt: 1,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      cost_usd: 5.25,
      latency_ms: 10,
      request_id: null,
    });
    const b = brain(remote, { allowRemote: true });
    state.createGoal(PROJECT, human, { request: GOAL });
    await b.runOnce();
    expect(pending()).toMatchObject([{ kind: 'budget_exceeded' }]);
  });

  it('escalates with the validation errors when the plan is invalid twice', async () => {
    const bad = {
      objective: 'Add subscriptions',
      summary: 'One task without a scope',
      tasks: [{ key: 'all', summary: 'Do everything', acceptance_criteria: ['done'] }],
    };
    const b = brain(
      new FakePlannerModel([
        { purpose: 'plan', output: bad },
        { purpose: 'plan', output: bad },
      ]),
    );
    state.createGoal(PROJECT, human, { request: GOAL });
    await b.runOnce();
    const esc = pending()[0];
    expect(esc).toMatchObject({ kind: 'invalid_plan' });
    expect(String(esc?.details_json)).toContain('must declare scope.write');
    expect(state.q.modelCalls(PROJECT).map((c) => c.status)).toEqual(['invalid', 'invalid']);
  });

  it('works without any planner when a human writes the plan', async () => {
    const b = brain(null, {}, 'master_brain.provider is "none"');
    spawnAgent('dev-1', 'developer');
    const goal = state.createGoal(PROJECT, human, { request: 'Add a VAT note to prices', plan: false });
    await b.runOnce();
    expect(pending()).toEqual([]);
    const parsed = parsePlanDraft({
      objective: 'Show a VAT note next to prices',
      summary: 'One frontend task',
      tasks: [
        {
          key: 'vat-note',
          summary: 'Add the VAT note',
          acceptance_criteria: ['note shown'],
          scope: { write: ['frontend/src/**'] },
        },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const v = state.proposePlan(
      PROJECT,
      human,
      goal.goal_id,
      proposalFromDraft(parsed.value, { trigger: 'written by a human' }),
    );
    expect(v.proposed_by).toEqual(human);
    state.approvePlan(PROJECT, human, v.plan_id, v.version);
    await b.runOnce();
    expect(byKey(goal.goal_id)['vat-note']).toMatchObject({ status: 'ASSIGNED' });
  });

  it('releases the tasks of a harness that never comes back and delegates them again', async () => {
    const b = brain(FakePlannerModel.fromDirectory(FIXTURES), { autoApprove: true });
    const be = spawnAgent('be-1', 'backend');
    const goal = state.createGoal(PROJECT, human, { request: GOAL });
    await b.runOnce();
    // auto_approve: the plan was approved and delegated without a human.
    const billing = byKey(goal.goal_id)['billing-service'];
    expect(billing).toMatchObject({ status: 'ASSIGNED' });
    expect(agentKeyOf(billing)).toBe('be-1');
    accept(be);
    // be-1 disappears; once the reconnect window has passed its task is released and re-delegated.
    const be2 = spawnAgent('be-2', 'backend');
    clock.advance(state.config.leaseTtlMs + 1);
    state.heartbeat(PROJECT, be2.harness_id);
    state.tick(PROJECT);
    clock.advance(state.config.reconnectWindowMs + 1);
    state.heartbeat(PROJECT, be2.harness_id);
    state.tick(PROJECT);
    expect(state.q.findHarness(be.harness_id)?.status).toBe('TERMINATED');
    await b.runOnce();
    const again = byKey(goal.goal_id)['billing-service'];
    expect(again?.status).toBe('ASSIGNED');
    expect(agentKeyOf(again)).toBe('be-2');
  });

  it('keeps its place in the event log across restarts', async () => {
    const b = brain(FakePlannerModel.fromDirectory(FIXTURES));
    state.createGoal(PROJECT, human, { request: GOAL });
    const first = await b.runOnce();
    expect(first.steps.map((s) => s.action)).toContain('plan');
    expect((await b.runOnce()).processed).toBe(0);
    const restarted = brain(FakePlannerModel.fromDirectory(FIXTURES));
    const again = await restarted.runOnce();
    expect(again.steps).toEqual([]);
    expect(state.q.modelCalls(PROJECT)).toHaveLength(1);
  });
});
