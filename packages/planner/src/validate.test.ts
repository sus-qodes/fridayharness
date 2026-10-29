/**
 * The ceiling on a plan's tasks in the planner's checks (plan M12.2): a task wider than the
 * project's scope for its role is noted as cut, a task nothing of which lies inside is an error
 * the planner repairs, and the conflict check judges the scope the task will hold.
 */
import { describe, expect, it } from 'vitest';
import { PlanDraft, ReplanDraft } from './schemas.js';
import { type ExistingTask, type PlanTaskBounder, validatePlanDraft, validateReplanDraft } from './validate.js';

const task = (key: string, role: string, write: string[], depends_on: string[] = []) => ({
  key,
  summary: `Do ${key}`,
  acceptance_criteria: [`${key} works`],
  depends_on,
  scope: { write },
  role,
});

const draft = (tasks: ReturnType<typeof task>[]) =>
  PlanDraft.parse({
    objective: 'Ship the subscription flow',
    summary: 'Backend first, then the page',
    tasks,
  });

/** A stand-in for `FridayState.boundPlanTask`: the frontend role is held to `frontend/**`. */
const bound: PlanTaskBounder = (t) => {
  if (t.role !== 'frontend') return { write: [...t.write], note: null, refused: null };
  const inside = t.write.filter((g) => g.startsWith('frontend/'));
  const wider = t.write.filter((g) => g === '**');
  const write = [...inside, ...(wider.length ? ['frontend/**'] : [])];
  if (t.write.length && !write.length) {
    return { write: [...t.write], note: null, refused: `task "${t.key}" writes nothing under frontend/**` };
  }
  const changed = write.length !== t.write.length || wider.length > 0;
  return {
    write,
    note: changed ? `scope.write cut to frontend/** (the plan asked for ${t.write.join(', ')})` : null,
    refused: null,
  };
};

describe('the ceiling in plan checks (plan M12.2)', () => {
  it('passes a plan whose tasks lie inside their roles, with no notes', () => {
    const r = validatePlanDraft(
      draft([task('page', 'frontend', ['frontend/src/**']), task('api', 'backend', ['backend/**'])]),
      bound,
    );
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it('notes a task cut to its ceiling and judges parallel conflicts on the scope it will hold', () => {
    // "page" asks for everything; held to frontend/** it no longer collides with the backend task.
    const r = validatePlanDraft(
      draft([task('page', 'frontend', ['**']), task('api', 'backend', ['backend/**'])]),
      bound,
    );
    expect(r.ok, r.errors.join('; ')).toBe(true);
    expect(r.notes).toEqual(['task "page": scope.write cut to frontend/** (the plan asked for **)']);
    // Without the ceiling the same plan is a parallel write conflict.
    const loose = validatePlanDraft(draft([task('page', 'frontend', ['**']), task('api', 'backend', ['backend/**'])]));
    expect(loose.ok).toBe(false);
    expect(loose.errors[0]).toMatch(/can run at the same time/);
  });

  it('refuses a task nothing of which lies inside its ceiling, naming the task', () => {
    const r = validatePlanDraft(draft([task('page', 'frontend', ['backend/**'])]), bound);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['task "page" exceeds its ceiling: task "page" writes nothing under frontend/**']);
    expect(r.notes).toBeUndefined();
  });

  it('holds the new tasks of a revision to the ceiling too', () => {
    const existing: ExistingTask[] = [
      {
        task_id: 'task_a',
        key: 'api',
        kind: 'implementation',
        status: 'COMPLETED',
        depends_on: [],
        write: ['backend/**'],
      },
    ];
    const revision = (write: string[]) =>
      ReplanDraft.parse({ summary: 'Add the page', new_tasks: [task('page', 'frontend', write, ['task_a'])] });
    expect(validateReplanDraft(revision(['**']), existing, bound)).toMatchObject({
      ok: true,
      notes: ['new task "page": scope.write cut to frontend/** (the plan asked for **)'],
    });
    const refused = validateReplanDraft(revision(['docs/**']), existing, bound);
    expect(refused.ok).toBe(false);
    expect(refused.errors[0]).toMatch(/new task "page" exceeds its ceiling/);
  });
});
