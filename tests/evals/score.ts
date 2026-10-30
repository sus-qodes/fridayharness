/**
 * Scoring for the context evals (plan M12.6): what a task's packet named of the files its task
 * needs, what it must never name, how large it is, and how much of it came from deterministic
 * sources. Pure functions over the compiler's own packet and explanation, so the runner and the
 * record read the same numbers.
 */
import type { ContextExplanation, ContextPacket } from '@friday/protocol';

export interface EvalTask {
  id: string;
  summary: string;
  description: string;
  acceptance_criteria: string[];
  /** The task's scopes as a plan declares them: what it may change, and what it may read. */
  scope: { write: string[]; read: string[] };
  /** Files a competent engineer must read for this task, repository-relative, all inside the read scope. */
  required: string[];
  /** Globs of files outside the read scope that must never reach this task's packet. */
  forbidden: string[];
}

/**
 * How the task's read scope is applied: `declared` compiles with the scope the task declares, as
 * a planned task is; `open` compiles with an open read scope, as a task created without one is.
 */
export type ScopeMode = 'declared' | 'open';

/** What every packet must keep out, whatever the task: Friday's runtime files, secrets and git's own files. */
export const ALWAYS_FORBIDDEN_GLOBS = [
  '**/.env',
  '**/.env.*',
  '.friday/project.db',
  '.friday/project.db-*',
  '.friday/logs/**',
  '.friday/graph/**',
  '.friday/run/**',
  '.git/**',
  'node_modules/**',
];

export interface Miss {
  path: string;
  why: string;
}

export interface TaskScore {
  id: string;
  summary: string;
  mode: ScopeMode;
  budget_chars: number;
  required: number;
  recalled: string[];
  missed: Miss[];
  /** Required files named in the packet, divided by required files; null when no packet was delivered. */
  recall: number | null;
  /**
   * True when nothing the task may not read reached the packet: never a protected file, and with
   * the declared read scope never a file outside it.
   */
  exclusion: boolean;
  /** Protected files (runtime, secrets, the private folder) the packet named: always a failure. */
  protected_hits: string[];
  /** Files matching the task's forbidden globs the packet named: a failure with the declared scope, noise with an open one. */
  scope_hits: string[];
  /** The delivered JSON packet's size, and the budget it had to fit. */
  chars: number;
  within_budget: boolean;
  /** The packet's advertised weight (its budget in tokens) and what its sources are estimated to weigh. */
  tokens: number;
  source_tokens: number;
  /** The Markdown an attached session reads, at the MCP tool's cap. */
  rendered_chars: number;
  sources: number;
  cut_by_budget: number;
  withheld_by_permission: number;
  /** Included sources that came from deterministic retrieval, divided by included sources. */
  deterministic_share: number;
  escalate: boolean;
  compile_ms: number;
  /** Where the compile time went, as the compiler timed itself (git identity, git, graph, request, memory). */
  timings_ms: Record<string, number>;
  /** Code files the packet names in its related-code section. */
  code_related: string[];
  /** Set when Friday could not deliver a packet for the task at this budget: the error, as Friday said it. */
  error?: string;
}

export interface Checkout {
  /** Whether the path is a node of the code graph (a parsed TypeScript or JavaScript file). */
  inGraph: (p: string) => boolean;
  /** Whether a repository-relative path matches any of the globs. */
  matches: (p: string, globs: readonly string[]) => boolean;
  /** Literal strings that must appear nowhere in a packet: the private state folder, a planted secret. */
  neverInText: string[];
  /** How many graph nodes fall in the task's write scope: the compiler seeds at most 20 of them. */
  inScopeNodes: number;
}

/** Paths as the packet names them: forward slashes, no leading `./`. */
export function normalizePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '');
}

function sectionText(packet: ContextPacket, kind: string): string {
  return packet.sections.find((s) => s.kind === kind)?.content ?? '';
}

/** The file paths a related-code line names: `- <path> — <reason>`. */
export function relatedFiles(packet: ContextPacket): string[] {
  return sectionText(packet, 'code.related')
    .split('\n')
    .map((line) => /^- (\S+) — /.exec(line)?.[1])
    .filter((p): p is string => Boolean(p));
}

/**
 * Whether the packet names the file where an agent would read it: the related-code or requested-code
 * sections, or a dirty or history line. Protected sections (the task contract, the scope) are not
 * counted, so a scope glob that spells out a file does not count as retrieval.
 */
function named(packet: ContextPacket, file: string): boolean {
  const where = ['code.related', 'code.requested', 'repo.dirty', 'repo.recent_commits', 'repo.history'];
  return where.some((kind) => sectionText(packet, kind).includes(file));
}

function whyMissed(file: string, task: EvalTask, explanation: ContextExplanation, checkout: Checkout): string {
  if (explanation.cut_by_budget.some((c) => c.source_id === file)) return 'gathered, cut by the budget';
  if (!checkout.inGraph(file)) {
    const ext = file.includes('.') ? file.slice(file.lastIndexOf('.')) : '(no extension)';
    return `not in the code graph: ${ext} files are not parsed, so no import relation reaches them`;
  }
  if (checkout.matches(file, task.scope.write)) {
    return checkout.inScopeNodes > 20
      ? `in the write scope, but the scope has ${checkout.inScopeNodes} code files and the compiler seeds the first 20`
      : 'in the write scope but not named (the first packet names no files since plan M14.7; FRIDAY_EVAL_REQUEST=scope_files scores the request that lists them)';
  }
  return 'in the code graph, but no import relation within two steps of the write scope reaches it';
}

export function scoreTask(
  task: EvalTask,
  mode: ScopeMode,
  result: { packet: ContextPacket; explanation: ContextExplanation; rendered: string },
  checkout: Checkout,
): TaskScore {
  const { packet, explanation, rendered } = result;
  const required = task.required.map(normalizePath);
  const recalled = required.filter((f) => named(packet, f));
  const missed = required
    .filter((f) => !recalled.includes(f))
    .map((path) => ({ path, why: whyMissed(path, task, explanation, checkout) }));
  const included = explanation.included;
  const text = JSON.stringify(packet);
  // Every file the packet names where an agent reads file names, plus every included source.
  const namedPaths = new Set<string>([
    ...included.map((s) => s.source_id),
    ...relatedFiles(packet),
    ...sectionText(packet, 'repo.dirty')
      .split('\n')
      .map((l) => l.replace(/^- /, ''))
      .filter(Boolean),
  ]);
  const protectedHits = new Set<string>();
  const scopeHits = new Set<string>();
  for (const p of namedPaths) {
    if (checkout.matches(p, ALWAYS_FORBIDDEN_GLOBS)) protectedHits.add(p);
    if (checkout.matches(p, task.forbidden)) scopeHits.add(p);
  }
  for (const literal of checkout.neverInText) if (literal && text.includes(literal)) protectedHits.add(literal);
  const json = text.length;
  const budget = packet.budget.chars ?? explanation.budget.chars;
  const deterministic = included.length
    ? (included.length - explanation.semantic_fallback.results) / included.length
    : 1;
  return {
    id: task.id,
    summary: task.summary,
    mode,
    budget_chars: budget,
    required: required.length,
    recalled,
    missed,
    recall: required.length ? recalled.length / required.length : null,
    exclusion: protectedHits.size === 0 && (mode === 'open' || scopeHits.size === 0),
    protected_hits: [...protectedHits].sort(),
    scope_hits: [...scopeHits].sort(),
    chars: json,
    within_budget: json <= budget,
    tokens: packet.budget.tokens,
    source_tokens: packet.sections.reduce((n, s) => n + s.sources.reduce((m, r) => m + r.estimated_tokens, 0), 0),
    rendered_chars: rendered.length,
    sources: included.length,
    cut_by_budget: explanation.cut_by_budget.length,
    withheld_by_permission: explanation.withheld_by_permission,
    deterministic_share: Math.round(deterministic * 1000) / 1000,
    escalate: explanation.escalate,
    compile_ms: explanation.timings_ms.total ?? 0,
    timings_ms: explanation.timings_ms,
    code_related: relatedFiles(packet),
  };
}

/** The row of a task whose packet Friday could not deliver: no figures, the error kept with it. */
export function errorScore(task: EvalTask, mode: ScopeMode, budget: number, error: string): TaskScore {
  return {
    id: task.id,
    summary: task.summary,
    mode,
    budget_chars: budget,
    required: task.required.length,
    recalled: [],
    missed: task.required.map((path) => ({ path, why: 'no packet was delivered' })),
    recall: null,
    exclusion: true,
    protected_hits: [],
    scope_hits: [],
    chars: 0,
    within_budget: true,
    tokens: 0,
    source_tokens: 0,
    rendered_chars: 0,
    sources: 0,
    cut_by_budget: 0,
    withheld_by_permission: 0,
    deterministic_share: 1,
    escalate: false,
    compile_ms: 0,
    timings_ms: {},
    code_related: [],
    error,
  };
}

export interface EvalTotals {
  tasks: number;
  /** Tasks for which Friday delivered no packet (their error is on the row). */
  undelivered: number;
  mean_recall: number | null;
  median_recall: number | null;
  /** Tasks whose packet named every required file. */
  full_recall: number;
  exclusion_all: boolean;
  /** Files outside the task's declared read scope that packets named, summed (noise with an open scope). */
  scope_hits: number;
  within_budget_all: boolean;
  mean_chars: number;
  max_chars: number;
  mean_sources: number;
  mean_compile_ms: number;
  deterministic_share: number;
  misses_by_reason: Record<string, number>;
}

export function totals(scores: TaskScore[]): EvalTotals {
  const delivered = scores.filter((s) => !s.error);
  const recalls = delivered.map((s) => s.recall).filter((r): r is number => r !== null);
  const sorted = [...recalls].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2
        ? (sorted[mid] as number)
        : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  const reasons: Record<string, number> = {};
  for (const s of delivered) for (const m of s.missed) reasons[m.why] = (reasons[m.why] ?? 0) + 1;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const mean = (f: (s: TaskScore) => number) =>
    delivered.length ? delivered.reduce((a, s) => a + f(s), 0) / delivered.length : 0;
  return {
    tasks: scores.length,
    undelivered: scores.length - delivered.length,
    mean_recall: recalls.length ? round(recalls.reduce((a, b) => a + b, 0) / recalls.length) : null,
    median_recall: median === null ? null : round(median),
    full_recall: delivered.filter((s) => s.recall === 1).length,
    exclusion_all: scores.every((s) => s.exclusion),
    scope_hits: delivered.reduce((a, s) => a + s.scope_hits.length, 0),
    within_budget_all: scores.every((s) => s.within_budget),
    mean_chars: Math.round(mean((s) => s.chars)),
    max_chars: delivered.reduce((a, s) => Math.max(a, s.chars), 0),
    mean_sources: round(mean((s) => s.sources)),
    mean_compile_ms: Math.round(mean((s) => s.compile_ms)),
    deterministic_share: delivered.length ? round(mean((s) => s.deterministic_share)) : 1,
    misses_by_reason: reasons,
  };
}

const pct = (r: number | null) => (r === null ? '-' : `${Math.round(r * 100)}%`);

/** The table the runner prints: one row per task, then the totals. */
export function renderTable(scores: TaskScore[], sum: EvalTotals): string {
  const rows = scores.map((s) => [
    s.id,
    s.error ? 'no packet' : `${s.recalled.length}/${s.required}`,
    s.error ? 'ERROR' : pct(s.recall),
    s.exclusion ? 'yes' : `NO (${s.protected_hits.length + s.scope_hits.length})`,
    String(s.scope_hits.length),
    String(s.chars),
    s.within_budget ? 'yes' : 'NO',
    String(s.sources),
    String(s.cut_by_budget),
    String(s.withheld_by_permission),
    pct(s.deterministic_share),
    String(s.compile_ms),
  ]);
  const head = [
    'TASK',
    'RECALLED',
    'RECALL',
    'EXCLUSION',
    'OUTSIDE',
    'CHARS',
    'IN BUDGET',
    'SOURCES',
    'CUT',
    'WITHHELD',
    'DETERMINISTIC',
    'MS',
  ];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] as number)).join('  ');
  const foot = [
    'mean',
    `${sum.full_recall} full${sum.undelivered ? `, ${sum.undelivered} none` : ''}`,
    pct(sum.mean_recall),
    sum.exclusion_all ? 'all' : 'NOT ALL',
    String(sum.scope_hits),
    String(sum.mean_chars),
    sum.within_budget_all ? 'all' : 'NOT ALL',
    String(sum.mean_sources),
    '',
    '',
    pct(sum.deterministic_share),
    String(sum.mean_compile_ms),
  ];
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line), line(foot)].join('\n');
}

/** Reads the committed eval set and refuses one that is not well formed, naming the task and field. */
export function parseEvalSet(raw: unknown): EvalTask[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { tasks?: unknown }).tasks)) {
    throw new Error('the eval set must be an object with a "tasks" array');
  }
  const tasks = (raw as { tasks: unknown[] }).tasks;
  const ids = new Set<string>();
  const strings = (t: Record<string, unknown>, field: string, id: string, min = 1): string[] => {
    const v = t[field];
    if (!Array.isArray(v) || v.length < min || !v.every((x) => typeof x === 'string' && x.length > 0)) {
      throw new Error(`task ${id}: "${field}" must be an array of at least ${min} non-empty string(s)`);
    }
    return v as string[];
  };
  return tasks.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`task #${i + 1} is not an object`);
    const t = entry as Record<string, unknown>;
    const id = typeof t.id === 'string' && /^[a-z0-9-]+$/.test(t.id) ? t.id : null;
    if (!id) throw new Error(`task #${i + 1}: "id" must be lower-case letters, digits and dashes`);
    if (ids.has(id)) throw new Error(`task ${id} appears twice`);
    ids.add(id);
    for (const field of ['summary', 'description']) {
      if (typeof t[field] !== 'string' || !(t[field] as string).length) {
        throw new Error(`task ${id}: "${field}" is required`);
      }
    }
    const scope = t.scope as Record<string, unknown> | undefined;
    if (!scope || typeof scope !== 'object') throw new Error(`task ${id}: "scope" is required`);
    const write = strings(scope, 'write', id);
    const read = strings(scope, 'read', id);
    const required = strings(t, 'required', id).map(normalizePath);
    for (const r of required) {
      if (r.startsWith('/') || /^[a-z]:/i.test(r) || r.includes('..') || /[*?]/.test(r)) {
        throw new Error(`task ${id}: required path "${r}" must be a repository-relative file, not a glob`);
      }
    }
    if (new Set(required).size !== required.length) throw new Error(`task ${id}: a required path appears twice`);
    return {
      id,
      summary: t.summary as string,
      description: t.description as string,
      acceptance_criteria: strings(t, 'acceptance_criteria', id, 0),
      scope: { write, read },
      required,
      forbidden: strings(t, 'forbidden', id, 0),
    };
  });
}
