import { globsOverlap } from '@friday/policy';
import type { PlanDraft, PlanTaskDraft, ReplanDraft } from './schemas.js';

/**
 * Semantic checks a schema cannot express. Errors are written for the planner: a model gets them
 * back in its one repair attempt, a human sees them from `friday plan propose`.
 */

export interface ExistingTask {
  task_id: string;
  key: string | null;
  kind: string;
  status: string;
  depends_on: string[];
  write: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /**
   * What a valid plan will be held to that its author did not write (plan M12.2): a task whose
   * write scope was cut to the ceiling of its role. A human reads these with the plan. Present
   * only when there is one.
   */
  notes?: string[];
}

/**
 * The ceiling on delegated work (plan M12.2): what a plan task of a role may hold under the
 * project's policy. `FridayState.boundPlanTask` is one; the caller hands it in, so these checks
 * stay pure. `refused` names a task nothing of which lies inside its ceiling; `note` says how a
 * task was cut.
 */
export type PlanTaskBounder = (task: { key: string; kind: string; role: string; write: readonly string[] }) => {
  write: string[];
  note: string | null;
  refused: string | null;
};

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'ABANDONED']);
const NOT_STARTED = new Set(['PROPOSED', 'READY']);
const READ_ONLY_KINDS = new Set(['review', 'research']);

/** Review and research tasks may declare no write scope; they are read-only. */
export function isReadOnly(t: { kind: string; write: readonly string[] }): boolean {
  return READ_ONLY_KINDS.has(t.kind) && t.write.length === 0;
}

interface Node {
  id: string;
  label: string;
  deps: string[];
  write: string[];
  kind: string;
  /** Finished nodes cannot conflict with anything any more. */
  done: boolean;
}

/** Ids reachable from `id` through dependencies (its transitive prerequisites). */
function ancestors(nodes: Map<string, Node>, id: string, seen = new Set<string>()): Set<string> {
  for (const d of nodes.get(id)?.deps ?? []) {
    if (seen.has(d)) continue;
    seen.add(d);
    ancestors(nodes, d, seen);
  }
  return seen;
}

/** A cycle as a readable path, or null. */
function findCycle(nodes: Map<string, Node>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of nodes.get(id)?.deps ?? []) {
      if (!nodes.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const id of [...nodes.keys()].sort()) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

/**
 * Tasks that may run at the same time must not share write scope (single live writer, plan B26).
 * With `involving`, only pairs that include one of those ids are reported.
 */
function parallelConflicts(nodes: Map<string, Node>, involving?: Set<string>): string[] {
  const errors: string[] = [];
  const live = [...nodes.values()].filter((n) => !n.done && !isReadOnly(n));
  const before = new Map(live.map((n) => [n.id, ancestors(nodes, n.id)]));
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i] as Node;
      const b = live[j] as Node;
      if (involving && !involving.has(a.id) && !involving.has(b.id)) continue;
      const ordered = before.get(a.id)?.has(b.id) || before.get(b.id)?.has(a.id);
      if (!ordered && globsOverlap(a.write, b.write)) {
        errors.push(
          `${a.label} and ${b.label} can run at the same time but both write ${a.write.join(', ') || '(anything)'} / ${b.write.join(', ') || '(anything)'}: add a dependency between them or give them disjoint write scopes`,
        );
      }
    }
  }
  return errors;
}

function taskErrors(t: PlanTaskDraft, label: string): string[] {
  const errors: string[] = [];
  if (t.scope.write.length === 0 && !READ_ONLY_KINDS.has(t.kind)) {
    errors.push(`${label} must declare scope.write (only review and research tasks may be read-only)`);
  }
  if (new Set(t.depends_on).size !== t.depends_on.length) errors.push(`${label} lists a dependency twice`);
  return errors;
}

/**
 * The ceiling of a task's role (plan M12.2): what the task will hold once it exists. A task
 * nothing of which lies inside is an error the planner can repair; a cut is a note. The write
 * scope the conflict check sees is the one the task will hold.
 */
function boundTask(
  t: PlanTaskDraft,
  label: string,
  bound: PlanTaskBounder | undefined,
  errors: string[],
  notes: string[],
): string[] {
  if (!bound) return t.scope.write;
  const b = bound({ key: t.key, kind: t.kind, role: t.role, write: t.scope.write });
  if (b.refused) {
    errors.push(`${label} exceeds its ceiling: ${b.refused}`);
    return t.scope.write;
  }
  if (b.note) notes.push(`${label}: ${b.note}`);
  return b.write;
}

function result(errors: string[], notes: string[] = []): ValidationResult {
  return { ok: errors.length === 0, errors, ...(notes.length ? { notes } : {}) };
}

/**
 * Checks a first plan: unique keys, known dependencies, no cycles, no parallel write conflicts,
 * and, with a bounder, the ceiling of every task's role (plan M12.2).
 */
export function validatePlanDraft(draft: PlanDraft, bound?: PlanTaskBounder): ValidationResult {
  const errors: string[] = [];
  const notes: string[] = [];
  if (draft.tasks.length === 0 && !draft.needs_human) {
    errors.push('a plan needs at least one task, or a needs_human question when the goal cannot be planned yet');
  }
  const keys = new Set<string>();
  for (const t of draft.tasks) {
    if (keys.has(t.key)) errors.push(`task key "${t.key}" is used twice`);
    keys.add(t.key);
  }
  const nodes = new Map<string, Node>();
  for (const t of draft.tasks) {
    const label = `task "${t.key}"`;
    errors.push(...taskErrors(t, label));
    for (const d of t.depends_on) {
      if (d === t.key) errors.push(`${label} depends on itself`);
      else if (!keys.has(d)) errors.push(`${label} depends on "${d}", which is not a task key in this plan`);
    }
    nodes.set(t.key, {
      id: t.key,
      label,
      deps: t.depends_on.filter((d) => keys.has(d) && d !== t.key),
      write: boundTask(t, label, bound, errors, notes),
      kind: t.kind,
      done: false,
    });
  }
  const cycle = findCycle(nodes);
  if (cycle) errors.push(`dependencies form a cycle: ${cycle.join(' -> ')}`);
  else errors.push(...parallelConflicts(nodes));
  return result(errors, notes);
}

/**
 * Checks a revision against the tasks of the active plan: rework only FAILED tasks, drop only
 * tasks that have not started, keep the dependency graph acyclic and conflict-free, and, with a
 * bounder, hold every new task to the ceiling of its role (plan M12.2).
 */
export function validateReplanDraft(
  draft: ReplanDraft,
  existing: ExistingTask[],
  bound?: PlanTaskBounder,
): ValidationResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const byId = new Map(existing.map((t) => [t.task_id, t]));
  const usedKeys = new Set(existing.map((t) => t.key).filter((k): k is string => Boolean(k)));
  const dropped = new Set(draft.drop.map((d) => d.task_id));
  const reworked = new Set(draft.rework.map((r) => r.task_id));

  if (draft.rework.length + draft.drop.length + draft.new_tasks.length === 0 && !draft.needs_human) {
    errors.push('the revision changes nothing: rework, drop or add a task, or ask a needs_human question');
  }
  for (const r of draft.rework) {
    const t = byId.get(r.task_id);
    if (!t) errors.push(`rework: ${r.task_id} is not a task of this plan`);
    else if (t.status !== 'FAILED')
      errors.push(`rework: ${r.task_id} is ${t.status}; only FAILED tasks can be reworked`);
    if (dropped.has(r.task_id)) errors.push(`${r.task_id} cannot be both reworked and dropped`);
  }
  for (const d of draft.drop) {
    const t = byId.get(d.task_id);
    if (!t) errors.push(`drop: ${d.task_id} is not a task of this plan`);
    else if (!NOT_STARTED.has(t.status))
      errors.push(`drop: ${d.task_id} is ${t.status}; only tasks that have not started can be dropped`);
  }
  if (reworked.size !== draft.rework.length) errors.push('rework lists a task twice');
  if (dropped.size !== draft.drop.length) errors.push('drop lists a task twice');

  const newKeys = new Set<string>();
  for (const t of draft.new_tasks) {
    if (newKeys.has(t.key) || usedKeys.has(t.key)) errors.push(`task key "${t.key}" is already used in this plan`);
    newKeys.add(t.key);
  }

  const nodes = new Map<string, Node>();
  for (const t of existing) {
    if (dropped.has(t.task_id) || TERMINAL.has(t.status)) continue;
    nodes.set(t.task_id, {
      id: t.task_id,
      label: `task ${t.task_id}${t.key ? ` ("${t.key}")` : ''}`,
      deps: t.depends_on.filter((d) => byId.has(d)),
      write: t.write,
      kind: t.kind,
      done: false,
    });
    for (const dep of t.depends_on) {
      if (dropped.has(dep)) errors.push(`drop: ${dep} is still needed by ${t.task_id}; drop or rework that task too`);
    }
  }
  for (const t of draft.new_tasks) {
    const label = `new task "${t.key}"`;
    errors.push(...taskErrors(t, label));
    const deps: string[] = [];
    for (const d of t.depends_on) {
      if (d === t.key) errors.push(`${label} depends on itself`);
      else if (newKeys.has(d)) deps.push(d);
      else if (byId.has(d)) {
        const dep = byId.get(d) as ExistingTask;
        if (dropped.has(d) || dep.status === 'CANCELLED' || dep.status === 'ABANDONED') {
          errors.push(`${label} depends on ${d}, which is ${dropped.has(d) ? 'being dropped' : dep.status}`);
        } else if (dep.status !== 'COMPLETED') deps.push(d);
      } else errors.push(`${label} depends on "${d}", which is neither a new task key nor a task of this plan`);
    }
    nodes.set(t.key, {
      id: t.key,
      label,
      deps,
      write: boundTask(t, label, bound, errors, notes),
      kind: t.kind,
      done: false,
    });
  }
  const cycle = findCycle(nodes);
  if (cycle) errors.push(`dependencies form a cycle: ${cycle.join(' -> ')}`);
  else errors.push(...parallelConflicts(nodes, new Set([...newKeys, ...reworked])));
  return result(errors, notes);
}
