import { Priority, RiskLevel, TaskKind } from '@friday/protocol';
import { z } from 'zod';

/**
 * What a planner (a model or a human with `friday plan propose --file`) hands to Friday.
 * The same schemas validate both, so Friday works without any model at all (ADR-0013).
 */

export const PLAN_LIMITS = { maxTasks: 12, maxCriteria: 12, maxGlobs: 20 } as const;

/** A plan-local task name, unique within a plan: `backend-subscriptions`. */
export const PlanKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'use 1-48 lowercase letters, digits and dashes, starting with a letter or digit');

/** A project-relative POSIX glob: no leading slash, drive letter, backslash or `..` segment (plan B19). */
export const ScopeGlob = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (g) => !g.startsWith('/') && !/^[A-Za-z]:/.test(g) && !g.includes('\\') && !g.split('/').includes('..'),
    'use a project-relative glob with forward slashes and no ".." (for example "backend/**")',
  );

export const DraftScope = z.object({
  write: z.array(ScopeGlob).max(PLAN_LIMITS.maxGlobs).default([]),
  read: z.array(ScopeGlob).max(PLAN_LIMITS.maxGlobs).default([]),
});

export const AgentRole = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'roles are lowercase words such as "backend", "frontend", "qa" or "developer"');

/** An agent's key, as `friday task assign --agent` takes it: `dev-1`, `claude-2`. */
export const AgentKeyRef = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'an agent key is lowercase letters, digits and dashes, such as "dev-1"');

export const PlanTaskDraft = z.object({
  key: PlanKey,
  kind: TaskKind.default('implementation'),
  summary: z.string().min(3).max(200),
  description: z.string().max(4000).default(''),
  acceptance_criteria: z.array(z.string().min(1).max(300)).min(1).max(PLAN_LIMITS.maxCriteria),
  /** Keys of tasks in this plan, or (in a replan) ids of existing tasks. */
  depends_on: z.array(z.string().min(1).max(64)).max(PLAN_LIMITS.maxTasks).default([]),
  scope: DraftScope.prefault({}),
  role: AgentRole.default('developer'),
  priority: Priority.default('normal'),
  risk_level: RiskLevel.default('low'),
  /**
   * The agent this task is for: reserved for it when the plan is approved, so no other agent takes
   * it first (an agent its person drives, such as Antigravity, waits for them to type /friday).
   * A person's choice only: it is left out of the schema a planner model sees (`draftJsonSchema`)
   * and cleared from what a model writes (`withoutAssignments`). Null: Friday delegates by role.
   */
  assign_to: AgentKeyRef.nullable().default(null),
});
export type PlanTaskDraft = z.output<typeof PlanTaskDraft>;

/** A question only a human can answer (spec Part 03 §11: ambiguous intent, policy exceptions, …). */
export const NeedsHuman = z.object({
  question: z.string().min(5).max(1000),
  why: z.string().min(5).max(1000),
  options: z.array(z.string().min(1).max(200)).max(4).default([]),
});
export type NeedsHuman = z.output<typeof NeedsHuman>;

/** First plan for a goal; also normalizes the intent (spec Part 03 §5). */
export const PlanDraft = z.object({
  objective: z.string().min(5).max(500),
  constraints: z.array(z.string().min(1).max(300)).max(12).default([]),
  outcomes: z.array(z.string().min(1).max(300)).max(12).default([]),
  /** ADR-0034 §3: what the goal deliberately does not do, and what "done" means. */
  non_goals: z.array(z.string().min(1).max(300)).max(12).default([]),
  definition_of_done: z.array(z.string().min(1).max(300)).max(12).default([]),
  summary: z.string().min(5).max(1000),
  rationale: z.string().max(2000).default(''),
  needs_human: NeedsHuman.nullable().default(null),
  tasks: z.array(PlanTaskDraft).max(PLAN_LIMITS.maxTasks),
});
export type PlanDraft = z.output<typeof PlanDraft>;
export type PlanDraftInput = z.input<typeof PlanDraft>;

/**
 * A revision of the active plan. Existing tasks not mentioned are kept as they are; history is
 * never rewritten (spec Part 03 §6, §12).
 */
export const ReplanDraft = z.object({
  summary: z.string().min(5).max(1000),
  rationale: z.string().max(2000).default(''),
  needs_human: NeedsHuman.nullable().default(null),
  /** FAILED tasks to send back for rework, with what to do differently. */
  rework: z
    .array(z.object({ task_id: z.string().min(1).max(64), note: z.string().min(3).max(1000) }))
    .max(PLAN_LIMITS.maxTasks)
    .default([]),
  /** Tasks that have not started and are no longer needed. */
  drop: z
    .array(z.object({ task_id: z.string().min(1).max(64), reason: z.string().min(3).max(500) }))
    .max(PLAN_LIMITS.maxTasks)
    .default([]),
  /** New tasks; `depends_on` may name new keys or existing task ids. */
  new_tasks: z.array(PlanTaskDraft).max(PLAN_LIMITS.maxTasks).default([]),
});
export type ReplanDraft = z.output<typeof ReplanDraft>;
export type ReplanDraftInput = z.input<typeof ReplanDraft>;

/** A person's field a planner model is not offered: the agent a task is for. */
const PERSON_ONLY = 'assign_to';

/** `schema` without a person-only property, wherever an object schema lists it. */
function withoutPersonOnly(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutPersonOnly);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'properties' && v && typeof v === 'object') {
      const { [PERSON_ONLY]: _left, ...rest } = v as Record<string, unknown>;
      out[k] = withoutPersonOnly(rest);
    } else if (k === 'required' && Array.isArray(v)) {
      out[k] = v.filter((x) => x !== PERSON_ONLY);
    } else {
      out[k] = withoutPersonOnly(v);
    }
  }
  return out;
}

/**
 * JSON Schema for a draft, as sent to a model provider (inputs: defaults are optional). The agent
 * a task is for is a person's choice, so the model is not offered it.
 */
export function draftJsonSchema(kind: 'plan' | 'replan'): Record<string, unknown> {
  const schema = z.toJSONSchema(kind === 'plan' ? PlanDraft : ReplanDraft, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete schema.$schema;
  return withoutPersonOnly(schema) as Record<string, unknown>;
}

/** A model's draft with no task naming an agent: a planner model never reserves work for one. */
export function withoutAssignments<T extends { tasks?: PlanTaskDraft[]; new_tasks?: PlanTaskDraft[] }>(draft: T): T {
  const clear = (ts: PlanTaskDraft[] | undefined) => ts?.map((t) => ({ ...t, assign_to: null }));
  return {
    ...draft,
    ...(draft.tasks ? { tasks: clear(draft.tasks) } : {}),
    ...(draft.new_tasks ? { new_tasks: clear(draft.new_tasks) } : {}),
  };
}
