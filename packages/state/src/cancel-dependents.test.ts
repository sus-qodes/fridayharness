/**
 * Cancelling a task other tasks depend on (2026-11-17). A task that waits for a cancelled one never
 * starts, so its goal never finished; the person who cancels now says what becomes of them: they
 * are cancelled too, through every level, or they stop waiting for it and start when the rest of
 * what they wait for is done.
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
    clock: new FakeClock('2026-11-17T10:00:00.000Z'),
    ids: sequentialIds(),
  });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

const task = (key: string, depends_on: string[] = []): PlanTaskInput => ({
  key,
  change: 'new',
  task_id: null,
  kind: 'implementation',
  summary: `do ${key}`,
  description: null,
  acceptance_criteria: ['done'],
  depends_on,
  scope: { write: [`${key}/**`], read: [] },
  role: 'developer',
  priority: 'normal',
  risk_level: 'low',
  note: null,
});

/** A goal whose plan is api → page → docs, with a `ci` task that depends on nothing. */
function chain() {
  const g = state.createGoal(PROJECT, human, { request: 'Ship the discount codes', plan: false });
  const v = state.proposePlan(PROJECT, human, g.goal_id, {
    summary: 'the plan',
    rationale: '',
    needs_human: null,
    trigger: 'human',
    tasks: [task('api'), task('page', ['api']), task('docs', ['page', 'api']), task('ci')],
  });
  state.approvePlan(PROJECT, human, v.plan_id, v.version);
  const ids = Object.fromEntries(
    (state.q.planVersion(v.plan_id, v.version)?.tasks ?? []).map((t) => [t.key, t.task_id as string]),
  );
  const status = (key: string) => state.q.task(PROJECT, ids[key] as string).status;
  return { goalId: g.goal_id, ids, status };
}

describe('cancelling a task others depend on', () => {
  it('leaves them waiting for it when nothing is said, as before', () => {
    const { ids, status } = chain();
    state.cancelTask(PROJECT, human, ids.api as string, 'not needed');
    expect([status('api'), status('page'), status('docs'), status('ci')]).toEqual([
      'CANCELLED',
      'PROPOSED',
      'PROPOSED',
      'READY',
    ]);
  });

  it('cancels them too, through every level, and nothing else', () => {
    const { ids, status } = chain();
    const r = state.cancelTaskAndDependents(PROJECT, human, ids.api as string, 'not needed', 'cancel');
    expect(r.task.status).toBe('CANCELLED');
    expect(r.cancelled.sort()).toEqual([ids.page, ids.docs].sort());
    expect(r.released).toEqual([]);
    expect([status('api'), status('page'), status('docs'), status('ci')]).toEqual([
      'CANCELLED',
      'CANCELLED',
      'CANCELLED',
      'READY',
    ]);
    // Each says why it was cancelled.
    const reasons = state.store
      .readSince(PROJECT, 0, { types: ['task.cancelled'] })
      .map((e) => (e.payload as { transition?: { reason?: string } }).transition?.reason ?? '');
    expect(reasons.filter((x) => x.includes(`it depended on ${ids.api}, which was cancelled`))).toHaveLength(2);
  });

  it('or lets them go on without it: they start once what else they wait for is done', () => {
    const { ids, status } = chain();
    const r = state.cancelTaskAndDependents(PROJECT, human, ids.api as string, 'not needed', 'release');
    // Both waited for api directly; docs still waits for page.
    expect(r.released.sort()).toEqual([ids.page, ids.docs].sort());
    expect(r.cancelled).toEqual([]);
    expect(state.q.dependencies(ids.page as string)).toEqual([]);
    expect(state.q.dependencies(ids.docs as string)).toEqual([ids.page]);
    expect([status('api'), status('page'), status('docs'), status('ci')]).toEqual([
      'CANCELLED',
      'READY',
      'PROPOSED',
      'READY',
    ]);
  });

  it('touches no task that is finished already, and none when nothing depends on it', () => {
    const { ids, status } = chain();
    // docs was cancelled earlier by the person: it is not cancelled again, nor released.
    state.cancelTask(PROJECT, human, ids.docs as string, 'later');
    const r = state.cancelTaskAndDependents(PROJECT, human, ids.api as string, 'not needed', 'cancel');
    expect(r.cancelled).toEqual([ids.page]);
    const alone = state.cancelTaskAndDependents(PROJECT, human, ids.ci as string, 'not needed', 'release');
    expect(alone).toMatchObject({ cancelled: [], released: [] });
    expect(status('ci')).toBe('CANCELLED');
  });
});
