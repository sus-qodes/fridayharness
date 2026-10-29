import { describe, expect, it } from 'vitest';
import { consolidatePlan } from './consolidate.js';
import { PlanDraft, type PlanDraftInput } from './schemas.js';

const task = (key: string, extra: Partial<PlanDraftInput['tasks'][number]> = {}) => ({
  key,
  summary: `the ${key} part`,
  description: `Do ${key}.`,
  acceptance_criteria: ['node --test passes', `${key} works`],
  scope: { write: [`${key}/**`], read: [] },
  ...extra,
});
const plan = (tasks: PlanDraftInput['tasks'], extra: Partial<PlanDraftInput> = {}) =>
  PlanDraft.parse({ objective: 'a small goal', summary: 'the plan', rationale: 'why', tasks, ...extra });

describe('a small goal is one task (plan M13.1)', () => {
  it('merges two tasks that run one after another, in the order their work is done', () => {
    const d = plan([
      task('backend', { depends_on: ['contract'], role: 'backend', risk_level: 'medium' }),
      task('contract', {
        role: 'frontend',
        scope: { write: ['shared/api.ts'], read: ['shared/**'] },
        priority: 'high',
      }),
    ]);
    const c = consolidatePlan(d);
    expect(c.merged).toEqual(['contract', 'backend']);
    expect(c.draft.tasks).toHaveLength(1);
    const [t] = c.draft.tasks;
    expect(t).toMatchObject({
      key: 'contract',
      summary: 'the contract part; the backend part',
      description: '1. the contract part\nDo contract.\n\n2. the backend part\nDo backend.',
      acceptance_criteria: ['node --test passes', 'contract works', 'backend works'],
      depends_on: [],
      scope: { write: ['shared/api.ts', 'backend/**'], read: ['shared/**'] },
      // Two roles and no team scope for either: any developer does it.
      role: 'developer',
      priority: 'high',
      risk_level: 'medium',
    });
    expect(c.draft.rationale).toMatch(/^why Friday kept this as one task: its 2 parts \(contract, backend\)/);
    // What a human reads is still a valid plan.
    expect(PlanDraft.safeParse(c.draft).success).toBe(true);
  });

  it('merges tasks that write a common file, since Friday runs them one after another anyway', () => {
    const d = plan([
      task('a', { scope: { write: ['shared/src/api.ts', 'frontend/**'], read: [] } }),
      task('b', { scope: { write: ['shared/src/api.ts', 'backend/**'], read: [] } }),
    ]);
    expect(consolidatePlan(d).merged).toEqual(['a', 'b']);
  });

  it('keeps tasks that can run at the same time apart: that is what several agents are for', () => {
    const d = plan([task('frontend'), task('backend')]);
    expect(consolidatePlan(d)).toEqual({ draft: d, merged: null });
    // One pair that can run side by side is enough to keep a three-task plan split.
    const three = plan([task('a'), task('b', { depends_on: ['a'] }), task('c')]);
    expect(consolidatePlan(three).merged).toBeNull();
  });

  it('merges a chain of three, and no more than three', () => {
    const chain = plan([task('c', { depends_on: ['b'] }), task('a'), task('b', { depends_on: ['a'] })]);
    expect(consolidatePlan(chain).merged).toEqual(['a', 'b', 'c']);
    const four = plan([
      task('a'),
      task('b', { depends_on: ['a'] }),
      task('c', { depends_on: ['b'] }),
      task('d', { depends_on: ['c'] }),
    ]);
    expect(consolidatePlan(four).merged).toBeNull();
  });

  it('never widens the ceiling: roles with a team scope stay apart; one role stays that role', () => {
    const d = plan([task('ui', { role: 'frontend' }), task('api', { role: 'backend', depends_on: ['ui'] })]);
    expect(consolidatePlan(d, { teamRoles: new Set(['backend']) }).merged).toBeNull();
    const same = plan([task('a', { role: 'backend' }), task('b', { role: 'backend', depends_on: ['a'] })]);
    const c = consolidatePlan(same, { teamRoles: new Set(['backend']) });
    expect(c.merged).toEqual(['a', 'b']);
    expect(c.draft.tasks[0]?.role).toBe('backend');
  });

  it('keeps tasks of different kinds, and a merge that would not fit a task, apart', () => {
    const kinds = plan([task('code'), task('docs', { kind: 'docs', depends_on: ['code'] })]);
    expect(consolidatePlan(kinds).merged).toBeNull();
    const long = plan([
      task('a', { description: 'x'.repeat(2500) }),
      task('b', { description: 'y'.repeat(2500), depends_on: ['a'] }),
    ]);
    expect(consolidatePlan(long).merged).toBeNull();
    const many = plan([
      task('a', { acceptance_criteria: Array.from({ length: 7 }, (_, i) => `a${i}`) }),
      task('b', { acceptance_criteria: Array.from({ length: 7 }, (_, i) => `b${i}`), depends_on: ['a'] }),
    ]);
    expect(consolidatePlan(many).merged).toBeNull();
  });

  it('leaves a plan of one task, or of none, as it is', () => {
    const one = plan([task('a')]);
    expect(consolidatePlan(one)).toEqual({ draft: one, merged: null });
    const none = plan([], { needs_human: { question: 'Which provider?', why: 'only a human knows' } });
    expect(consolidatePlan(none).merged).toBeNull();
  });
});

describe('the merged role and the ceiling (review of M13)', () => {
  it('does not merge different roles into a developer task when developer has a team scope', () => {
    const d = plan([task('web', { role: 'frontend' }), task('api', { role: 'backend', depends_on: ['web'] })]);
    expect(consolidatePlan(d, { teamRoles: new Set(['developer']) }).merged).toBeNull();
    expect(consolidatePlan(d, { teamRoles: new Set(['qa']) }).merged).toEqual(['web', 'api']);
  });
});
