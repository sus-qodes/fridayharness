/** One task as listed in a plan version (spec Part 03 §6). */
export interface PlanVersionTask {
  key: string;
  task_id: string | null;
  /** How this version treats the task: added now, carried over, sent back, or dropped. */
  change: 'new' | 'keep' | 'rework' | 'drop';
  kind: string;
  summary: string;
  depends_on: string[];
  write: string[];
  acceptance_criteria: string[];
  role: string;
  note: string | null;
}

export interface PlanDiff {
  added: PlanVersionTask[];
  dropped: PlanVersionTask[];
  reworked: PlanVersionTask[];
  changed: { task: PlanVersionTask; fields: string[] }[];
  unchanged: number;
}

const identity = (t: PlanVersionTask) => t.task_id ?? `key:${t.key}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A first version names dependencies by plan key, revisions by task id; compare them by key so
 * an unchanged task does not look changed.
 */
function byKeys(tasks: PlanVersionTask[], others: PlanVersionTask[]): (deps: string[]) => string[] {
  const keyOf = new Map([...tasks, ...others].filter((t) => t.task_id).map((t) => [t.task_id as string, t.key]));
  return (deps) => deps.map((d) => keyOf.get(d) ?? d).sort();
}

/** What changed from plan version `from` to version `to`, task by task. */
export function diffPlanVersions(from: PlanVersionTask[], to: PlanVersionTask[]): PlanDiff {
  const before = new Map(from.map((t) => [identity(t), t]));
  const depsFrom = byKeys(from, to);
  const depsTo = byKeys(to, from);
  const out: PlanDiff = { added: [], dropped: [], reworked: [], changed: [], unchanged: 0 };
  for (const t of to) {
    const old = before.get(identity(t)) ?? from.find((f) => f.key === t.key);
    if (!old) {
      out.added.push(t);
      continue;
    }
    if (t.change === 'drop' && old.change !== 'drop') {
      out.dropped.push(t);
      continue;
    }
    if (t.change === 'rework') {
      out.reworked.push(t);
      continue;
    }
    const fields = (['summary', 'kind', 'depends_on', 'write', 'acceptance_criteria', 'role'] as const).filter((f) =>
      f === 'depends_on' ? !same(depsFrom(old.depends_on), depsTo(t.depends_on)) : !same(old[f], t[f]),
    );
    if (fields.length) out.changed.push({ task: t, fields });
    else out.unchanged += 1;
  }
  return out;
}
