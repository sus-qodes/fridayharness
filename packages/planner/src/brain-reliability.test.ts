/**
 * Master Brain reliability and authority (review 2026-10-14, F05–F08): durable jobs across
 * restarts and failures, revisions that wait for a decision, a slow model that must not hold up
 * coordination, stale proposals, human requirements, and reservations that end.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { type Actor, AgentResultParams, FridayError, HarnessRegisterParams, type TaskView } from '@friday/protocol';
import { FridayState } from '@friday/state';
import { FakeClock } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BrainDeps, type BrainSettings, MasterBrain } from './brain.js';
import { parsePlanDraft, parseReplanDraft } from './parse.js';
import { existingTasks, proposalFromDraft, proposalFromReplan } from './proposals.js';
import { FakePlannerModel, type FakeResponse } from './providers/fake.js';
import type { PlannerModel } from './providers/types.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };
const FIXTURES = fileURLToPath(new URL('../../../tests/fixtures/planner/stripe-subscriptions', import.meta.url));
const GOAL = 'Add Stripe subscriptions, keep one-time checkout working, add tests';
const fixture = (name: string) => JSON.parse(readFileSync(`${FIXTURES}/${name}`, 'utf8')) as FakeResponse;

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;
const brains: MasterBrain[] = [];

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-13T10:00:00.000Z');
  state = new FridayState({ db, clock, ids: sequentialIds() });
  state.ensureProject({ project_id: PROJECT, name: 'fixture-shop', root_path: 'C:/demo/shop' });
});
afterEach(async () => {
  for (const b of brains.splice(0)) await b.stop();
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

function brain(model: PlannerModel | null, extra: Partial<BrainDeps> = {}) {
  const b = new MasterBrain({
    state,
    projectId: PROJECT,
    model,
    settings: SETTINGS,
    projectContext: () => 'fixture-shop: backend/, frontend/, shared/, infra/. Checks: node --test.',
    retryDelaysMs: [0, 0],
    ...extra,
  });
  brains.push(b);
  return b;
}

function register(key: string, role: string, mode: 'spawn' | 'attach' = 'spawn') {
  return state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `fake:${key}`,
      vendor: 'generic',
      name: key,
      attach_mode: mode,
      project_id: PROJECT,
      capabilities: { task_start: mode === 'spawn' },
      agent: { agent_key: key, role },
    }),
  );
}
type Reg = ReturnType<typeof register>;

function accept(reg: Reg): string[] {
  const msgs = state.pollOutbox(PROJECT, reg.harness_id, 10);
  state.ackOutbox(
    PROJECT,
    reg.harness_id,
    msgs.map((m) => ({ message_id: m.message_id, accepted: true, session_ref: 'fake' })),
  );
  return msgs.map((m) => (m.params as { task_id: string }).task_id);
}

function finish(reg: Reg, task: TaskView, passed: boolean): void {
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
    summary: passed ? 'ok' : 'a check failed',
  });
  state.finishVerification(PROJECT, human, verification_id, passed, passed ? 'passed' : 'failed');
}

const byKey = (goalId: string) => Object.fromEntries(state.q.goalTasks(PROJECT, goalId).map((t) => [t.plan_key, t]));
const pending = () => state.q.escalations(PROJECT, 'pending');
const planOf = (goalId: string) => state.q.goal(PROJECT, goalId).plan_id as string;

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A revision reworking one task by key (resolved against the plan text, like the scripted fixture). */
const reworkOf = (key: string, match = 'verification failed'): FakeResponse => ({
  purpose: 'replan',
  match,
  output: {
    summary: `Rework ${key}`,
    rationale: 'The check failed.',
    rework: [{ task_id: `\${task:${key}}`, note: `fix ${key}` }],
  },
});

/** Approves v1 of the Stripe plan and runs both parallel tasks. */
async function startStripe(b: MasterBrain) {
  const be = register('be-1', 'backend');
  const fe = register('fe-1', 'frontend');
  const goal = state.createGoal(PROJECT, human, { request: GOAL });
  await b.runOnce();
  state.approvePlan(PROJECT, human, planOf(goal.goal_id), 1);
  await b.runOnce();
  accept(be);
  accept(fe);
  return { be, fe, goal };
}

describe('durable Master Brain work (review F05)', () => {
  it('delegates after a restart even when the cursor already passed the approval', async () => {
    const be = register('be-1', 'backend');
    register('fe-1', 'frontend');
    const goal = state.createGoal(PROJECT, human, { request: GOAL });
    await brain(new FakePlannerModel([fixture('01-plan.json')])).runOnce();
    state.approvePlan(PROJECT, human, planOf(goal.goal_id), 1);
    // A crash right after the approval event was consumed, before delegation ran.
    state.setBrainCursor(PROJECT, state.store.head(PROJECT));
    await brain(new FakePlannerModel([])).runOnce();
    expect(byKey(goal.goal_id)['billing-service']).toMatchObject({ status: 'ASSIGNED' });
    expect(accept(be)).toHaveLength(1);
  });

  it('retries an action that fails, then asks a human', async () => {
    let calls = 0;
    const b = brain(new FakePlannerModel([fixture('01-plan.json')]), {
      projectContext: () => {
        calls += 1;
        throw new Error('disk unavailable');
      },
    });
    const goal = state.createGoal(PROJECT, human, { request: GOAL });
    await b.runOnce();
    expect(calls).toBe(3);
    expect(pending()).toMatchObject([
      { kind: 'action_failed', goal_id: goal.goal_id, question: expect.stringContaining('disk unavailable') },
    ]);
    expect(state.brainJobs(PROJECT, ['failed'])).toMatchObject([{ kind: 'plan', attempts: 3 }]);
  });

  it('keeps a second failure while a revision waits, and revises again once it is decided', async () => {
    const model = new FakePlannerModel([
      fixture('01-plan.json'),
      fixture('02-replan.json'),
      reworkOf('billing-service'),
    ]);
    const b = brain(model);
    const { be, fe, goal } = await startStripe(b);
    finish(fe, byKey(goal.goal_id)['subscribe-page'] as TaskView, false);
    await b.runOnce();
    const planId = planOf(goal.goal_id);
    expect(state.q.planVersion(planId, 2)?.status).toBe('PROPOSED');
    // The backend task fails while v2 waits for a human: the revision for it waits too.
    finish(be, byKey(goal.goal_id)['billing-service'] as TaskView, false);
    await b.runOnce();
    expect(state.q.planVersion(planId, 3)).toBeUndefined();
    expect(state.brainJobs(PROJECT, ['waiting'])).toMatchObject([
      { kind: 'replan', task_id: byKey(goal.goal_id)['billing-service']?.task_id },
    ]);
    // v2 reworks only the page. Once approved, the backend failure gets its own revision.
    state.approvePlan(PROJECT, human, planId, 2);
    await b.runOnce();
    const v3 = state.q.planVersion(planId, 3);
    expect(v3?.status).toBe('PROPOSED');
    expect(v3?.tasks.find((t) => t.key === 'billing-service')?.change).toBe('rework');
    expect(model.remaining).toBe(0);
  });

  it('asks a human when a revision is rejected while tasks still failed, and revises with the answer', async () => {
    const model = new FakePlannerModel([
      fixture('01-plan.json'),
      fixture('02-replan.json'),
      reworkOf('subscribe-page', 'do not show VAT yet'),
    ]);
    const b = brain(model);
    const { fe, goal } = await startStripe(b);
    finish(fe, byKey(goal.goal_id)['subscribe-page'] as TaskView, false);
    await b.runOnce();
    const planId = planOf(goal.goal_id);
    state.rejectPlan(PROJECT, human, planId, 2, 'pricing is not decided');
    await b.runOnce();
    const asked = pending().find((e) => e.kind === 'plan_rejected');
    expect(asked).toMatchObject({ goal_id: goal.goal_id, question: expect.stringContaining('pricing is not decided') });
    expect(state.q.planVersion(planId, 3)).toBeUndefined();
    state.answerEscalation(PROJECT, human, String(asked?.escalation_id), 'do not show VAT yet');
    await b.runOnce();
    expect(state.q.planVersion(planId, 3)?.status).toBe('PROPOSED');
    const prompt = model.requests.at(-1)?.prompt ?? '';
    expect(prompt).toContain('The human rejected plan v2: pricing is not decided');
    expect(prompt).toContain('do not show VAT yet');
  });

  it('keeps coordinating while a slow model call is in flight', async () => {
    const dev = register('dev-1', 'developer');
    const human1 = state.createGoal(PROJECT, human, { request: 'Add a VAT note to prices', plan: false });
    const draft = parsePlanDraft({
      objective: 'Show a VAT note',
      summary: 'Two steps',
      tasks: [
        { key: 'note', summary: 'Add the note', acceptance_criteria: ['shown'], scope: { write: ['frontend/src/**'] } },
        {
          key: 'tests',
          summary: 'Test the note',
          acceptance_criteria: ['tested'],
          depends_on: ['note'],
          scope: { write: ['frontend/test/**'] },
        },
      ],
    });
    if (!draft.ok) throw new Error(draft.errors.join('; '));
    const v = state.proposePlan(PROJECT, human, human1.goal_id, proposalFromDraft(draft.value, { trigger: 'human' }));
    state.approvePlan(PROJECT, human, v.plan_id, v.version);
    const slow = new FakePlannerModel([{ ...fixture('01-plan.json'), delay_ms: 800 }]);
    const b = brain(slow);
    b.start();
    await until(() => byKey(human1.goal_id).note?.status === 'ASSIGNED');
    accept(dev);
    // A second goal sends the planner off for a while...
    const planned = state.createGoal(PROJECT, human, { request: GOAL });
    await until(() => slow.requests.length === 1);
    // ...and meanwhile the first goal's task completes: its dependent starts without waiting for the model.
    finish(dev, byKey(human1.goal_id).note as TaskView, true);
    await until(() => byKey(human1.goal_id).tests?.status === 'ASSIGNED', 600);
    expect(state.q.goal(PROJECT, planned.goal_id).plan_id).toBeNull();
    await until(() => state.q.goal(PROJECT, planned.goal_id).plan_id !== null);
  });

  it('records a call cut short by a restart as interrupted, counts its estimate, and tries again', async () => {
    const goal = state.createGoal(PROJECT, human, { request: GOAL });
    // The previous daemon had consumed the event and was waiting on the provider when it died.
    const [jobId] = state.enqueueBrainJobs(
      PROJECT,
      [
        {
          kind: 'plan',
          goal_id: goal.goal_id,
          task_id: null,
          reason: 'first plan',
          dedupe_key: `plan:${goal.goal_id}`,
          source_sequence: 1,
        },
      ],
      state.store.head(PROJECT),
    );
    state.updateBrainJob(jobId as string, { status: 'calling', call_estimate_usd: 0.42 });
    await brain(new FakePlannerModel([fixture('01-plan.json')])).runOnce();
    const calls = state.q.modelCalls(PROJECT);
    expect(calls.map((c) => c.status)).toEqual(['ok', 'interrupted']);
    expect(calls[1]).toMatchObject({ cost_usd: null, cost_estimate_usd: 0.42 });
    expect(state.q.planVersion(planOf(goal.goal_id), 1)?.status).toBe('PROPOSED');
  });
});

describe('stale proposals (review F06)', () => {
  it('refuses a revision that would drop a task an agent started after it was proposed', async () => {
    const b = brain(new FakePlannerModel([fixture('01-plan.json')]));
    const { be, goal } = await startStripe(b);
    const planId = planOf(goal.goal_id);
    finish(be, byKey(goal.goal_id)['billing-service'] as TaskView, true);
    await b.runOnce(); // stripe-webhooks becomes READY and is assigned to be-1
    const webhooks = byKey(goal.goal_id)['stripe-webhooks'] as TaskView;
    // Undo the assignment so the task is READY when the human writes the revision.
    state.releaseTask(PROJECT, human, webhooks.task_id, 'human reshuffle');
    const active = state.q.planVersion(planId, 1);
    if (!active) throw new Error('no v1');
    const existing = existingTasks(active, (id) => state.q.findTask(PROJECT, id));
    const draft = parseReplanDraft(existing)({
      summary: 'Drop the webhooks for now',
      rationale: 'Not needed yet.',
      drop: [
        { task_id: webhooks.task_id, reason: 'later' },
        { task_id: byKey(goal.goal_id)['lifecycle-tests']?.task_id as string, reason: 'needs the webhooks' },
      ],
    });
    if (!draft.ok) throw new Error(draft.errors.join('; '));
    const v2 = state.proposePlan(
      PROJECT,
      human,
      goal.goal_id,
      proposalFromReplan(active, draft.value, (id) => state.q.findTask(PROJECT, id), { trigger: 'human' }),
    );
    // An agent starts the task before anyone approves v2.
    await b.runOnce();
    accept(be);
    expect(state.q.task(PROJECT, webhooks.task_id).status).toBe('RUNNING');
    const err = (() => {
      try {
        state.approvePlan(PROJECT, human, planId, v2.version);
      } catch (e) {
        return e;
      }
    })() as FridayError;
    expect(err).toBeInstanceOf(FridayError);
    expect(err.errorName).toBe('plan_outdated');
    expect(err.message).toContain('was to be dropped, but it is RUNNING');
    expect(state.q.planVersion(planId, 1)?.status).toBe('ACTIVE');
    expect(state.q.task(PROJECT, webhooks.task_id).status).toBe('RUNNING');
  });
});

describe('human requirements stay authoritative (review F07)', () => {
  it('keeps the human constraints and sends them, with the objective, on every revision', async () => {
    const model = new FakePlannerModel([
      {
        ...fixture('01-plan.json'),
        output: { ...(fixture('01-plan.json').output as object), constraints: ['use the Stripe test mode'] },
      },
      fixture('02-replan.json'),
    ]);
    const b = brain(model);
    register('be-1', 'backend');
    const fe = register('fe-1', 'frontend');
    const goal = state.createGoal(PROJECT, human, {
      request: GOAL,
      constraints: ['never change one-time checkout'],
      outcomes: ['monthly plans can be bought'],
    });
    await b.runOnce();
    const g = state.q.goal(PROJECT, goal.goal_id);
    expect(g.constraints).toEqual(['never change one-time checkout']);
    expect(g.outcomes).toEqual(['monthly plans can be bought']);
    expect(g.inferred_constraints).toEqual(['use the Stripe test mode']);
    state.approvePlan(PROJECT, human, g.plan_id as string, 1);
    await b.runOnce();
    accept(fe);
    finish(fe, byKey(goal.goal_id)['subscribe-page'] as TaskView, false);
    await b.runOnce();
    const replan = model.requests.find((r) => r.purpose === 'replan')?.prompt ?? '';
    expect(replan).toContain('Constraints from the human (authoritative):\n- never change one-time checkout');
    expect(replan).toContain('Outcomes the human expects (authoritative):\n- monthly plans can be bought');
    expect(replan).toContain(`Objective: ${g.objective}`);
    expect(replan).toContain('Constraints inferred by an earlier planning call:\n- use the Stripe test mode');
  });
});

describe('reservations end (review F08)', () => {
  it('releases an automatic reservation when its agent is gone or does not claim in time', async () => {
    const b = brain(new FakePlannerModel([fixture('01-plan.json')]));
    const a = register('be-1', 'backend', 'attach');
    const goal = state.createGoal(PROJECT, human, { request: GOAL });
    await b.runOnce();
    state.approvePlan(PROJECT, human, planOf(goal.goal_id), 1);
    await b.runOnce();
    const billing = byKey(goal.goal_id)['billing-service'];
    expect(billing).toMatchObject({ reserved_for_agent_key: 'be-1', reserved_by: 'master_brain' });
    expect(billing?.reserved_until).toBeTruthy();
    // be-1's session ends for good; a new backend agent attaches.
    const b2 = register('be-2', 'backend', 'attach');
    clock.advance(state.config.leaseTtlMs + 1);
    state.heartbeat(PROJECT, b2.harness_id);
    state.tick(PROJECT);
    clock.advance(state.config.reconnectWindowMs + 1);
    state.heartbeat(PROJECT, b2.harness_id);
    const t = state.tick(PROJECT);
    expect(state.q.findHarness(a.harness_id)?.status).toBe('TERMINATED');
    expect(t.unreserved).toContain(billing?.task_id);
    await b.runOnce();
    expect(byKey(goal.goal_id)['billing-service']).toMatchObject({ reserved_for_agent_key: 'be-2' });
    // be-2 does not claim it in time either: the reservation runs out.
    clock.advance(state.config.reservationTtlMs + 1);
    state.heartbeat(PROJECT, b2.harness_id);
    expect(state.tick(PROJECT).unreserved).toContain(billing?.task_id);
  });

  it("keeps a human's reservation, and lets a human release it", () => {
    const task = state.createTask(PROJECT, human, { summary: 'manual task', assign_agent_key: 'ghost' });
    expect(task).toMatchObject({ status: 'READY', reserved_for_agent_key: 'ghost', reserved_by: 'human' });
    clock.advance(state.config.reservationTtlMs * 10);
    expect(state.tick(PROJECT).unreserved).toEqual([]);
    const freed = state.unreserveTask(PROJECT, human, task.task_id, 'ghost is not coming');
    expect(freed).toMatchObject({ reserved_for_agent_key: null, reserved_by: null });
    expect(state.store.readByRef(PROJECT, 'task', task.task_id).at(-1)?.type).toBe('task.reservation_released');
  });
});
