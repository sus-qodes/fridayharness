import type { PlanVersionView, TaskView } from '@friday/protocol';
import type { PlanProposal, PlanTaskInput } from '@friday/state';
import type { PlanDraft, PlanTaskDraft, ReplanDraft } from './schemas.js';
import type { ExistingTask } from './validate.js';

/** Turns validated drafts into proposals for FridayState; shared by the model path and `friday plan propose`. */

export interface ProposalMeta {
  trigger: string;
  model_call_id?: string | null;
  prompt_version?: string | null;
}

export function taskInput(t: PlanTaskDraft): PlanTaskInput {
  return {
    key: t.key,
    change: 'new',
    task_id: null,
    kind: t.kind,
    summary: t.summary,
    description: t.description || null,
    acceptance_criteria: t.acceptance_criteria,
    depends_on: t.depends_on,
    scope: { write: t.scope.write, read: t.scope.read },
    role: t.role,
    priority: t.priority,
    risk_level: t.risk_level,
    note: null,
  };
}

/** A first plan (also carries the normalized intent, spec Part 03 §5). */
export function proposalFromDraft(draft: PlanDraft, meta: ProposalMeta): PlanProposal {
  return {
    summary: draft.summary,
    rationale: draft.rationale,
    needs_human: draft.needs_human,
    trigger: meta.trigger,
    tasks: draft.tasks.map(taskInput),
    model_call_id: meta.model_call_id ?? null,
    prompt_version: meta.prompt_version ?? null,
    intent: { objective: draft.objective, constraints: draft.constraints, outcomes: draft.outcomes },
  };
}

/** Tasks of the active version that are still part of the plan, with their live state. */
export function existingTasks(
  active: PlanVersionView,
  findTask: (taskId: string) => TaskView | undefined,
): ExistingTask[] {
  return active.tasks
    .filter((t) => t.change !== 'drop' && t.task_id)
    .map((t) => {
      const task = findTask(t.task_id as string);
      return {
        task_id: t.task_id as string,
        key: t.key,
        kind: t.kind,
        status: task?.status ?? 'CANCELLED',
        depends_on: task?.dependencies ?? [],
        write: task?.scope?.write ?? t.scope.write,
      };
    });
}

/** A revision: every remaining task is listed, kept unless the draft reworks or drops it. */
export function proposalFromReplan(
  active: PlanVersionView,
  draft: ReplanDraft,
  findTask: (taskId: string) => TaskView | undefined,
  meta: ProposalMeta,
): PlanProposal {
  const rework = new Map(draft.rework.map((r) => [r.task_id, r.note]));
  const drop = new Map(draft.drop.map((x) => [x.task_id, x.reason]));
  const tasks: PlanTaskInput[] = [
    ...active.tasks
      .filter((t) => t.change !== 'drop' && t.task_id)
      .map((t) => {
        const id = t.task_id as string;
        const { position: _position, ...rest } = t;
        return {
          ...rest,
          depends_on: findTask(id)?.dependencies ?? t.depends_on,
          change: rework.has(id) ? ('rework' as const) : drop.has(id) ? ('drop' as const) : ('keep' as const),
          note: rework.get(id) ?? drop.get(id) ?? null,
        };
      }),
    ...draft.new_tasks.map(taskInput),
  ];
  return {
    summary: draft.summary,
    rationale: draft.rationale,
    needs_human: draft.needs_human,
    trigger: meta.trigger,
    tasks,
    model_call_id: meta.model_call_id ?? null,
    prompt_version: meta.prompt_version ?? null,
  };
}
