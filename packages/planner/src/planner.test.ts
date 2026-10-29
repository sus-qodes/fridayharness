import { describe, expect, it } from 'vitest';
import { type DelegationCandidate, delegate, scoreCandidate } from './delegate.js';
import { diffPlanVersions, type PlanVersionTask } from './diff.js';
import { buildEscalation } from './escalate.js';
import { budgetedCost, type PlannerCall, runPlanner } from './model.js';
import { parsePlanDraft, parseReplanDraft } from './parse.js';
import { costOf, worstCaseCost } from './pricing.js';
import { PROMPT_VERSIONS } from './prompts.js';
import { AnthropicPlannerModel, structuredOutputSchema, wrapProjectContext } from './providers/anthropic.js';
import { FakePlannerModel } from './providers/fake.js';
import { ModelError, type ModelRequest, type ModelResponse } from './providers/types.js';
import { draftJsonSchema, type PlanDraftInput, type ReplanDraftInput } from './schemas.js';
import { type TriggerEvent, type TriggerFacts, triggersFor } from './triggers.js';
import type { ExistingTask } from './validate.js';

const task = (key: string, write: string[], depends_on: string[] = [], extra: Record<string, unknown> = {}) => ({
  key,
  summary: `Do ${key}`,
  acceptance_criteria: [`${key} works`],
  depends_on,
  scope: { write },
  ...extra,
});

/** The M2 gate goal on fixture-shop: four tasks, two of them parallel. */
export const STRIPE_PLAN: PlanDraftInput = {
  objective: 'Add Stripe subscriptions while keeping one-time checkout working',
  constraints: ['keep one-time checkout working'],
  outcomes: ['subscriptions can be created', 'webhooks update subscription state', 'tests cover the lifecycle'],
  summary: 'Backend subscription service and webhooks, a frontend flow, then lifecycle tests.',
  tasks: [
    task('backend-subscriptions', ['backend/src/billing/**'], [], { role: 'backend' }),
    task('frontend-subscribe', ['frontend/src/subscriptions/**'], [], { role: 'frontend' }),
    task('webhooks', ['backend/src/webhooks/**'], ['backend-subscriptions'], { role: 'backend' }),
    task('lifecycle-tests', ['backend/test/**', 'frontend/test/**'], ['webhooks', 'frontend-subscribe'], {
      kind: 'verification',
      role: 'qa',
    }),
  ],
};

const plan = (overrides: Partial<PlanDraftInput>) => parsePlanDraft({ ...STRIPE_PLAN, ...overrides });

describe('plan drafts', () => {
  it('accepts a well-formed plan and applies defaults', () => {
    const r = parsePlanDraft(STRIPE_PLAN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tasks[0]).toMatchObject({
      kind: 'implementation',
      priority: 'normal',
      risk_level: 'low',
      scope: { read: [] },
    });
    expect(r.value.needs_human).toBeNull();
  });

  it('rejects unsafe scopes, bad keys and oversized plans at the schema level', () => {
    for (const write of [['/etc/**'], ['C:/x/**'], ['backend\\src\\**'], ['../outside/**'], ['a/../../b']]) {
      const r = plan({ tasks: [task('one', write)] });
      expect(r.ok, JSON.stringify(write)).toBe(false);
      if (!r.ok) expect(r.errors.join(' ')).toMatch(/project-relative glob/);
    }
    expect(plan({ tasks: [task('Bad Key', ['a/**'])] }).ok).toBe(false);
    expect(plan({ tasks: Array.from({ length: 13 }, (_, i) => task(`t${i}`, [`d${i}/**`])) }).ok).toBe(false);
  });

  it('reports duplicate keys, unknown or self dependencies, cycles and missing write scopes', () => {
    const errors = (tasks: ReturnType<typeof task>[]) => {
      const r = plan({ tasks });
      return r.ok ? [] : r.errors;
    };
    expect(errors([task('a', ['x/**']), task('a', ['y/**'])])).toContain('task key "a" is used twice');
    expect(errors([task('a', ['x/**'], ['ghost'])]).join()).toMatch(/depends on "ghost", which is not a task key/);
    expect(errors([task('a', ['x/**'], ['a'])]).join()).toMatch(/depends on itself/);
    expect(errors([task('a', ['x/**'], ['b']), task('b', ['y/**'], ['a'])]).join()).toMatch(
      /cycle: a -> b -> a|cycle: b -> a -> b/,
    );
    expect(errors([task('a', [])]).join()).toMatch(/must declare scope.write/);
    expect(errors([task('a', [], [], { kind: 'research' })])).toEqual([]);
  });

  it('requires a dependency or disjoint scopes for tasks that would run in parallel', () => {
    const r = plan({ tasks: [task('api', ['backend/**']), task('billing', ['backend/src/billing/**'])] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/"api" and task "billing" can run at the same time/);
    expect(
      plan({ tasks: [task('api', ['backend/**']), task('billing', ['backend/src/billing/**'], ['api'])] }).ok,
    ).toBe(true);
  });

  it('allows a plan with no tasks only when it asks a human first', () => {
    expect(plan({ tasks: [] }).ok).toBe(false);
    expect(
      plan({ tasks: [], needs_human: { question: 'Which payment provider?', why: 'the request names none' } }).ok,
    ).toBe(true);
  });

  it('produces a JSON Schema without the $schema key', () => {
    const schema = draftJsonSchema('plan');
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe('object');
  });
});

describe('replan drafts', () => {
  const existing: ExistingTask[] = [
    {
      task_id: 'task_a',
      key: 'backend-subscriptions',
      kind: 'implementation',
      status: 'COMPLETED',
      depends_on: [],
      write: ['backend/src/billing/**'],
    },
    {
      task_id: 'task_b',
      key: 'frontend-subscribe',
      kind: 'implementation',
      status: 'RUNNING',
      depends_on: [],
      write: ['frontend/src/subscriptions/**'],
    },
    {
      task_id: 'task_c',
      key: 'webhooks',
      kind: 'implementation',
      status: 'FAILED',
      depends_on: ['task_a'],
      write: ['backend/src/webhooks/**'],
    },
    {
      task_id: 'task_d',
      key: 'lifecycle-tests',
      kind: 'verification',
      status: 'PROPOSED',
      depends_on: ['task_c', 'task_b'],
      write: ['backend/test/**'],
    },
  ];
  const replan = (draft: Partial<ReplanDraftInput>) =>
    parseReplanDraft(existing)({ summary: 'Fix the webhooks', ...draft });
  const errorsOf = (draft: Partial<ReplanDraftInput>) => {
    const r = replan(draft);
    return r.ok ? [] : r.errors;
  };

  it('accepts rework of a FAILED task plus a new task that depends on existing ones', () => {
    const r = replan({
      rework: [{ task_id: 'task_c', note: 'verify the Stripe signature before parsing the event' }],
      new_tasks: [task('webhook-fixtures', ['backend/src/webhooks/fixtures/**'], ['task_c'])],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    // The same new task writing into lifecycle-tests' area, with no ordering between them, is refused.
    const clash = replan({ new_tasks: [task('webhook-fixtures', ['backend/test/fixtures/**'], ['task_c'])] });
    expect(clash.ok).toBe(false);
    if (!clash.ok)
      expect(clash.errors[0]).toMatch(/"lifecycle-tests"\) and new task "webhook-fixtures" can run at the same time/);
  });

  it('only reworks FAILED tasks and only drops tasks that have not started', () => {
    expect(errorsOf({ rework: [{ task_id: 'task_b', note: 'again please' }] }).join()).toMatch(
      /task_b is RUNNING; only FAILED/,
    );
    expect(errorsOf({ drop: [{ task_id: 'task_b', reason: 'not needed' }] }).join()).toMatch(
      /task_b is RUNNING; only tasks that have not started/,
    );
    expect(errorsOf({ rework: [{ task_id: 'task_zzz', note: 'x y z' }] }).join()).toMatch(/not a task of this plan/);
    expect(
      errorsOf({
        rework: [{ task_id: 'task_c', note: 'x y z' }],
        drop: [{ task_id: 'task_c', reason: 'x y z' }],
      }).join(),
    ).toMatch(/both reworked and dropped/);
  });

  it('keeps the graph whole: no dropping what others need, no unknown or cancelled dependencies, no key reuse', () => {
    expect(errorsOf({ drop: [{ task_id: 'task_d', reason: 'replaced' }] })).toEqual([]);
    expect(
      errorsOf({
        drop: [{ task_id: 'task_d', reason: 'replaced' }],
        new_tasks: [task('after-d', ['docs/**'], ['task_d'])],
      }).join(),
    ).toMatch(/depends on task_d, which is being dropped/);
    expect(errorsOf({ new_tasks: [task('x', ['docs/**'], ['nope'])] }).join()).toMatch(
      /neither a new task key nor a task of this plan/,
    );
    expect(errorsOf({ new_tasks: [task('webhooks', ['docs/**'])] }).join()).toMatch(/already used in this plan/);
  });

  it('rejects an empty revision unless it asks a human', () => {
    expect(errorsOf({}).join()).toMatch(/changes nothing/);
    expect(
      errorsOf({ needs_human: { question: 'Can the tests use Stripe test mode?', why: 'it needs a secret key' } }),
    ).toEqual([]);
  });

  it('reports parallel write conflicts only for what the revision adds', () => {
    // task_b (RUNNING) writes frontend/src/subscriptions/**; a new unordered task writing the same area conflicts.
    expect(errorsOf({ new_tasks: [task('ui-polish', ['frontend/src/**'])] }).join()).toMatch(
      /can run at the same time/,
    );
    expect(errorsOf({ new_tasks: [task('ui-polish', ['frontend/src/**'], ['task_b'])] })).toEqual([]);
  });
});

describe('plan version diff', () => {
  const t = (
    key: string,
    change: PlanVersionTask['change'],
    extra: Partial<PlanVersionTask> = {},
  ): PlanVersionTask => ({
    key,
    task_id: `task_${key}`,
    change,
    kind: 'implementation',
    summary: key,
    depends_on: [],
    write: [`${key}/**`],
    acceptance_criteria: ['ok'],
    role: 'developer',
    note: null,
    ...extra,
  });
  it('lists added, dropped, reworked, changed and unchanged tasks', () => {
    const v1 = [t('a', 'new'), t('b', 'new'), t('c', 'new'), t('d', 'new')];
    const v2 = [
      t('a', 'keep'),
      t('b', 'rework', { note: 'fix it' }),
      t('c', 'drop'),
      t('d', 'keep', { summary: 'renamed' }),
      t('e', 'new'),
    ];
    const d = diffPlanVersions(v1, v2);
    expect(d.added.map((x) => x.key)).toEqual(['e']);
    expect(d.reworked.map((x) => x.key)).toEqual(['b']);
    expect(d.dropped.map((x) => x.key)).toEqual(['c']);
    expect(d.changed).toEqual([{ task: v2[3], fields: ['summary'] }]);
    expect(d.unchanged).toBe(1);
  });

  it('compares dependencies by key: version 1 names keys, revisions name task ids', () => {
    const v1 = [t('a', 'new'), t('b', 'new', { depends_on: ['a'] })];
    const v2 = [t('a', 'keep'), t('b', 'keep', { depends_on: ['task_a'] })];
    expect(diffPlanVersions(v1, v2)).toMatchObject({ changed: [], unchanged: 2 });
    const v3 = [t('a', 'keep'), t('b', 'keep', { depends_on: [] })];
    expect(diffPlanVersions(v2, v3).changed.map((c) => c.fields)).toEqual([['depends_on']]);
  });
});

describe('delegation', () => {
  const agent = (key: string, extra: Partial<DelegationCandidate> = {}): DelegationCandidate => ({
    agent_id: `agent_${key}`,
    agent_key: key,
    role: 'developer',
    status: 'AVAILABLE',
    shadow: false,
    harness_live: true,
    current_task_id: null,
    completed: 0,
    failed: 0,
    recent_paths: [],
    goals_done: [],
    cost: 0,
    ...extra,
  });
  const backendTask = { task_id: 'task_1', goal_id: 'goal_1', role: 'backend', write: ['backend/src/billing/**'] };

  it('prefers the agent whose harness can run the better model for the task, at its cost (ADR-0031 §9)', () => {
    const strong = agent('b-strong', { model_fit: 0.92, cost: 0.4 });
    const weak = agent('a-weak', { model_fit: 0.66, cost: 0.01 });
    const d = delegate(backendTask, [weak, strong], []);
    expect(d.agent_key).toBe('b-strong');
    expect(d.scores.find((s) => s.agent_key === 'b-strong')?.parts).toMatchObject({ model_fit: 0.92, cost: 0.4 });
    // Without routing every agent scores 0 here, and the old order holds.
    expect(delegate(backendTask, [agent('b'), agent('a')], []).agent_key).toBe('a');
  });

  it('excludes unavailable agents and says why', () => {
    const scores = [
      agent('a', { harness_live: false }),
      agent('b', { shadow: true }),
      agent('c', { current_task_id: 'task_9' }),
      agent('d', { status: 'DISCONNECTED' }),
    ].map((c) => scoreCandidate(backendTask, c));
    expect(scores.map((s) => [s.eligible, s.reason])).toEqual([
      [false, 'no live session'],
      [false, 'shadow session'],
      [false, 'busy with task_9'],
      [false, 'agent is DISCONNECTED'],
    ]);
  });

  it('gives a task that names a role to a free agent of that role, whatever the others did before (LESSONS D-48)', () => {
    const frontendTask = { task_id: 'task_2', goal_id: 'goal_1', role: 'frontend', write: ['frontend/**'] };
    // As in the interactive check: a generalist that did frontend work before, a frontend agent new to it.
    const generalist = agent('dev-1', { recent_paths: ['frontend/src/pricing/discount.ts'], completed: 4 });
    const specialist = agent('fe-1', { role: 'frontend' });
    expect(scoreCandidate(frontendTask, generalist).total).toBeGreaterThan(
      scoreCandidate(frontendTask, specialist).total,
    );
    const d = delegate(frontendTask, [generalist, specialist], []);
    expect(d.agent_key).toBe('fe-1');
    expect(d.reason).toContain('frontend');
    // With no free agent of that role, the score decides.
    const busy = agent('fe-1', { role: 'frontend', current_task_id: 'task_9' });
    expect(delegate(frontendTask, [generalist, busy], []).agent_key).toBe('dev-1');
    // A task for any developer names no role: the score decides.
    expect(delegate({ ...frontendTask, role: 'developer' }, [generalist, specialist], []).agent_key).toBe('dev-1');
  });

  it('prefers role fit, then context, reliability and locality; ties go to the lower key', () => {
    const decision = delegate(
      backendTask,
      [
        agent('dev-2'),
        agent('dev-1'),
        agent('be-1', { role: 'backend' }),
        agent('be-2', {
          role: 'backend',
          recent_paths: ['backend/src/billing/plans.ts'],
          completed: 3,
          goals_done: ['goal_1'],
        }),
      ],
      [],
    );
    expect(decision.agent_key).toBe('be-2');
    expect(decision.scores.map((s) => s.agent_key)).toEqual(['be-2', 'be-1', 'dev-1', 'dev-2']);
    expect(decision.scores[0]?.parts).toMatchObject({
      capability_fit: 1,
      context_fit: 1,
      locality: 1,
      availability: 1,
    });
    // The same state always gives the same answer.
    expect(delegate(backendTask, [agent('dev-2'), agent('dev-1')], [])).toEqual(
      delegate(backendTask, [agent('dev-1'), agent('dev-2')], []),
    );
  });

  it('holds a task whose write scope overlaps running work, but never a read-only one', () => {
    expect(delegate(backendTask, [agent('dev-1')], [['backend/**']])).toMatchObject({
      agent_key: null,
      reason: expect.stringContaining('overlaps'),
    });
    expect(delegate({ ...backendTask, write: [] }, [agent('dev-1')], [['backend/**']]).agent_key).toBe('dev-1');
    expect(delegate(backendTask, [], []).reason).toMatch(/stays claimable/);
  });
});

describe('Master Brain trigger table', () => {
  const facts = (over: Partial<TriggerFacts> = {}): TriggerFacts => ({
    goalOf: (id) => (id.startsWith('task_g') ? 'goal_1' : null),
    failuresOf: () => 1,
    replansOf: () => 0,
    goalOfPlan: () => 'goal_1',
    brainEscalation: (id) =>
      id === 'esc_brain'
        ? { goal_id: 'goal_1', replan: true, force: false }
        : id === 'esc_question'
          ? { goal_id: 'goal_1', replan: true, force: true }
          : id === 'esc_decided'
            ? { goal_id: 'goal_1', replan: false, force: false }
            : null,
    planner: { available: true, reason: '' },
    limits: { escalateAfterFailures: 2, maxReplans: 3, autoApprove: false },
    ...over,
  });
  const ev = (
    type: string,
    payload: Record<string, unknown>,
    actor = { kind: 'human', id: 'local-operator' },
  ): TriggerEvent => ({ type, actor, payload });

  it.each([
    [
      'goal.created',
      ev('goal.created', { goal: { goal_id: 'goal_1' } }),
      facts(),
      [{ kind: 'plan', goal_id: 'goal_1' }],
    ],
    [
      'goal.created without a planner',
      ev('goal.created', { goal: { goal_id: 'goal_1' } }),
      facts({ planner: { available: false, reason: 'no key' } }),
      [{ kind: 'escalate', goal_id: 'goal_1', task_id: null, reason: 'planner_unavailable', detail: 'no key' }],
    ],
    [
      'goal.created with a human plan',
      ev('goal.created', { goal: { goal_id: 'goal_1' }, plan_requested: false }),
      facts(),
      [],
    ],
    ['plan.proposed', ev('plan.proposed', { plan: { plan_id: 'plan_1', version: 1 } }), facts(), []],
    [
      'plan.proposed with auto-approve',
      ev('plan.proposed', { plan: { plan_id: 'plan_1', version: 1 } }),
      facts({ limits: { escalateAfterFailures: 2, maxReplans: 3, autoApprove: true } }),
      [{ kind: 'auto_approve', plan_id: 'plan_1', version: 1 }],
    ],
    ['plan.approved', ev('plan.approved', {}), facts(), [{ kind: 'delegate' }]],
    [
      'agent becomes available',
      ev('agent.status_changed', { transition: { to: 'AVAILABLE' } }),
      facts(),
      [{ kind: 'delegate' }],
    ],
    ['agent becomes busy', ev('agent.status_changed', { transition: { to: 'BUSY' } }), facts(), []],
    [
      'harness terminated',
      ev('harness.status_changed', { harness_id: 'harness_1', transition: { to: 'TERMINATED' } }),
      facts(),
      [{ kind: 'release_lost', harness_id: 'harness_1' }, { kind: 'delegate' }],
    ],
    [
      'plan task completed',
      ev('task.completed', { task_id: 'task_g1' }),
      facts(),
      [
        { kind: 'ready_dependents', task_id: 'task_g1' },
        { kind: 'check_goal', goal_id: 'goal_1' },
        { kind: 'delegate' },
      ],
    ],
    ['task outside a plan completed', ev('task.completed', { task_id: 'task_x' }), facts(), []],
    [
      'plan task failed',
      ev('task.failed', { task_id: 'task_g1' }),
      facts(),
      [{ kind: 'replan', goal_id: 'goal_1', task_id: 'task_g1', reason: 'verification failed' }],
    ],
    [
      'plan task failed again',
      ev('task.failed', { task_id: 'task_g1' }),
      facts({ failuresOf: () => 2 }),
      [
        {
          kind: 'escalate',
          goal_id: 'goal_1',
          task_id: 'task_g1',
          reason: 'repeated_verification_failures',
          detail: 'task_g1 failed verification 2 times',
        },
      ],
    ],
    [
      'replan budget used up',
      ev('task.failed', { task_id: 'task_g1' }),
      facts({ replansOf: () => 3 }),
      [
        {
          kind: 'escalate',
          goal_id: 'goal_1',
          task_id: 'task_g1',
          reason: 'replan_limit',
          detail: 'the plan was already revised 3 times',
        },
      ],
    ],
    [
      'human cancels a plan task',
      ev('task.cancelled', { task_id: 'task_g2' }),
      facts(),
      [
        { kind: 'replan', goal_id: 'goal_1', task_id: 'task_g2', reason: 'a task was cancelled by a human' },
        { kind: 'check_goal', goal_id: 'goal_1' },
      ],
    ],
    [
      'brain drops a task',
      ev('task.cancelled', { task_id: 'task_g2' }, { kind: 'master_brain', id: 'brain' }),
      facts(),
      [],
    ],
    [
      'human answers the brain',
      ev('escalation.answered', { escalation_id: 'esc_brain' }),
      facts(),
      [
        {
          kind: 'replan',
          goal_id: 'goal_1',
          task_id: null,
          reason: 'a human answered the Master Brain',
          escalation_id: 'esc_brain',
        },
      ],
    ],
    [
      'human answers the question a pending proposal asked',
      ev('escalation.answered', { escalation_id: 'esc_question' }),
      facts(),
      [
        {
          kind: 'replan',
          goal_id: 'goal_1',
          task_id: null,
          reason: 'a human answered the Master Brain',
          escalation_id: 'esc_question',
          force: true,
        },
      ],
    ],
    [
      'human rejects a proposal',
      ev('plan.rejected', { plan_id: 'plan_1', version: 2, note: 'too broad' }),
      facts(),
      [{ kind: 'after_rejection', goal_id: 'goal_1', plan_id: 'plan_1', version: 2, note: 'too broad' }],
    ],
    ['a reservation ends', ev('task.reservation_released', { task_id: 'task_g1' }), facts(), [{ kind: 'delegate' }]],
    ['human answers an agent', ev('escalation.answered', { escalation_id: 'esc_agent' }), facts(), []],
    [
      'Friday closes a question its task made moot',
      ev('escalation.answered', { escalation_id: 'esc_brain', moot: true }, { kind: 'system', id: 'friday' }),
      facts(),
      [],
    ],
    [
      'human answers after deciding the proposal',
      ev('escalation.answered', { escalation_id: 'esc_decided' }),
      facts(),
      [],
    ],
    ['unrelated event', ev('policy.evaluated', {}), facts(), []],
  ])('%s', (_name, event, f, expected) => {
    expect(triggersFor(event, f)).toEqual(expected);
  });
});

describe('escalations', () => {
  it('carry the six fields of spec Part 03 §11', () => {
    const e = buildEscalation({
      reason: 'repeated_verification_failures',
      goal_id: 'goal_1',
      task_id: 'task_1',
      blocked: 'task_1 (webhooks)',
      why: 'it failed verification twice',
      question: 'Rework again, reassign, or cancel?',
      options: ['rework', 'reassign', 'cancel', 'split', 'too many'],
      proposed_action: 'reassign to another agent',
      evidence: ['tests: FAILED (exit 1)', 'x'.repeat(900)],
    });
    expect(Object.keys(e.details).sort()).toEqual([
      'blocked',
      'capability',
      'evidence',
      'proposed_action',
      'requested_by',
      'why',
    ]);
    expect(e.details).toMatchObject({ requested_by: 'master_brain', capability: 'human.decision' });
    expect(e.options).toHaveLength(4);
    expect(e.details.evidence[1]).toHaveLength(500);
  });
});

describe('cost accounting', () => {
  it('prices input, cache writes and reads, and output per model', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    };
    expect(costOf('claude-opus-5-5', usage)).toBe(4 + 20 + 5 + 0.2);
    expect(costOf('claude-opus-5-5', { ...usage, cache_write_1h_input_tokens: 1_000_000 })).toBe(4 + 20 + 8 + 0.2);
    expect(
      costOf('claude-sonnet-5-5', {
        input_tokens: 10_000,
        output_tokens: 2_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBe(0.04);
    // Unknown is not free (review F04); a dated snapshot id uses its model's price.
    expect(costOf('unknown-model', usage)).toBeNull();
    expect(costOf('claude-opus-5-5-20261001', usage)).toBe(4 + 20 + 5 + 0.2);
    expect(
      costOf('custom', usage, { custom: { input: 1, cache_write_5m: 1, cache_write_1h: 1, cache_read: 1, output: 1 } }),
    ).toBe(4);
  });

  it('uses the higher Haiku tier above 100K prompt tokens', () => {
    const small = {
      input_tokens: 50_000,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    expect(costOf('claude-haiku-5-5', small)).toBe(0.005);
    expect(costOf('claude-haiku-5-5', { ...small, input_tokens: 200_000 })).toBe(0.1);
  });
});

describe('worst-case estimates (review F04)', () => {
  it('counts every character as a token at the highest input price, plus all of max_tokens', () => {
    // 25,000 chars -> 10,000 tokens at $8/M (1h cache write) + 16,000 output tokens at $20/M.
    expect(worstCaseCost('claude-opus-5-5', 25_000, 16_000)).toBe(0.08 + 0.32);
    expect(worstCaseCost('unknown-model', 25_000, 16_000)).toBeNull();
  });
});

describe('runPlanner', () => {
  const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
    purpose: 'plan',
    model: 'claude-opus-5-5',
    system: 'plan it',
    context: 'project context',
    instructions: 'first plan',
    prompt: 'Goal goal_1: add subscriptions',
    schema: draftJsonSchema('plan'),
    schemaName: 'plan',
    maxTokens: 16_000,
    ...over,
  });
  const policy = { allowRemote: false, spentTodayUsd: 0, dailyBudgetUsd: 5 };
  const run = (model: FakePlannerModel, p = policy) =>
    runPlanner(model, request(), parsePlanDraft, p, { promptVersion: PROMPT_VERSIONS.plan });

  it('returns a valid draft and records the call', async () => {
    const out = await run(new FakePlannerModel([{ purpose: 'plan', output: STRIPE_PLAN }]));
    expect(out.ok).toBe(true);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]).toMatchObject({
      status: 'ok',
      provider: 'fake',
      remote: false,
      attempt: 1,
      prompt_version: PROMPT_VERSIONS.plan,
    });
    expect(out.calls[0]?.cost_usd).toBeGreaterThan(0);
  });

  it('gives the model one repair attempt with the validation errors', async () => {
    const model = new FakePlannerModel([
      { purpose: 'plan', output: { ...STRIPE_PLAN, tasks: [task('a', ['x/**'], ['missing'])] } },
      { purpose: 'plan', output: STRIPE_PLAN },
    ]);
    const out = await run(model);
    expect(out.ok).toBe(true);
    expect(out.calls.map((c) => c.status)).toEqual(['invalid', 'ok']);
    expect(model.requests[1]?.repair?.errors.join()).toMatch(/depends on "missing"/);
    expect(model.requests[1]?.repair?.previous).toContain('"missing"');
  });

  it('gives up after a second invalid answer', async () => {
    const bad = { ...STRIPE_PLAN, tasks: [task('a', [])] };
    const out = await run(
      new FakePlannerModel([
        { purpose: 'plan', output: bad },
        { purpose: 'plan', output: bad },
      ]),
    );
    expect(out).toMatchObject({ ok: false, reason: 'invalid' });
    if (!out.ok) expect(out.errors.join()).toMatch(/must declare scope.write/);
  });

  it('reports provider errors without retrying them itself', async () => {
    const model = new FakePlannerModel([
      { purpose: 'plan', error: { code: 'rate_limited', message: '429', retryable: true } },
    ]);
    const out = await run(model);
    expect(out).toMatchObject({ ok: false, reason: 'provider' });
    expect(out.calls).toMatchObject([{ status: 'error', error_code: 'rate_limited' }]);
    expect(model.requests).toHaveLength(1);
  });

  it('never calls a remote provider without consent, or over budget', async () => {
    let called = 0;
    const remote = {
      provider: 'anthropic',
      remote: true,
      complete: async () => {
        called += 1;
        throw new Error('should not be called');
      },
    };
    const refused = await runPlanner(remote, request(), parsePlanDraft, policy, { promptVersion: 'plan-1' });
    expect(refused).toMatchObject({ ok: false, reason: 'refused' });
    if (!refused.ok) expect(refused.message).toMatch(/allow_remote: true/);
    const broke = await runPlanner(
      remote,
      request(),
      parsePlanDraft,
      { ...policy, allowRemote: true, spentTodayUsd: 5 },
      { promptVersion: 'plan-1' },
    );
    expect(broke).toMatchObject({ ok: false, reason: 'budget' });
    expect(called).toBe(0);
    expect(broke.calls).toMatchObject([{ status: 'refused', error_code: 'budget', cost_usd: 0 }]);
    // Not enough left for the worst case of this call: refused before sending.
    const tight = await runPlanner(
      remote,
      request(),
      parsePlanDraft,
      { ...policy, allowRemote: true, spentTodayUsd: 4.9 },
      { promptVersion: 'plan-1' },
    );
    expect(tight).toMatchObject({ ok: false, reason: 'budget' });
    // A model without a known price cannot be budgeted.
    const unpriced = await runPlanner(
      remote,
      request({ model: 'claude-future-9' }),
      parsePlanDraft,
      { ...policy, allowRemote: true },
      { promptVersion: 'plan-1' },
    );
    expect(unpriced).toMatchObject({ ok: false, reason: 'budget' });
    if (!unpriced.ok) expect(unpriced.message).toMatch(/no price is known for model claude-future-9/);
    expect(called).toBe(0);
  });

  /** A remote stand-in model whose answers the test scripts. */
  const remoteModel = (answers: Array<() => Promise<ModelResponse>>) => {
    const seen: ModelRequest[] = [];
    return {
      seen,
      model: {
        provider: 'anthropic',
        remote: true,
        complete: async (r: ModelRequest) => {
          seen.push(r);
          const next = answers.shift();
          if (!next) throw new Error('no more answers');
          return next();
        },
      },
    };
  };
  const usage = { input_tokens: 2000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const allowed = { allowRemote: true, spentTodayUsd: 0, dailyBudgetUsd: 5 };

  it('records a paid refusal or truncation with its usage, cost and request id (review F04)', async () => {
    for (const code of ['refused', 'truncated'] as const) {
      const { model } = remoteModel([
        async () => {
          throw new ModelError(code, code, false, undefined, {
            usage,
            model: 'claude-opus-5-5',
            requestId: 'req_paid',
            billed: 'yes',
          });
        },
      ]);
      const out = await runPlanner(model, request(), parsePlanDraft, allowed, { promptVersion: 'plan-2' });
      expect(out).toMatchObject({ ok: false, reason: 'provider' });
      expect(out.calls[0]).toMatchObject({ status: 'error', error_code: code, usage, request_id: 'req_paid' });
      expect(out.calls[0]?.cost_usd).toBe(0.028);
    }
  });

  it('keeps the cost of a cancelled request unknown, counted at its estimate', async () => {
    const { model } = remoteModel([
      async () => {
        throw new ModelError('timeout', 'the request was cancelled', false, undefined, { billed: 'unknown' });
      },
    ]);
    const out = await runPlanner(model, request(), parsePlanDraft, allowed, { promptVersion: 'plan-2' });
    expect(out.calls[0]?.cost_usd).toBeNull();
    expect(out.calls[0]?.cost_estimate_usd).toBeGreaterThan(0.3);
    expect(budgetedCost(out.calls[0] as PlannerCall)).toBe(out.calls[0]?.cost_estimate_usd);
  });

  it('prices an unknown snapshot id by the requested model', async () => {
    const { model } = remoteModel([
      async () => ({
        output: STRIPE_PLAN,
        model: 'claude-opus-5-5-x-preview',
        usage,
        stop_reason: 'end_turn',
        request_id: 'r',
      }),
    ]);
    const out = await runPlanner(model, request(), parsePlanDraft, allowed, { promptVersion: 'plan-2' });
    expect(out.ok).toBe(true);
    expect(out.calls[0]).toMatchObject({ model: 'claude-opus-5-5-x-preview', cost_usd: 0.028 });
  });

  it('checks the budget again before the repair attempt', async () => {
    const { model, seen } = remoteModel([
      async () => ({
        output: { ...STRIPE_PLAN, tasks: [task('a', [])] },
        model: 'claude-opus-5-5',
        // An expensive first answer leaves too little for a second attempt.
        usage: { ...usage, output_tokens: 220_000 },
        stop_reason: 'end_turn',
        request_id: 'r1',
      }),
    ]);
    const out = await runPlanner(
      model,
      request(),
      parsePlanDraft,
      { ...allowed, dailyBudgetUsd: 4.5 },
      { promptVersion: 'plan-2' },
    );
    expect(out).toMatchObject({ ok: false, reason: 'budget' });
    expect(seen).toHaveLength(1);
    expect(out.calls.map((c) => c.status)).toEqual(['invalid', 'refused']);
    if (!out.ok) expect(out.message).toMatch(/second attempt/);
  });
});

describe('Anthropic provider', () => {
  const KEY = 'sk-ant-api03-test-key-never-printed';
  const message = (text: string, extra: Record<string, unknown> = {}) => ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 300,
      output_tokens: 900,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 },
    },
    ...extra,
  });
  function stub(status: number, body: unknown) {
    const sent: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')),
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'request-id': 'req_123' },
      });
    }) as typeof fetch;
    return {
      sent,
      model: new AnthropicPlannerModel({
        apiKey: KEY,
        fetch: fetchStub,
        maxRetries: 0,
        cacheTtl: '1h',
        effort: 'high',
      }),
    };
  }
  const req: ModelRequest = {
    purpose: 'plan',
    model: 'claude-opus-5-5',
    system: 'You are the Master Brain.',
    context: 'Repository layout: backend/, frontend/, shared/',
    instructions: 'Your job now: the first plan.',
    prompt: 'Goal goal_1: add subscriptions',
    schema: draftJsonSchema('plan'),
    schemaName: 'plan',
    maxTokens: 16_000,
  };

  it('sends structured output, a cached context block and no sampling parameters', async () => {
    const { sent, model } = stub(200, message(JSON.stringify(STRIPE_PLAN)));
    const res = await model.complete(req);
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body as Record<string, unknown>;
    expect(sent[0]?.url).toMatch(/\/v1\/messages$/);
    expect(sent[0]?.headers.get('x-api-key')).toBe(KEY);
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      // Friday's rules first, the repository's text marked as source material (cached), then the job.
      system: [
        { type: 'text', text: req.system },
        { type: 'text', text: wrapProjectContext(req.context), cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: req.instructions },
      ],
      messages: [{ role: 'user', content: req.prompt }],
      output_config: { effort: 'high', format: { type: 'json_schema' } },
    });
    expect(body.temperature).toBeUndefined();
    expect(res).toMatchObject({
      output: STRIPE_PLAN,
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      request_id: 'req_123',
    });
    expect(res.usage).toEqual({
      input_tokens: 300,
      output_tokens: 900,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 0,
      cache_write_1h_input_tokens: 2000,
    });
  });

  it('sends a schema structured outputs accepts', () => {
    const schema = structuredOutputSchema(draftJsonSchema('plan'));
    const forbidden = ['minLength', 'maxLength', 'pattern', 'maximum', 'minimum', 'maxItems', 'default'];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      for (const k of forbidden) expect(o[k], k).toBeUndefined();
      if (typeof o.minItems === 'number') expect(o.minItems).toBeLessThanOrEqual(1);
      if (o.type === 'object') expect(o.additionalProperties).toBe(false);
      Object.values(o).forEach(walk);
    };
    walk(schema);
    expect(JSON.stringify(schema)).toContain('"tasks"');
  });

  it('turns a repair into an assistant turn followed by the errors', async () => {
    const { sent, model } = stub(200, message(JSON.stringify(STRIPE_PLAN)));
    await model.complete({ ...req, repair: { previous: '{"tasks":[]}', errors: ['tasks: too few'] } });
    const [first] = sent;
    if (!first) throw new Error('no request was sent');
    expect((first.body.messages as unknown[]).slice(1)).toEqual([
      { role: 'assistant', content: '{"tasks":[]}' },
      { role: 'user', content: expect.stringContaining('tasks: too few') },
    ]);
  });

  it('maps refusals, truncation and HTTP errors, and never echoes the key', async () => {
    const cases: Array<[number, unknown, string]> = [
      [200, message('{}', { stop_reason: 'refusal' }), 'refused'],
      [200, message('{"objective":', { stop_reason: 'max_tokens' }), 'truncated'],
      [429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'rate_limited'],
      [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'auth'],
      [529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 'overloaded'],
      [400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad schema' } }, 'bad_request'],
    ];
    for (const [status, body, code] of cases) {
      const { model } = stub(status, body);
      const err = await model.complete(req).catch((e: unknown) => e);
      expect(err, `${status} ${code}`).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe(code);
      expect((err as ModelError).message).not.toContain(KEY);
      // A refusal or a cut-off answer is billed and keeps its usage; an HTTP error is not billed (review F04).
      const e = err as ModelError;
      expect(e.billed, code).toBe(status === 200 ? 'yes' : 'no');
      expect(e.requestId, code).toBe('req_123');
      if (status === 200) expect(e.usage?.output_tokens).toBe(900);
    }
  });

  it('passes an unparseable answer on for validation and repair', async () => {
    const { model } = stub(200, message('not json'));
    expect((await model.complete(req)).output).toBe('not json');
  });
});
