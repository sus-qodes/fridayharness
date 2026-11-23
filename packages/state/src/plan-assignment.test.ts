/**
 * The agent a plan task is for (`assign_to`, 2026-11-16): kept with the plan version, and on
 * approval the task is reserved for that agent, a human's reservation that does not expire, so no
 * other free agent is given it first. A task that names none is created as before.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase } from '@friday/db';
import type { Actor } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { FridayState, type PlanTaskInput } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };

let state: FridayState;
beforeEach(() => {
  state = new FridayState({
    db: openDatabase(':memory:'),
    clock: new FakeClock('2026-11-16T10:00:00.000Z'),
    ids: sequentialIds(),
  });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

const planTask = (key: string, write: string, assign_to: string | null | undefined): PlanTaskInput => ({
  key,
  change: 'new',
  task_id: null,
  kind: 'implementation',
  summary: `do ${key}`,
  description: null,
  acceptance_criteria: ['done'],
  depends_on: [],
  scope: { write: [write], read: [] },
  role: 'developer',
  priority: 'normal',
  risk_level: 'low',
  note: null,
  ...(assign_to === undefined ? {} : { assign_to }),
});

describe('a plan task for one agent', () => {
  it('is kept with the plan, and reserved for that agent when the plan is approved', () => {
    const g = state.createGoal(PROJECT, human, { request: 'Ship the discount codes', plan: false });
    const v = state.proposePlan(PROJECT, human, g.goal_id, {
      summary: 'the plan',
      rationale: '',
      needs_human: null,
      trigger: 'test',
      tasks: [
        planTask('api', 'backend/**', null),
        planTask('docs', 'README.md', 'dev-1'),
        // A plan written before the field existed names no agent.
        planTask('page', 'frontend/**', undefined),
      ],
    });
    expect(v.tasks.map((t) => [t.key, t.assign_to])).toEqual([
      ['api', null],
      ['docs', 'dev-1'],
      ['page', null],
    ]);
    // Read back from the database, not only from what was proposed.
    expect(state.q.planVersion(v.plan_id, v.version)?.tasks.find((t) => t.key === 'docs')?.assign_to).toBe('dev-1');

    const approved = state.approvePlan(PROJECT, human, v.plan_id, v.version);
    const byKey = new Map(approved.created.map((t) => [t.plan_key, t]));
    // Reserved for its agent from the start, a human's reservation that does not expire.
    expect(byKey.get('docs')).toMatchObject({
      status: 'READY',
      reserved_for_agent_key: 'dev-1',
      reserved_by: 'human',
      reserved_until: null,
    });
    // The others are any agent's, as before.
    for (const key of ['api', 'page']) expect(byKey.get(key)?.reserved_for_agent_key, key).toBeNull();
  });

  it('keeps the agent through a revision that keeps the task', () => {
    const g = state.createGoal(PROJECT, human, { request: 'Ship the discount codes', plan: false });
    const v1 = state.proposePlan(PROJECT, human, g.goal_id, {
      summary: 'the plan',
      rationale: '',
      needs_human: null,
      trigger: 'test',
      tasks: [planTask('docs', 'README.md', 'dev-1')],
    });
    const approved = state.approvePlan(PROJECT, human, v1.plan_id, v1.version);
    const id = approved.created[0]?.task_id as string;
    const active = state.q.planVersion(v1.plan_id, v1.version);
    const kept = active?.tasks.map(({ position: _p, ...t }) => ({ ...t, change: 'keep' as const })) ?? [];
    const v2 = state.proposePlan(PROJECT, human, g.goal_id, {
      summary: 'the plan, with a page',
      rationale: '',
      needs_human: null,
      trigger: 'test',
      tasks: [...kept, planTask('page', 'frontend/**', null)],
      base_version: v1.version,
    });
    expect(v2.tasks.map((t) => [t.key, t.task_id, t.assign_to])).toEqual([
      ['docs', id, 'dev-1'],
      ['page', null, null],
    ]);
  });
});
