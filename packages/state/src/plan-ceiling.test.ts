/**
 * The permission ceiling on delegation (plan M12.2): a plan's tasks never hold more than the
 * project's policy declares for their role. A wider task is cut to the bound when the plan is
 * proposed, with a note a human reads; a task with nothing inside is refused; the bound is applied
 * again when the plan is approved, under the policy of that moment.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase } from '@friday/db';
import { type Actor, FridayError } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { FridayState, type PlanTaskInput } from './index.js';
import type { PlanBounds } from './service.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };

let state: FridayState;
beforeEach(() => {
  state = new FridayState({
    db: openDatabase(':memory:'),
    clock: new FakeClock('2026-10-18T10:00:00.000Z'),
    ids: sequentialIds(),
  });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

const planTask = (key: string, role: string, write: string[], extra: Partial<PlanTaskInput> = {}): PlanTaskInput => ({
  key,
  change: 'new',
  task_id: null,
  kind: 'implementation',
  summary: `do ${key}`,
  description: null,
  acceptance_criteria: ['done'],
  depends_on: [],
  scope: { write, read: [] },
  role,
  priority: 'normal',
  risk_level: 'low',
  note: null,
  ...extra,
});

const teams = (layers: PlanBounds['teams']): PlanBounds => ({ teams: layers });
const frontendOnly = teams({ frontend: [{ source: 'policies/teams.yaml', write: ['frontend/**'] }] });

function propose(tasks: PlanTaskInput[]) {
  const g = state.createGoal(PROJECT, human, { request: 'Ship the subscription flow', plan: false });
  const v = state.proposePlan(PROJECT, human, g.goal_id, {
    summary: 'the plan',
    rationale: '',
    needs_human: null,
    trigger: 'test',
    tasks,
  });
  return { goal: g, version: v };
}

describe('boundPlanTask', () => {
  it('keeps a task inside its role, cuts a wider one to the ceiling and refuses one outside it', () => {
    state.planBounds = () => frontendOnly;
    const bound = (write: string[]) =>
      state.boundPlanTask({ key: 'page', kind: 'implementation', role: 'frontend', write });
    expect(bound(['frontend/src/**'])).toEqual({ write: ['frontend/src/**'], note: null, refused: null });
    expect(bound(['**'])).toMatchObject({ write: ['frontend/**'], refused: null });
    expect(bound(['**']).note).toContain("cut to the project's scope for role frontend: frontend/**");
    expect(bound(['**']).note).toContain('the plan asked for **; policies/teams.yaml');
    // Partly inside: what lies inside stays, what lies outside goes, a wider glob becomes the ceiling.
    expect(bound(['frontend/app.ts', 'backend/**', '**'])).toMatchObject({ write: ['frontend/app.ts', 'frontend/**'] });
    const refused = bound(['backend/**', 'docs/*.md']);
    expect(refused.refused).toContain('task "page" (role frontend) would write backend/**, docs/*.md');
    expect(refused.refused).toContain('frontend/**, from policies/teams.yaml');
    // Other roles, and a project without team scopes, are not bounded.
    expect(state.boundPlanTask({ key: 'api', kind: 'implementation', role: 'backend', write: ['**'] })).toEqual({
      write: ['**'],
      note: null,
      refused: null,
    });
    state.planBounds = null;
    expect(bound(['**'])).toEqual({ write: ['**'], note: null, refused: null });
  });

  it('judges globs segment by segment, so a ceiling with wildcards is read exactly', () => {
    state.planBounds = () => teams({ qa: [{ source: 'teams.yaml', write: ['src/*/test/**', 'docs/*.md'] }] });
    const bound = (write: string[]) => state.boundPlanTask({ key: 'tests', kind: 'verification', role: 'qa', write });
    expect(bound(['src/api/test/**', 'docs/readme.md']).note).toBeNull();
    expect(bound(['src/api/test/a.test.ts', 'src/ui/test/*.ts']).note).toBeNull();
    // A segment the ceiling fixes cannot be widened: `**` in the task is inside only a `**` there.
    expect(bound(['src/**'])).toMatchObject({ write: ['src/*/test/**'] });
    expect(bound(['docs/**'])).toMatchObject({ write: ['docs/*.md'] });
    expect(bound(['src/api/**']).refused).toContain('nothing of it lies inside');
    expect(bound(['docs/guide.txt']).refused).toContain('nothing of it lies inside');
    // Case is folded, as the hooks fold it on Windows; a trailing slash means everything under.
    expect(bound(['SRC/api/TEST/x.ts']).note).toBeNull();
    state.planBounds = () => teams({ qa: [{ source: 'teams.yaml', write: ['src/'] }] });
    expect(bound(['src/anything/**']).note).toBeNull();
  });

  it('applies every source that declares a scope for the role, the strictest result standing', () => {
    state.planBounds = () =>
      teams({
        frontend: [
          { source: 'policies/a.yaml', write: ['frontend/**', 'shared/**'] },
          { source: 'policies/b.yaml', write: ['frontend/src/**'] },
        ],
      });
    const b = state.boundPlanTask({ key: 'page', kind: 'implementation', role: 'frontend', write: ['**'] });
    expect(b.write).toEqual(['frontend/src/**']);
    expect(b.note).toContain('policies/a.yaml');
    expect(b.note).toContain('policies/b.yaml');
  });
});

describe('a plan is bounded when it is proposed and again when it is approved', () => {
  it('records the cut task with the scope it will hold and a note, and materializes exactly that', () => {
    state.planBounds = () => frontendOnly;
    const { goal, version } = propose([
      planTask('page', 'frontend', ['**'], { note: 'the owner asked for this first' }),
      planTask('api', 'backend', ['backend/**']),
    ]);
    const page = version.tasks.find((t) => t.key === 'page');
    expect(page).toMatchObject({ scope: { write: ['frontend/**'], read: [] } });
    expect(page?.note).toContain('the owner asked for this first; scope.write cut to');
    expect(version.tasks.find((t) => t.key === 'api')).toMatchObject({ scope: { write: ['backend/**'] }, note: null });
    const approved = state.approvePlan(PROJECT, human, version.plan_id, version.version);
    const made = Object.fromEntries(approved.created.map((t) => [t.plan_key, t]));
    expect(made.page).toMatchObject({ scope: { write: ['frontend/**'], read: [] }, role: 'frontend' });
    expect(made.api).toMatchObject({ scope: { write: ['backend/**'], read: [] } });
    expect(state.q.goal(PROJECT, goal.goal_id).status).toBe('ACTIVE');
  });

  it('refuses a proposal with a task nothing of which lies inside its ceiling, naming it', () => {
    state.planBounds = () => frontendOnly;
    const g = state.createGoal(PROJECT, human, { request: 'A page', plan: false });
    let error: unknown;
    try {
      state.proposePlan(PROJECT, human, g.goal_id, {
        summary: 'the plan',
        rationale: '',
        needs_human: null,
        trigger: 'test',
        tasks: [planTask('page', 'frontend', ['backend/**'])],
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FridayError);
    expect((error as FridayError).errorName).toBe('invalid_request');
    expect((error as FridayError).message).toContain('the plan exceeds its ceiling: task "page" (role frontend)');
    expect((error as FridayError).message).toContain('frontend/**, from policies/teams.yaml');
    expect(state.q.planVersions(state.q.planIdOfGoal(g.goal_id) ?? '')).toEqual([]);
  });

  it('holds an approval to the policy of that moment: a tightened scope cuts, an emptied one refuses', () => {
    // Proposed with no team scopes: recorded as written.
    const { version } = propose([planTask('page', 'frontend', ['frontend/**', 'shared/**'])]);
    expect(version.tasks[0]).toMatchObject({ scope: { write: ['frontend/**', 'shared/**'] }, note: null });
    // The project tightens before a human approves: the task holds what is inside now.
    state.planBounds = () => frontendOnly;
    const approved = state.approvePlan(PROJECT, human, version.plan_id, version.version);
    expect(approved.created[0]).toMatchObject({ scope: { write: ['frontend/**'] } });
    const materialized = state.store
      .readByRef(PROJECT, 'task', approved.created[0]?.task_id as string, { types: ['plan.task_materialized'] })
      .at(-1);
    const payload = materialized?.payload as { bounded?: { write: string[]; note: string } } | undefined;
    expect(payload).toMatchObject({ bounded: { write: ['frontend/**'] } });
    expect(payload?.bounded?.note).toContain('shared/**');

    // A second plan whose only task falls entirely outside a later scope cannot be approved.
    state.planBounds = null;
    const second = propose([planTask('docs', 'frontend', ['docs/**'])]);
    state.planBounds = () => frontendOnly;
    let error: unknown;
    try {
      state.approvePlan(PROJECT, human, second.version.plan_id, second.version.version);
    } catch (e) {
      error = e;
    }
    expect((error as FridayError).errorName).toBe('plan_outdated');
    expect((error as FridayError).message).toContain('exceeds its ceiling');
    expect((error as FridayError).message).toContain('friday plan reject');
    // Nothing changed: the version waits for the human's decision, and no task exists for it.
    expect(state.q.planVersion(second.version.plan_id, second.version.version)?.status).toBe('PROPOSED');
    expect(state.q.goalTasks(PROJECT, second.goal.goal_id)).toEqual([]);
  });
});
