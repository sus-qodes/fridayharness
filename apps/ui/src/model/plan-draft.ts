/**
 * Plans written in the interface (plan §7.7): the draft shapes the daemon accepts at
 * `POST goals/:gid/plans`, the checks the page runs before sending one, and JSON import/export.
 * Field names and limits follow `packages/planner/src/schemas.ts` and `validate.ts`; the server's
 * `details.errors` stay the final word, these checks only catch the common mistakes early.
 * Pure: no DOM, no daemon.
 */
import type { LivePlanVersion, SnapshotTask } from '@friday/protocol';

export const TASK_KINDS = ['implementation', 'verification', 'review', 'research', 'docs', 'chore'] as const;
export type DraftKind = (typeof TASK_KINDS)[number];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type DraftPriority = (typeof PRIORITIES)[number];
export const RISKS = ['low', 'medium', 'high'] as const;
export type DraftRisk = (typeof RISKS)[number];

/** The planner's limits (`PLAN_LIMITS` in the planner package). */
export const PLAN_LIMITS = { maxTasks: 12, maxCriteria: 12, maxGlobs: 20 } as const;

/** Kinds that may declare no write scope: they only read. */
export const READ_ONLY_KINDS: readonly string[] = ['review', 'research'];
/** Revision rules: only these can be dropped, only FAILED can be reworked. */
export const NOT_STARTED: readonly string[] = ['PROPOSED', 'READY'];
const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'ABANDONED']);

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Import refuses larger files (a plan is a few kilobytes). */
export const MAX_IMPORT_BYTES = 1_000_000;

export interface DraftTask {
  key: string;
  summary: string;
  kind: DraftKind;
  role: string;
  description?: string;
  acceptance_criteria: string[];
  /** Keys of earlier tasks of this draft; in a revision also ids of existing tasks. */
  depends_on: string[];
  scope: { write: string[]; read: string[] };
  priority: DraftPriority;
  risk_level: DraftRisk;
}

/** A first plan for a goal (`PlanDraft`). */
export interface FirstPlanDraft {
  objective?: string;
  summary: string;
  tasks: DraftTask[];
}

export interface ReworkEntry {
  task_id: string;
  note: string;
}

export interface DropEntry {
  task_id: string;
  reason: string;
}

/** A revision of the goal's ACTIVE plan (`ReplanDraft`); tasks it does not mention are kept. */
export interface RevisionDraft {
  summary: string;
  rework: ReworkEntry[];
  drop: DropEntry[];
  new_tasks: DraftTask[];
}

/** A task of the active plan, as the revision checks see it (the server's `existingTasks`). */
export interface ExistingTask {
  task_id: string;
  key: string | null;
  summary: string;
  kind: string;
  status: string;
  /** Task ids it depends on. */
  depends_on: string[];
  write: string[];
}

export interface DraftIssue {
  /**
   * Where it is: `objective`, `summary`, `plan`, `tasks`, `tasks.<i>.<field>` (`key`, `summary`,
   * `kind`, `role`, `description`, `acceptance_criteria`, `depends_on`, `scope.write`,
   * `scope.read`, `priority`, `risk_level`), `rework.<task_id>`, `drop.<task_id>`; a revision's
   * new tasks use `new_tasks.<i>.<field>`.
   */
  path: string;
  message: string;
  /** Other fields the same problem involves (both sides of a write overlap). */
  related?: string[];
}

// ---- building ------------------------------------------------------------------------------------

export function newTask(key: string): DraftTask {
  return {
    key,
    summary: '',
    kind: 'implementation',
    role: 'developer',
    description: '',
    acceptance_criteria: [''],
    depends_on: [],
    scope: { write: [], read: [] },
    priority: 'normal',
    risk_level: 'low',
  };
}

/** `task-1`, `task-2`, … the first not in `taken`. */
export function nextKey(taken: Iterable<string>, base = 'task'): string {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) {
    const key = `${base}-${n}`;
    if (!used.has(key)) return key;
  }
}

/** The tasks of an active plan as the revision rules see them (mirrors the server's `existingTasks`). */
export function existingFromPlan(active: LivePlanVersion, tasks: readonly SnapshotTask[] = []): ExistingTask[] {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const idByKey = new Map<string, string>();
  for (const t of active.tasks) if (t.task_id) idByKey.set(t.key, t.task_id);
  return active.tasks
    .filter((t) => t.change !== 'drop' && t.task_id)
    .map((t) => {
      const id = t.task_id as string;
      const live = byId.get(id);
      return {
        task_id: id,
        key: t.key,
        summary: live?.summary ?? t.summary,
        kind: t.kind,
        status: t.status ?? live?.status ?? 'CANCELLED',
        depends_on: live?.dependencies ?? t.depends_on.map((d) => idByKey.get(d) ?? d),
        write: live?.scope?.write ?? t.scope.write,
      };
    });
}

export function canRework(t: Pick<ExistingTask, 'status'>): boolean {
  return t.status === 'FAILED';
}

export function canDrop(t: Pick<ExistingTask, 'status'>): boolean {
  return NOT_STARTED.includes(t.status);
}

// ---- normalising ---------------------------------------------------------------------------------

function cleanList(list: readonly string[]): string[] {
  return list.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** A task as it is sent: trimmed text, empty lines and globs removed, an empty description left out. */
export function normalizeTask(t: DraftTask): DraftTask {
  const description = (t.description ?? '').trim();
  return {
    key: t.key.trim(),
    summary: t.summary.trim(),
    kind: t.kind,
    role: t.role.trim(),
    ...(description ? { description } : {}),
    acceptance_criteria: cleanList(t.acceptance_criteria),
    depends_on: cleanList(t.depends_on),
    scope: { write: cleanList(t.scope.write), read: cleanList(t.scope.read) },
    priority: t.priority,
    risk_level: t.risk_level,
  };
}

export function normalizeFirstPlan(d: FirstPlanDraft): FirstPlanDraft {
  const objective = (d.objective ?? '').trim();
  return {
    ...(objective ? { objective } : {}),
    summary: d.summary.trim(),
    tasks: d.tasks.map(normalizeTask),
  };
}

export function normalizeRevision(d: RevisionDraft): RevisionDraft {
  return {
    summary: d.summary.trim(),
    rework: d.rework.map((r) => ({ task_id: r.task_id, note: r.note.trim() })),
    drop: d.drop.map((r) => ({ task_id: r.task_id, reason: r.reason.trim() })),
    new_tasks: d.new_tasks.map(normalizeTask),
  };
}

// ---- globs ---------------------------------------------------------------------------------------

/** The fixed part of a glob before its first wildcard, lower-cased: `backend/src/**` → `backend/src/`. */
export function globStem(glob: string): string {
  return (glob.replaceAll('\\', '/').split(/[*?[{]/)[0] ?? '').toLowerCase();
}

/** Two write scopes overlap when one glob's fixed prefix starts with another's (a prefix comparison). */
export function globsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      const sx = globStem(x);
      const sy = globStem(y);
      if (sx.startsWith(sy) || sy.startsWith(sx)) return true;
    }
  }
  return false;
}

/** Why a glob is not a project-relative POSIX glob, or null. */
export function scopeGlobProblem(glob: string): string | null {
  if (glob.length === 0) return 'a glob cannot be empty';
  if (glob.length > 200) return 'a glob has at most 200 characters';
  if (glob.startsWith('/') || /^[A-Za-z]:/.test(glob) || glob.includes('\\') || glob.split('/').includes('..')) {
    return `"${glob}": use a project-relative glob with forward slashes and no ".." (for example "backend/**")`;
  }
  return null;
}

// ---- graph helpers -------------------------------------------------------------------------------

interface Node {
  id: string;
  label: string;
  path: string;
  deps: string[];
  write: string[];
  kind: string;
}

function ancestors(nodes: Map<string, Node>, id: string, seen = new Set<string>()): Set<string> {
  for (const d of nodes.get(id)?.deps ?? []) {
    if (seen.has(d)) continue;
    seen.add(d);
    ancestors(nodes, d, seen);
  }
  return seen;
}

/** A dependency cycle as a path (`a -> b -> a`), or null. Unknown ids are ignored. */
export function findCycle(deps: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const id of [...deps.keys()].sort()) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

function isReadOnly(n: { kind: string; write: readonly string[] }): boolean {
  return READ_ONLY_KINDS.includes(n.kind) && n.write.length === 0;
}

/** Write overlaps between tasks no dependency orders; with `involving`, only pairs touching those ids. */
function overlaps(nodes: Map<string, Node>, involving?: ReadonlySet<string>): DraftIssue[] {
  const issues: DraftIssue[] = [];
  // An empty write scope is reported as missing already; it is left out here.
  const live = [...nodes.values()].filter((n) => !isReadOnly(n) && n.write.length > 0);
  const before = new Map(live.map((n) => [n.id, ancestors(nodes, n.id)]));
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i] as Node;
      const b = live[j] as Node;
      if (involving && !involving.has(a.id) && !involving.has(b.id)) continue;
      const ordered = before.get(a.id)?.has(b.id) || before.get(b.id)?.has(a.id);
      if (ordered || !globsOverlap(a.write, b.write)) continue;
      const main = involving && !involving.has(b.id) ? a : b;
      const other = main === a ? b : a;
      issues.push({
        path: main.path,
        message: `${a.label} and ${b.label} can run at the same time but both write ${a.write.join(', ')} / ${b.write.join(', ')}: add a dependency between them or give them disjoint write scopes`,
        ...(other.path ? { related: [other.path] } : {}),
      });
    }
  }
  return issues;
}

// ---- per-task checks -----------------------------------------------------------------------------

function lengthIssue(value: string, min: number, max: number, what: string): string | null {
  const n = Array.from(value).length;
  if (n < min) return min <= 1 ? `${what} is required` : `${what} needs at least ${min} characters`;
  if (n > max) return `${what} has at most ${max} characters`;
  return null;
}

function taskIssues(t: DraftTask, prefix: string, label: string): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const add = (field: string, message: string | null) => {
    if (message) issues.push({ path: `${prefix}.${field}`, message });
  };
  add(
    'key',
    KEY_RE.test(t.key) ? null : 'use 1-48 lowercase letters, digits and dashes, starting with a letter or digit',
  );
  add('summary', lengthIssue(t.summary, 3, 200, 'the summary'));
  if (!(TASK_KINDS as readonly string[]).includes(t.kind)) add('kind', `"${t.kind}" is not a task kind`);
  add(
    'role',
    ROLE_RE.test(t.role) ? null : 'roles are lowercase words such as "backend", "frontend", "qa" or "developer"',
  );
  if (t.description && Array.from(t.description).length > 4000) add('description', 'at most 4000 characters');
  const criteria = t.acceptance_criteria;
  if (criteria.length === 0) add('acceptance_criteria', 'add at least one acceptance criterion');
  else if (criteria.length > PLAN_LIMITS.maxCriteria)
    add('acceptance_criteria', `at most ${PLAN_LIMITS.maxCriteria} criteria`);
  else if (criteria.some((c) => Array.from(c).length > 300))
    add('acceptance_criteria', 'each criterion has at most 300 characters');
  if (new Set(t.depends_on).size !== t.depends_on.length) add('depends_on', `${label} lists a dependency twice`);
  if (t.depends_on.length > PLAN_LIMITS.maxTasks) add('depends_on', `at most ${PLAN_LIMITS.maxTasks} dependencies`);
  for (const side of ['write', 'read'] as const) {
    const globs = t.scope[side];
    if (globs.length > PLAN_LIMITS.maxGlobs) add(`scope.${side}`, `at most ${PLAN_LIMITS.maxGlobs} globs`);
    const bad = globs.map(scopeGlobProblem).find((p) => p !== null);
    if (bad) add(`scope.${side}`, bad);
  }
  if (t.scope.write.length === 0 && !READ_ONLY_KINDS.includes(t.kind)) {
    add('scope.write', `${label} must declare a write scope (only review and research tasks may be read-only)`);
  }
  if (!(PRIORITIES as readonly string[]).includes(t.priority)) add('priority', `"${t.priority}" is not a priority`);
  if (!(RISKS as readonly string[]).includes(t.risk_level)) add('risk_level', `"${t.risk_level}" is not a risk level`);
  return issues;
}

// ---- first plan ----------------------------------------------------------------------------------

/**
 * Checks a first plan (after `normalizeFirstPlan`): the schema's lengths and patterns, unique keys,
 * known dependencies, no cycles, a write scope for every kind except review and research, and no
 * overlapping write globs between tasks that can run at the same time.
 */
export function validateFirstPlan(draft: FirstPlanDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const objective = draft.objective ?? '';
  const o = lengthIssue(objective, 5, 500, 'the objective');
  if (o) issues.push({ path: 'objective', message: o });
  const s = lengthIssue(draft.summary, 5, 1000, 'the summary');
  if (s) issues.push({ path: 'summary', message: s });
  if (draft.tasks.length === 0) issues.push({ path: 'tasks', message: 'a plan needs at least one task' });
  if (draft.tasks.length > PLAN_LIMITS.maxTasks)
    issues.push({ path: 'tasks', message: `a plan has at most ${PLAN_LIMITS.maxTasks} tasks` });

  const keys = new Set<string>();
  draft.tasks.forEach((t, i) => {
    if (keys.has(t.key)) issues.push({ path: `tasks.${i}.key`, message: `task key "${t.key}" is used twice` });
    keys.add(t.key);
  });
  const nodes = new Map<string, Node>();
  draft.tasks.forEach((t, i) => {
    const label = `task "${t.key}"`;
    issues.push(...taskIssues(t, `tasks.${i}`, label));
    for (const d of t.depends_on) {
      if (d === t.key) issues.push({ path: `tasks.${i}.depends_on`, message: `${label} depends on itself` });
      else if (!keys.has(d))
        issues.push({
          path: `tasks.${i}.depends_on`,
          message: `${label} depends on "${d}", which is not a task key in this plan`,
        });
    }
    if (!nodes.has(t.key)) {
      nodes.set(t.key, {
        id: t.key,
        label,
        path: `tasks.${i}.scope.write`,
        deps: t.depends_on.filter((d) => keys.has(d) && d !== t.key),
        write: t.scope.write,
        kind: t.kind,
      });
    }
  });
  const cycle = findCycle(new Map([...nodes.values()].map((n) => [n.id, n.deps])));
  if (cycle) issues.push({ path: 'tasks', message: `dependencies form a cycle: ${cycle.join(' -> ')}` });
  else issues.push(...overlaps(nodes));
  return issues;
}

// ---- revision ------------------------------------------------------------------------------------

/**
 * Checks a revision against the active plan's tasks (after `normalizeRevision`): rework only FAILED
 * tasks, drop only tasks that have not started (PROPOSED, READY), new keys unused, dependencies
 * known, no cycles and no write overlap involving a new or reworked task.
 */
export function validateRevision(draft: RevisionDraft, existing: readonly ExistingTask[]): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const byId = new Map(existing.map((t) => [t.task_id, t]));
  const usedKeys = new Set(existing.map((t) => t.key).filter((k): k is string => Boolean(k)));
  const dropped = new Set(draft.drop.map((d) => d.task_id));
  const reworked = new Set(draft.rework.map((r) => r.task_id));

  const s = lengthIssue(draft.summary, 5, 1000, 'the summary');
  if (s) issues.push({ path: 'summary', message: s });
  if (draft.rework.length + draft.drop.length + draft.new_tasks.length === 0) {
    issues.push({ path: 'plan', message: 'the revision changes nothing: rework, drop or add a task' });
  }
  for (const [name, n] of [
    ['rework', draft.rework.length],
    ['drop', draft.drop.length],
    ['new_tasks', draft.new_tasks.length],
  ] as const) {
    if (n > PLAN_LIMITS.maxTasks)
      issues.push({ path: 'plan', message: `${name} lists at most ${PLAN_LIMITS.maxTasks} tasks` });
  }

  for (const r of draft.rework) {
    const path = `rework.${r.task_id}`;
    const t = byId.get(r.task_id);
    if (!t) issues.push({ path, message: `rework: ${r.task_id} is not a task of this plan` });
    else if (!canRework(t))
      issues.push({ path, message: `rework: ${r.task_id} is ${t.status}; only FAILED tasks can be reworked` });
    if (dropped.has(r.task_id)) issues.push({ path, message: `${r.task_id} cannot be both reworked and dropped` });
    const n = lengthIssue(r.note, 3, 1000, 'the note');
    if (n) issues.push({ path, message: n });
  }
  for (const d of draft.drop) {
    const path = `drop.${d.task_id}`;
    const t = byId.get(d.task_id);
    if (!t) issues.push({ path, message: `drop: ${d.task_id} is not a task of this plan` });
    else if (!canDrop(t))
      issues.push({
        path,
        message: `drop: ${d.task_id} is ${t.status}; only tasks that have not started can be dropped`,
      });
    const n = lengthIssue(d.reason, 3, 500, 'the reason');
    if (n) issues.push({ path, message: n });
  }
  if (reworked.size !== draft.rework.length) issues.push({ path: 'plan', message: 'rework lists a task twice' });
  if (dropped.size !== draft.drop.length) issues.push({ path: 'plan', message: 'drop lists a task twice' });

  const newKeys = new Set<string>();
  draft.new_tasks.forEach((t, i) => {
    if (newKeys.has(t.key) || usedKeys.has(t.key))
      issues.push({ path: `new_tasks.${i}.key`, message: `task key "${t.key}" is already used in this plan` });
    newKeys.add(t.key);
  });

  const nodes = new Map<string, Node>();
  for (const t of existing) {
    if (dropped.has(t.task_id) || TERMINAL.has(t.status)) continue;
    nodes.set(t.task_id, {
      id: t.task_id,
      label: `task ${t.task_id}${t.key ? ` ("${t.key}")` : ''}`,
      path: reworked.has(t.task_id) ? `rework.${t.task_id}` : '',
      deps: t.depends_on.filter((d) => byId.has(d)),
      write: t.write,
      kind: t.kind,
    });
    for (const dep of t.depends_on) {
      if (dropped.has(dep))
        issues.push({
          path: `drop.${dep}`,
          message: `drop: ${dep} is still needed by ${t.task_id}; drop or rework that task too`,
        });
    }
  }
  draft.new_tasks.forEach((t, i) => {
    const label = `new task "${t.key}"`;
    const prefix = `new_tasks.${i}`;
    issues.push(...taskIssues(t, prefix, label));
    const deps: string[] = [];
    for (const d of t.depends_on) {
      if (d === t.key) issues.push({ path: `${prefix}.depends_on`, message: `${label} depends on itself` });
      else if (newKeys.has(d)) deps.push(d);
      else if (byId.has(d)) {
        const dep = byId.get(d) as ExistingTask;
        if (dropped.has(d) || dep.status === 'CANCELLED' || dep.status === 'ABANDONED') {
          issues.push({
            path: `${prefix}.depends_on`,
            message: `${label} depends on ${d}, which is ${dropped.has(d) ? 'being dropped' : dep.status}`,
          });
        } else if (dep.status !== 'COMPLETED') deps.push(d);
      } else
        issues.push({
          path: `${prefix}.depends_on`,
          message: `${label} depends on "${d}", which is neither a new task key nor a task of this plan`,
        });
    }
    if (!nodes.has(t.key)) {
      nodes.set(t.key, { id: t.key, label, path: `${prefix}.scope.write`, deps, write: t.scope.write, kind: t.kind });
    }
  });
  const cycle = findCycle(new Map([...nodes.values()].map((n) => [n.id, n.deps])));
  if (cycle) issues.push({ path: 'plan', message: `dependencies form a cycle: ${cycle.join(' -> ')}` });
  else issues.push(...overlaps(nodes, new Set([...newKeys, ...reworked])));
  return issues;
}

/** What a revision changes, for the review before it is sent. */
export interface RevisionChanges {
  adds: { key: string; summary: string }[];
  drops: { task_id: string; label: string; reason: string }[];
  reworks: { task_id: string; label: string; note: string }[];
  /** Existing tasks the revision keeps as they are. */
  keeps: number;
}

export function revisionChanges(draft: RevisionDraft, existing: readonly ExistingTask[]): RevisionChanges {
  const byId = new Map(existing.map((t) => [t.task_id, t]));
  const label = (id: string) => {
    const t = byId.get(id);
    return t ? `${t.key ? `"${t.key}" ` : ''}${t.summary}` : id;
  };
  const touched = new Set([...draft.drop.map((d) => d.task_id), ...draft.rework.map((r) => r.task_id)]);
  return {
    adds: draft.new_tasks.map((t) => ({ key: t.key, summary: t.summary })),
    drops: draft.drop.map((d) => ({ task_id: d.task_id, label: label(d.task_id), reason: d.reason })),
    reworks: draft.rework.map((r) => ({ task_id: r.task_id, label: label(r.task_id), note: r.note })),
    keeps: existing.filter((t) => !touched.has(t.task_id)).length,
  };
}

/** One line per change, for a confirmation. */
export function changeLines(c: RevisionChanges): string[] {
  return [
    ...c.adds.map((a) => `Add "${a.key}": ${a.summary}`),
    ...c.reworks.map((r) => `Rework ${r.label}: ${r.note}`),
    ...c.drops.map((d) => `Drop ${d.label}: ${d.reason}`),
    `Keep ${c.keeps === 1 ? '1 task' : `${c.keeps} tasks`} as ${c.keeps === 1 ? 'it is' : 'they are'}`,
  ];
}

// ---- JSON ----------------------------------------------------------------------------------------

export function exportJson(draft: FirstPlanDraft | RevisionDraft): string {
  return JSON.stringify(draft, null, 2);
}

export type ImportResult<T> = { ok: true; draft: T; warnings: string[] } | { ok: false; error: string };

function parseObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, error: 'the file is too large for a plan (over 1 MB)' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, error: 'the JSON is not an object' };
  let obj = value as Record<string, unknown>;
  // The route's own body form, `{"draft": {...}}`, is accepted too.
  if (obj.draft && typeof obj.draft === 'object' && !Array.isArray(obj.draft))
    obj = obj.draft as Record<string, unknown>;
  return { ok: true, value: obj };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s) => s.length > 0) : []);

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T, what: string, warnings: string[]): T {
  if (v === undefined || v === null || v === '') return fallback;
  if ((allowed as readonly unknown[]).includes(v)) return v as T;
  warnings.push(`${what} "${str(v)}" is not known; "${fallback}" is used`);
  return fallback;
}

function taskFrom(v: unknown, i: number, warnings: string[]): DraftTask {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const scope = (o.scope && typeof o.scope === 'object' ? o.scope : {}) as Record<string, unknown>;
  const key = str(o.key) || `task-${i + 1}`;
  return {
    key,
    summary: str(o.summary),
    kind: pick(o.kind, TASK_KINDS, 'implementation', `task "${key}": kind`, warnings),
    role: str(o.role) || 'developer',
    description: str(o.description),
    acceptance_criteria: strList(o.acceptance_criteria),
    depends_on: strList(o.depends_on),
    scope: { write: strList(scope.write), read: strList(scope.read) },
    priority: pick(o.priority, PRIORITIES, 'normal', `task "${key}": priority`, warnings),
    risk_level: pick(o.risk_level, RISKS, 'low', `task "${key}": risk_level`, warnings),
  };
}

/** Reads a first plan from JSON (a file or pasted text); unknown fields are ignored. */
export function importFirstPlan(text: string): ImportResult<FirstPlanDraft> {
  const r = parseObject(text);
  if (!r.ok) return r;
  const o = r.value;
  const warnings: string[] = [];
  if (!Array.isArray(o.tasks)) {
    if ('new_tasks' in o || 'rework' in o) return { ok: false, error: 'this JSON is a revision, not a first plan' };
    warnings.push('the JSON has no "tasks" list');
  }
  const tasks = Array.isArray(o.tasks) ? o.tasks.map((t, i) => taskFrom(t, i, warnings)) : [];
  const objective = str(o.objective);
  return { ok: true, draft: { ...(objective ? { objective } : {}), summary: str(o.summary), tasks }, warnings };
}

/** Reads a revision from JSON. */
export function importRevision(text: string): ImportResult<RevisionDraft> {
  const r = parseObject(text);
  if (!r.ok) return r;
  const o = r.value;
  const warnings: string[] = [];
  if (Array.isArray(o.tasks) && !('new_tasks' in o))
    return { ok: false, error: 'this JSON is a first plan; a revision has "rework", "drop" and "new_tasks"' };
  const entries = (v: unknown, field: 'note' | 'reason') =>
    (Array.isArray(v) ? v : [])
      .map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>) : {}))
      .map((e) => ({ task_id: str(e.task_id), text: str(e[field]) }))
      .filter((e) => e.task_id.length > 0);
  return {
    ok: true,
    draft: {
      summary: str(o.summary),
      rework: entries(o.rework, 'note').map((e) => ({ task_id: e.task_id, note: e.text })),
      drop: entries(o.drop, 'reason').map((e) => ({ task_id: e.task_id, reason: e.text })),
      new_tasks: Array.isArray(o.new_tasks) ? o.new_tasks.map((t, i) => taskFrom(t, i, warnings)) : [],
    },
    warnings,
  };
}
