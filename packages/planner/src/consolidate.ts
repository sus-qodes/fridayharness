import { globsOverlap } from '@friday/policy';
import { PLAN_LIMITS, type PlanDraft, type PlanTaskDraft } from './schemas.js';

/**
 * A small goal is one task (plan M13.1). Every task is another agent session, and every session
 * carries the host's whole fixed context in each of its calls, so splitting work that runs one
 * piece after another buys no parallel time and costs a session per piece (LESSONS D-89).
 *
 * `consolidatePlan` merges a first plan of two or three tasks of one kind none of which can run
 * beside another (every pair ordered by `depends_on`, or writing a common file) into one task.
 * It merges nothing when the merged task would not fit a task's limits, or when the roles differ
 * and the project declares a team scope for one of them or for `developer`, the merged task's role,
 * so the ceiling on delegated work (plan M12.2) never widens or refuses the plan. Pure: the same draft always gives the same plan.
 */

/** The most tasks a plan may have and still be merged: beyond this, work is no longer small. */
export const CONSOLIDATE_MAX_TASKS = 3;
const DESCRIPTION_MAX = 4000;
const SUMMARY_MAX = 200;
const RATIONALE_MAX = 2000;

const RISK = ['low', 'medium', 'high'] as const;
const PRIORITY = ['low', 'normal', 'high', 'urgent'] as const;

export interface Consolidation {
  draft: PlanDraft;
  /** The keys merged, in the order their work is done; null when the plan is kept as it is. */
  merged: string[] | null;
}

/** Keys of every task `key` depends on, directly or through others. */
function prerequisites(tasks: readonly PlanTaskDraft[], key: string, seen = new Set<string>()): Set<string> {
  const t = tasks.find((x) => x.key === key);
  for (const d of t?.depends_on ?? []) {
    if (seen.has(d)) continue;
    seen.add(d);
    prerequisites(tasks, d, seen);
  }
  return seen;
}

/** Dependencies first, the plan's own order otherwise. */
function workOrder(tasks: readonly PlanTaskDraft[]): PlanTaskDraft[] {
  const done = new Set<string>();
  const out: PlanTaskDraft[] = [];
  while (out.length < tasks.length) {
    const next = tasks.find(
      (t) => !done.has(t.key) && t.depends_on.every((d) => done.has(d) || !tasks.some((x) => x.key === d)),
    );
    if (!next) return [...tasks]; // a cycle: validation refuses the plan anyway
    done.add(next.key);
    out.push(next);
  }
  return out;
}

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const highest = <T extends string>(order: readonly T[], xs: readonly T[]): T =>
  order[Math.max(...xs.map((x) => order.indexOf(x)))] as T;

/**
 * The plan with its serial pieces as one task, or the plan unchanged. `teamRoles` are the roles
 * the project declares a team scope for (`teams` in its policy).
 */
export function consolidatePlan(draft: PlanDraft, opts: { teamRoles?: ReadonlySet<string> } = {}): Consolidation {
  const keep: Consolidation = { draft, merged: null };
  const tasks = draft.tasks;
  if (tasks.length < 2 || tasks.length > CONSOLIDATE_MAX_TASKS) return keep;
  if (new Set(tasks.map((t) => t.kind)).size !== 1) return keep;
  // Any two tasks that could run at the same time keep the plan split: that is what agents are for.
  for (const [i, a] of tasks.entries()) {
    for (const b of tasks.slice(i + 1)) {
      const ordered = prerequisites(tasks, a.key).has(b.key) || prerequisites(tasks, b.key).has(a.key);
      const shared = a.scope.write.length > 0 && b.scope.write.length > 0 && globsOverlap(a.scope.write, b.scope.write);
      if (!ordered && !shared) return keep;
    }
  }
  const roles = unique(tasks.map((t) => t.role));
  // Different roles merge as `developer`: not when any of them, `developer` included, has a team scope.
  if (roles.length > 1 && [...roles, 'developer'].some((r) => opts.teamRoles?.has(r))) return keep;
  const order = workOrder(tasks);
  const first = order[0] as PlanTaskDraft;
  const description = order
    .map((t, i) => `${i + 1}. ${t.summary}${t.description ? `\n${t.description}` : ''}`)
    .join('\n\n');
  const criteria = unique(order.flatMap((t) => t.acceptance_criteria));
  const write = unique(order.flatMap((t) => t.scope.write));
  const read = unique(order.flatMap((t) => t.scope.read));
  if (
    description.length > DESCRIPTION_MAX ||
    criteria.length > PLAN_LIMITS.maxCriteria ||
    write.length > PLAN_LIMITS.maxGlobs ||
    read.length > PLAN_LIMITS.maxGlobs
  ) {
    return keep;
  }
  const joined = order.map((t) => t.summary).join('; ');
  const summary = joined.length <= SUMMARY_MAX ? joined : `${joined.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
  const keys = order.map((t) => t.key);
  const merged: PlanTaskDraft = {
    key: first.key,
    kind: first.kind,
    summary,
    description,
    acceptance_criteria: criteria,
    depends_on: [],
    scope: { write, read },
    role: roles.length === 1 ? (roles[0] as string) : 'developer',
    priority: highest(
      PRIORITY,
      order.map((t) => t.priority),
    ),
    risk_level: highest(
      RISK,
      order.map((t) => t.risk_level),
    ),
  };
  const note = `Friday kept this as one task: its ${keys.length} parts (${keys.join(', ')}) would run one after another, and one agent session does them for the fixed context of one.`;
  const rationale = [draft.rationale, note].filter(Boolean).join(' ');
  return {
    draft: {
      ...draft,
      rationale: rationale.length <= RATIONALE_MAX ? rationale : note,
      tasks: [merged],
    },
    merged: keys,
  };
}
