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
import { ROLE_CLASSIFIER_PROMPT_VERSION } from './role-classifier.js';

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
      prompt_version: 'plan-4',
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
      prompt_version: 'replan-5',
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
      prompt_version: 'plan-4',
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

  it('proposes a goal whose pieces run one after another as one task (plan M13.1)', async () => {
    const serial = {
      objective: 'Checkout takes a gift card',
      summary: 'The contract, then the backend',
      rationale: 'The backend needs the contract.',
      tasks: [
        {
          key: 'contract',
          summary: 'A gift card in the shared contract',
          acceptance_criteria: ['node --test passes'],
          scope: { write: ['shared/src/api.ts'] },
          role: 'frontend',
        },
        {
          key: 'redeem',
          summary: 'Redeem the card in the backend',
          acceptance_criteria: ['node --test passes', 'the balance is never exceeded'],
          scope: { write: ['backend/**'] },
          role: 'backend',
          depends_on: ['contract'],
        },
      ],
    };
    const b = brain(new FakePlannerModel([{ purpose: 'plan', output: serial }]));
    const goal = state.createGoal(PROJECT, human, { request: 'Checkout takes a gift card' });
    await b.runOnce();
    const v = state.q.planVersions(state.q.goal(PROJECT, goal.goal_id).plan_id as string)[0];
    expect(v?.tasks.map((t) => t.key)).toEqual(['contract']);
    expect(v?.tasks[0]).toMatchObject({ role: 'developer', scope: { write: ['shared/src/api.ts', 'backend/**'] } });
    // The reviewer reads why in the plan's rationale.
    expect(v?.rationale).toMatch(/Friday kept this as one task: its 2 parts \(contract, redeem\)/);
  });

  it('gives a small, low-risk task to the cheapest capable agent and its rework to a stronger one (plan M13.3)', async () => {
    const cheap = spawnAgent('be-cheap', 'backend');
    const std = spawnAgent('be-std', 'backend');
    const classOf = (agentId: string) => (agentId === cheap.agent_id ? 'cheap' : 'standard');
    const b = new MasterBrain({
      state,
      projectId: PROJECT,
      model: new FakePlannerModel([
        {
          purpose: 'plan',
          output: {
            objective: 'A VAT note on receipts',
            summary: 'One small backend task',
            tasks: [
              {
                key: 'vat-note',
                summary: 'Add a VAT note to receipts',
                acceptance_criteria: ['node --test passes'],
                scope: { write: ['backend/src/receipt.ts'] },
                role: 'backend',
                risk_level: 'low',
              },
            ],
          },
        },
      ]),
      settings: SETTINGS,
      projectContext: () => 'fixture-shop',
      // The standard agent's model fits better and would win on the score alone.
      modelFit: (_t, agentId) => ({
        fit: agentId === cheap.agent_id ? 0.7 : 0.9,
        cost: 0,
        cost_class: classOf(agentId),
      }),
    });
    state.costClassOf = (_t, agentId) => classOf(agentId);
    const goal = state.createGoal(PROJECT, human, { request: 'A VAT note on receipts' });
    await b.runOnce();
    state.approvePlan(PROJECT, human, state.q.goal(PROJECT, goal.goal_id).plan_id as string, 1);
    await b.runOnce();
    let t = byKey(goal.goal_id)['vat-note'] as TaskView;
    expect(agentKeyOf(t)).toBe('be-cheap');
    expect(state.q.assignments(t.task_id)[0]?.reason).toMatch(/the cheapest capable agent \(cheap\)/);
    expect(accept(cheap)).toEqual([t.task_id]);
    // Verification refuses the cheap agent's claim: the rework goes to the standard agent.
    finish(cheap, t, false);
    state.reworkTask(PROJECT, human, t.task_id, 'the test of the note fails');
    t = state.q.task(PROJECT, t.task_id);
    expect(t).toMatchObject({ status: 'READY', reserved_for_agent_key: 'be-std', reserved_by: 'rework' });
    await b.runOnce();
    expect(agentKeyOf(state.q.task(PROJECT, t.task_id))).toBe('be-std');
    expect(accept(std)).toEqual([t.task_id]);
  });

  it('keeps a rework with the agent that did the work when no stronger agent is there (plan M13.3)', async () => {
    const cheap = spawnAgent('be-cheap', 'backend');
    spawnAgent('fe-std', 'frontend');
    state.costClassOf = (_t, agentId) => (agentId === cheap.agent_id ? 'cheap' : 'standard');
    const task = state.createTask(PROJECT, human, {
      summary: 'Add a VAT note',
      scope: { write: ['backend/**'], read: [] },
      ready: true,
    });
    state.assignTask(PROJECT, human, task.task_id, 'be-cheap');
    accept(cheap);
    finish(cheap, task, false);
    state.reworkTask(PROJECT, human, task.task_id, 'try again');
    // The only stronger agent is of another role: the rework stays with be-cheap.
    expect(state.q.task(PROJECT, task.task_id).reserved_for_agent_key).toBe('be-cheap');
  });

  it('never escalates a rework to an agent whose route blocks the task, or that is busy (review of M13)', async () => {
    const cheap = spawnAgent('be-cheap', 'backend');
    const blocked = spawnAgent('be-blocked', 'backend');
    const busy = spawnAgent('be-busy', 'backend');
    // The router has no class for an agent whose route blocks the task; a failing router none at all.
    state.costClassOf = (_t, agentId) => {
      if (agentId === cheap.agent_id) return 'cheap';
      if (agentId === blocked.agent_id) return null;
      return 'standard';
    };
    const other = state.createTask(PROJECT, human, {
      summary: 'other work',
      scope: { write: ['docs/**'], read: [] },
      ready: true,
    });
    state.assignTask(PROJECT, human, other.task_id, 'be-busy');
    accept(busy);
    const task = state.createTask(PROJECT, human, {
      summary: 'Add a VAT note',
      scope: { write: ['backend/**'], read: [] },
      ready: true,
    });
    state.assignTask(PROJECT, human, task.task_id, 'be-cheap');
    accept(cheap);
    finish(cheap, task, false);
    state.reworkTask(PROJECT, human, task.task_id, 'try again');
    expect(state.q.task(PROJECT, task.task_id).reserved_for_agent_key).toBe('be-cheap');
    // A router that throws never stops a rework.
    state.costClassOf = () => {
      throw new Error('routing is down');
    };
    const again = state.createTask(PROJECT, human, {
      summary: 'Another',
      scope: { write: ['backend/x/**'], read: [] },
      ready: true,
    });
    state.unreserveTask(PROJECT, human, task.task_id, 'free it');
    state.assignTask(PROJECT, human, again.task_id, 'be-cheap');
    accept(cheap);
    finish(cheap, again, false);
    expect(state.reworkTask(PROJECT, human, again.task_id, 'try again').reserved_for_agent_key).toBe('be-cheap');
  });

  it('proposes the plan as the model wrote it when a human asked for it with feedback (review of M13)', async () => {
    const serial = {
      objective: 'Checkout takes a gift card',
      summary: 'The contract, then the backend',
      tasks: [
        {
          key: 'contract',
          summary: 'The contract',
          acceptance_criteria: ['ok'],
          scope: { write: ['shared/src/api.ts'] },
        },
        {
          key: 'redeem',
          summary: 'The backend',
          acceptance_criteria: ['ok'],
          scope: { write: ['backend/**'] },
          depends_on: ['contract'],
        },
      ],
    };
    const b = brain(
      new FakePlannerModel([
        { purpose: 'plan', output: serial },
        { purpose: 'plan', output: serial },
      ]),
    );
    const goal = state.createGoal(PROJECT, human, { request: 'Checkout takes a gift card' });
    await b.runOnce();
    const planId = state.q.goal(PROJECT, goal.goal_id).plan_id as string;
    expect(state.q.planVersion(planId, 1)?.tasks).toHaveLength(1);
    state.rejectPlan(PROJECT, human, planId, 1, 'not as one task');
    await b.requestReplan(goal.goal_id, 'split it into the contract and the backend');
    await b.runOnce();
    const latest = state.q.planVersions(planId).at(-1);
    expect(latest?.version).toBe(2);
    expect(latest?.tasks.map((t) => t.key)).toEqual(['contract', 'redeem']);
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

  it('closes its question about a failed task once a human reworks it, and plans nothing (LESSONS D-50)', async () => {
    const b = brain(null, {}, 'no Anthropic key is stored');
    const dev = spawnAgent('dev-1', 'developer');
    const goal = state.createGoal(PROJECT, human, { request: 'Add a VAT note to prices', plan: false });
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
    const v = state.proposePlan(PROJECT, human, goal.goal_id, proposalFromDraft(parsed.value, { trigger: 'human' }));
    state.approvePlan(PROJECT, human, v.plan_id, v.version);
    await b.runOnce();
    accept(dev);
    const task = finish(dev, byKey(goal.goal_id)['vat-note'] as TaskView, false);
    // Without a planner, the first failure goes back to the agent with verification's note:
    // no question yet.
    const reworked = await b.runOnce();
    expect(reworked.steps.map((s) => s.action)).toContain('rework');
    expect(pending()).toEqual([]);
    expect(['READY', 'ASSIGNED']).toContain(state.q.task(PROJECT, task.task_id).status);
    if (state.q.task(PROJECT, task.task_id).status === 'READY') await b.runOnce();
    accept(dev);
    finish(dev, byKey(goal.goal_id)['vat-note'] as TaskView, false);
    await b.runOnce();
    // The second failure reaches the limit: a human decides.
    const asked = pending();
    expect(asked).toMatchObject([{ kind: 'repeated_verification_failures', task_id: task.task_id }]);
    // The human does what the question asked: the task goes back for rework.
    state.reworkTask(PROJECT, human, task.task_id, 'show the note under the total');
    expect(pending()).toEqual([]);
    const closed = state.q.escalations(PROJECT).find((e) => e.escalation_id === asked[0]?.escalation_id);
    expect(closed).toMatchObject({ status: 'answered', answer: 'no longer needed: the task was sent back for rework' });
    const after = await b.runOnce();
    expect(after.steps.map((s) => s.action)).not.toContain('replan');
    expect(after.steps.map((s) => s.action)).not.toContain('escalate');
    expect(pending()).toEqual([]);
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

  it('classifies a blocked task role once, and never a task an explicit role already resolved', async () => {
    const model = new FakePlannerModel([
      {
        purpose: 'role',
        output: {
          status: 'classified',
          roles: [{ role: 'backend_engineer', task_summary: 'split the change', depends_on: [], confidence: 0.95 }],
          assumptions: [],
        },
      },
    ]);
    const b = brain(model);
    const blocked = state.createTask(PROJECT, human, {
      summary: 'Split a cross-cutting change',
      kind: 'implementation',
      scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: [] },
    });
    expect(blocked).toMatchObject({ role: null, role_source: 'missing' });
    const explicit = state.createTask(PROJECT, human, {
      summary: 'Build the checkout API',
      kind: 'implementation',
      role: 'backend',
      scope: { write: ['server/src/api.ts'], read: [] },
    });

    await b.runOnce();
    expect(state.q.task(PROJECT, blocked.task_id)).toMatchObject({
      role: 'backend_engineer',
      role_source: 'decision_model',
      role_confidence: 0.95,
    });
    expect(state.q.task(PROJECT, explicit.task_id)).toMatchObject({ role: 'backend', role_source: 'task' });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.purpose).toBe('role');
    expect(state.q.modelCalls(PROJECT)).toEqual([
      expect.objectContaining({ purpose: 'role', status: 'ok', prompt_version: ROLE_CLASSIFIER_PROMPT_VERSION }),
    ]);

    // The resolved contract and the recorded job mean no second classifier call.
    await b.runOnce();
    expect(model.requests).toHaveLength(1);
  });

  it('stores a multi-role classifier answer as a proposed DAG and keeps it blocked', async () => {
    const model = new FakePlannerModel([
      {
        purpose: 'role',
        output: {
          status: 'classified',
          assumptions: ['the page and the API can ship together'],
          roles: [
            { role: 'frontend_engineer', task_summary: 'Build the page', depends_on: [], confidence: 0.9 },
            {
              role: 'backend_engineer',
              task_summary: 'Build the API',
              depends_on: ['frontend_engineer'],
              confidence: 0.85,
            },
          ],
        },
      },
    ]);
    const b = brain(model);
    const task = state.createTask(PROJECT, human, {
      summary: 'Split the checkout work',
      kind: 'implementation',
      scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: [] },
    });
    await b.runOnce();
    expect(state.q.task(PROJECT, task.task_id)).toMatchObject({ role: null, role_source: 'decision_model' });
    expect(state.q.latestTaskRoleDecision(PROJECT, task.task_id)).toMatchObject({
      status: 'proposed',
      roles: [
        { role: 'frontend_engineer', depends_on: [] },
        { role: 'backend_engineer', depends_on: ['frontend_engineer'] },
      ],
    });
    expect(model.requests).toHaveLength(1);
  });

  it('persists a classifier clarification as the blocked contract and does not ask again', async () => {
    const model = new FakePlannerModel([
      {
        purpose: 'role',
        output: {
          status: 'clarification_required',
          missing_facts: ['whether the checkout page is in scope'],
          questions: ['Should this include the checkout page?'],
        },
      },
    ]);
    const b = brain(model);
    const task = state.createTask(PROJECT, human, {
      summary: 'Split a cross-cutting change',
      kind: 'implementation',
      scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: [] },
    });
    const initialDecision = state.q.latestTaskRoleDecision(PROJECT, task.task_id);
    await b.runOnce();
    expect(state.q.task(PROJECT, task.task_id)).toMatchObject({ role: null, role_source: 'missing' });
    expect(state.q.latestTaskRoleDecision(PROJECT, task.task_id)).toMatchObject({
      status: 'blocked',
      source: 'missing',
      questions: ['Should this include the checkout page?'],
    });
    expect(model.requests).toHaveLength(1);
    expect(state.brainJobs(PROJECT, ['done']).filter((job) => job.kind === 'role')).toHaveLength(1);

    await b.runOnce();
    expect(model.requests).toHaveLength(1);
    expect(state.brainJobs(PROJECT, ['pending', 'calling', 'done']).filter((job) => job.kind === 'role')).toHaveLength(
      1,
    );

    // A job recovered from before the clarification still names the old blocked decision. It must
    // stop at the changed contract rather than ask the classifier the same question again.
    const [staleJob] = state.enqueueBrainJobs(
      PROJECT,
      [
        {
          kind: 'role',
          goal_id: null,
          task_id: task.task_id,
          reason: 'simulated restart',
          payload: { decision_id: initialDecision?.decision_id },
          dedupe_key: `role:stale:${task.task_id}`,
          source_sequence: state.store.head(PROJECT),
        },
      ],
      state.q.brainCursor(PROJECT),
    );
    await b.runOnce();
    expect(model.requests).toHaveLength(1);
    expect(state.brainJobs(PROJECT, ['done']).find((job) => job.job_id === staleJob)).toMatchObject({
      result: expect.stringMatching(/contract changed/),
    });
  });

  it('turns an unusable classifier answer into a human question without reclassifying', async () => {
    const low = {
      purpose: 'role' as const,
      output: {
        status: 'classified' as const,
        roles: [{ role: 'backend_engineer', task_summary: 'maybe', depends_on: [], confidence: 0.2 }],
        assumptions: [],
      },
    };
    const model = new FakePlannerModel([low, low]);
    const b = brain(model);
    const task = state.createTask(PROJECT, human, {
      summary: 'Split a cross-cutting change',
      kind: 'implementation',
      scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: [] },
    });
    await b.runOnce();
    expect(state.q.task(PROJECT, task.task_id)).toMatchObject({ role: null, role_source: 'missing' });
    expect(state.q.latestTaskRoleDecision(PROJECT, task.task_id)).toMatchObject({
      status: 'blocked',
      source: 'missing',
    });
    expect(state.q.latestTaskRoleDecision(PROJECT, task.task_id)?.questions[0]).toMatch(/could not choose one role/);
    expect(model.requests).toHaveLength(2);
    expect(state.q.modelCalls(PROJECT)).toEqual([
      expect.objectContaining({ purpose: 'role', status: 'invalid' }),
      expect.objectContaining({ purpose: 'role', status: 'invalid' }),
    ]);
    expect(state.brainJobs(PROJECT, ['done']).filter((job) => job.kind === 'role')).toHaveLength(1);

    await b.runOnce();
    expect(model.requests).toHaveLength(2);
  });

  it('does not retry a role classification that failed for a permanent reason', async () => {
    const model = new FakePlannerModel([
      { purpose: 'role', error: { code: 'auth', message: 'no usable key', billed: 'no' } },
    ]);
    const b = brain(model);
    const task = state.createTask(PROJECT, human, {
      summary: 'Split a cross-cutting change',
      kind: 'implementation',
      scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: [] },
    });
    await b.runOnce();
    expect(state.q.task(PROJECT, task.task_id)).toMatchObject({ role: null, role_source: 'missing' });
    expect(state.q.latestTaskRoleDecision(PROJECT, task.task_id)).toMatchObject({ status: 'blocked' });
    expect(model.requests).toHaveLength(1);
    expect(state.q.modelCalls(PROJECT)).toEqual([
      expect.objectContaining({ purpose: 'role', status: 'error', error_code: 'auth' }),
    ]);
    expect(state.brainJobs(PROJECT, ['done']).filter((job) => job.kind === 'role')).toMatchObject([
      { result: expect.stringMatching(/classification unavailable/) },
    ]);

    await b.runOnce();
    expect(model.requests).toHaveLength(1);
    expect(state.brainJobs(PROJECT, ['pending', 'calling']).filter((job) => job.kind === 'role')).toHaveLength(0);
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
