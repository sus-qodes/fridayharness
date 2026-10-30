import { sequentialIds } from '@friday/core';
import { openDatabase } from '@friday/db';
import { type Actor, FridayError, HarnessRegisterParams } from '@friday/protocol';
import { ROLE_REGISTRY_SOURCE, resolveTaskRole } from '@friday/routing';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { FridayState, type PlanTaskInput } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };

let state: FridayState;

beforeEach(() => {
  state = new FridayState({
    db: openDatabase(':memory:'),
    clock: new FakeClock('2026-10-21T10:00:00.000Z'),
    ids: sequentialIds(),
  });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

const planTask = (key: string, role: string, write: string): PlanTaskInput => ({
  key,
  change: 'new',
  task_id: null,
  kind: 'implementation',
  summary: `do ${key}`,
  description: null,
  acceptance_criteria: ['done'],
  depends_on: [],
  scope: { write: [write], read: [] },
  role,
  priority: 'normal',
  risk_level: 'low',
  note: null,
});

describe('task role resolution (R2)', () => {
  it('persists a task role contract once and lets a human replace it', () => {
    const task = state.createTask(PROJECT, human, {
      summary: 'Build the checkout API',
      kind: 'implementation',
      role: 'backend',
      scope: { write: ['server/src/api.ts'], read: [] },
    });
    expect(task).toMatchObject({
      role: 'backend',
      role_source: 'task',
      role_confidence: 1,
      role_intent_version: expect.stringMatching(/^ri1_[0-9a-f]{16}$/),
      role_registry_version: ROLE_REGISTRY_SOURCE.version,
    });
    expect(task.role_decision_id).toMatch(/^rdec_/);
    expect(state.q.latestTaskRoleDecision(PROJECT, task.task_id)).toMatchObject({
      status: 'resolved',
      source: 'task',
      role: 'backend',
      confidence: 1,
      roles: [],
    });
    expect(state.store.readByRef(PROJECT, 'task', task.task_id).map((e) => e.type)).toEqual([
      'task.created',
      'task.role_resolved',
    ]);

    const resolved = state.assignTaskRole(PROJECT, human, task.task_id, 'frontend');
    expect(resolved).toMatchObject({ role: 'frontend', role_source: 'human' });
    expect(resolved.role_decision_id).not.toBe(task.role_decision_id);
    expect(state.q.latestTaskRoleDecision(PROJECT, task.task_id)).toMatchObject({
      status: 'resolved',
      source: 'human',
      role: 'frontend',
    });
    expect(() =>
      state.assignTaskRole(PROJECT, { kind: 'agent', id: 'agent_00000000000000000000000001' }, task.task_id, 'docs'),
    ).toThrow(FridayError);
  });

  it('does not let a classifier replace a deterministic fallback role', () => {
    const task = state.createTask(PROJECT, human, { summary: 'Tidy the docs', kind: 'docs' });
    expect(task).toMatchObject({ role: 'docs', role_source: 'kind_fallback' });
    expect(() =>
      state.recordTaskRoleDecision(PROJECT, { kind: 'system', id: 'role-classifier' }, task.task_id, {
        status: 'classified',
        assumptions: [],
        roles: [
          {
            role: 'backend_engineer',
            task_summary: 'Build an API instead',
            depends_on: [],
            confidence: 0.9,
          },
        ],
      }),
    ).toThrow(/kind_fallback role/);
    expect(state.q.task(PROJECT, task.task_id)).toMatchObject({ role: 'docs', role_source: 'kind_fallback' });
  });

  it('never lets an agent role change the task contract', () => {
    const harness = state.registerHarness(
      PROJECT,
      HarnessRegisterParams.parse({
        protocol_version: '1.0',
        harness_key: 'fake:frontend',
        vendor: 'generic',
        name: 'frontend',
        attach_mode: 'spawn',
        project_id: PROJECT,
        capabilities: { task_start: true },
        agent: { agent_key: 'fe-1', role: 'frontend' },
      }),
    );
    const task = state.createTask(PROJECT, human, {
      summary: 'Build the checkout API',
      kind: 'implementation',
      role: 'backend',
      scope: { write: ['server/src/api.ts'], read: [] },
      ready: true,
    });
    state.assignTask(PROJECT, human, task.task_id, 'fe-1');
    expect(state.q.task(PROJECT, task.task_id)).toMatchObject({
      role: 'backend',
      role_source: 'task',
      assigned_agent_id: harness.agent_id,
    });
    expect(state.q.latestTaskRoleDecision(PROJECT, task.task_id)).toMatchObject({
      source: 'task',
      role: 'backend',
    });
  });

  it('stores a multi-role decision as a proposed DAG and blocks dispatch until a human chooses', () => {
    const task = state.createTask(PROJECT, human, {
      summary: 'Split the checkout work',
      kind: 'implementation',
      scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: [] },
    });
    expect(task).toMatchObject({ role: null, role_source: 'missing' });
    expect(state.q.latestTaskRoleDecision(PROJECT, task.task_id)).toMatchObject({
      status: 'blocked',
      source: 'missing',
      questions: [expect.stringContaining('Which role')],
    });

    const proposed = state.recordTaskRoleDecision(PROJECT, { kind: 'system', id: 'role-classifier' }, task.task_id, {
      status: 'classified',
      assumptions: ['the page and the API can ship together'],
      roles: [
        {
          role: 'frontend_engineer',
          task_summary: 'Build the checkout page',
          depends_on: [],
          confidence: 0.9,
        },
        {
          role: 'backend_engineer',
          task_summary: 'Build the checkout API',
          depends_on: ['frontend_engineer'],
          confidence: 0.85,
        },
      ],
    });
    expect(proposed).toMatchObject({ role: null, role_source: 'decision_model' });
    const decision = state.q.latestTaskRoleDecision(PROJECT, task.task_id);
    expect(decision).toMatchObject({
      status: 'proposed',
      source: 'decision_model',
      confidence: 0.85,
      roles: [
        { role: 'frontend_engineer', depends_on: [] },
        { role: 'backend_engineer', depends_on: ['frontend_engineer'] },
      ],
      assumptions: ['the page and the API can ship together'],
    });
    expect(resolveTaskRole({ task: proposed, registry: ROLE_REGISTRY_SOURCE })).toMatchObject({
      role: null,
      source: 'decision_model',
      decision_id: proposed.role_decision_id,
    });

    const chosen = state.assignTaskRole(PROJECT, human, task.task_id, 'frontend');
    expect(chosen).toMatchObject({ role: 'frontend', role_source: 'human' });
    expect(state.q.latestTaskRoleDecision(PROJECT, task.task_id)).toMatchObject({
      status: 'resolved',
      source: 'human',
      roles: [],
    });
  });

  it('keeps a plan role authoritative: no classifier may replace it', () => {
    const goal = state.createGoal(PROJECT, human, { request: 'A checkout page', plan: false });
    const version = state.proposePlan(PROJECT, human, goal.goal_id, {
      summary: 'one page',
      rationale: '',
      needs_human: null,
      trigger: 'test',
      tasks: [planTask('page', 'frontend', 'apps/web/src/App.tsx')],
    });
    state.approvePlan(PROJECT, human, version.plan_id, version.version);
    const planned = state.q.goalTasks(PROJECT, goal.goal_id)[0];
    if (!planned) throw new Error('the approved plan did not materialize a task');
    expect(planned).toMatchObject({
      role: 'frontend',
      role_source: 'plan',
      role_confidence: 1,
      role_registry_version: ROLE_REGISTRY_SOURCE.version,
    });
    expect(state.q.latestTaskRoleDecision(PROJECT, planned.task_id)).toMatchObject({
      status: 'resolved',
      source: 'plan',
      role: 'frontend',
    });
    expect(state.store.readByRef(PROJECT, 'task', planned.task_id).map((e) => e.type)).toEqual([
      'task.created',
      'task.role_resolved',
      'plan.task_materialized',
      'task.ready',
    ]);

    expect(() =>
      state.recordTaskRoleDecision(PROJECT, { kind: 'system', id: 'role-classifier' }, planned.task_id, {
        status: 'classified',
        assumptions: [],
        roles: [
          {
            role: 'backend_engineer',
            task_summary: 'Build the API instead',
            depends_on: [],
            confidence: 0.9,
          },
        ],
      }),
    ).toThrow(/plan role/);
    expect(state.q.task(PROJECT, planned.task_id)).toMatchObject({ role: 'frontend', role_source: 'plan' });
  });
});
