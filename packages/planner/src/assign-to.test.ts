/**
 * The agent a plan task is for (`assign_to`, 2026-11-16) is a person's choice: a person's plan
 * carries it into the proposal, a planner model is never offered it, and what a model writes has
 * it cleared before anything is proposed.
 */
import { describe, expect, it } from 'vitest';
import { parsePlanDraft } from './parse.js';
import { proposalFromDraft } from './proposals.js';
import { draftJsonSchema, PlanDraft, ReplanDraft, withoutAssignments } from './schemas.js';

const task = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  summary: `Do ${key}`,
  acceptance_criteria: [`${key} works`],
  scope: { write: [`${key}/**`] },
  ...extra,
});

const plan = (tasks: ReturnType<typeof task>[]) => ({
  objective: 'Ship the discount codes',
  summary: 'The API, then its docs',
  tasks,
});

describe('assign_to', () => {
  it('is carried from a person’s plan into the proposal, and absent means Friday decides', () => {
    const parsed = parsePlanDraft(plan([task('api'), task('docs', { assign_to: 'dev-1' })]));
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    expect(parsed.value.tasks.map((t) => t.assign_to)).toEqual([null, 'dev-1']);
    const proposal = proposalFromDraft(parsed.value, { trigger: 'test' });
    expect(proposal.tasks.map((t) => [t.key, t.assign_to])).toEqual([
      ['api', null],
      ['docs', 'dev-1'],
    ]);
  });

  it('takes only an agent key', () => {
    for (const bad of ['Dev 1', '-dev', 'x'.repeat(65), '../dev-1']) {
      const r = PlanDraft.safeParse(plan([task('docs', { assign_to: bad })]));
      expect(r.success, bad).toBe(false);
    }
    expect(PlanDraft.safeParse(plan([task('docs', { assign_to: 'claude-2' })])).success).toBe(true);
  });

  it('is not offered to a planner model, in a first plan or a revision', () => {
    for (const kind of ['plan', 'replan'] as const) {
      const text = JSON.stringify(draftJsonSchema(kind));
      expect(text, kind).not.toContain('assign_to');
      // The rest of a task is still there.
      expect(text, kind).toContain('acceptance_criteria');
      expect(text, kind).toContain('risk_level');
    }
  });

  it('is cleared from what a model writes, in a first plan and in a revision’s new tasks', () => {
    const first = PlanDraft.parse(plan([task('api', { assign_to: 'dev-1' })]));
    expect(withoutAssignments(first).tasks.map((t) => t.assign_to)).toEqual([null]);
    const revision = ReplanDraft.parse({
      summary: 'Add the docs',
      new_tasks: [task('docs', { assign_to: 'dev-1' })],
    });
    const cleared = withoutAssignments(revision);
    expect(cleared.new_tasks.map((t) => t.assign_to)).toEqual([null]);
    // Nothing else changes.
    expect({ ...cleared.new_tasks[0], assign_to: 'dev-1' }).toEqual(revision.new_tasks[0]);
  });
});
