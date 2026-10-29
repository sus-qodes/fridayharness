/**
 * Friday's own verification checks (ADR-0024 §3–§5): diff analysis against the task's scope and
 * claim, check selection by task kind, tests related to a change, and the credential scan. Pure
 * functions: the daemon reads git, the graph and the files, and passes what they said.
 */
import { createHash } from 'node:crypto';

export type Severity = 'fail' | 'warn' | 'info';

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** Root-relative paths, forward slashes; at most MAX_LISTED. */
  paths: string[];
}

export interface ChangedPath {
  /** Root-relative, forward slashes. */
  path: string;
  change: 'added' | 'modified' | 'deleted' | 'renamed';
  /** The previous path of a rename. */
  origPath?: string;
}

const MAX_LISTED = 20;
const listed = <T>(items: T[]) => items.slice(0, MAX_LISTED);
const more = (paths: string[]) => (paths.length > MAX_LISTED ? ` (and ${paths.length - MAX_LISTED} more)` : '');
const show = (paths: string[]) => `${listed(paths).join(', ')}${more(paths)}`;

export interface DiffInput {
  changed: ChangedPath[];
  /** The task's write scope; empty or null: the task may not write. */
  write: string[] | null;
  /** Root-relative paths the completion claim lists; null without a claim. */
  claimed: string[] | null;
  /** The execution root is the main checkout, which other sessions and the human may share. */
  shared: boolean;
  /** Root-relative paths Friday's hooks saw this task's session change (they attribute changes). */
  observed?: string[] | null;
  /** Whether a path is inside the write scope. */
  inScope: (path: string) => boolean;
  /** The protected class of a path for a write (ADR-0023 §6), or null. */
  protectedClass: (path: string) => string | null;
  /** The task is expected to change files (implementation work). */
  expectsChanges: boolean;
  /** Compare paths without case (Windows). */
  caseInsensitive?: boolean;
  /**
   * The project's effective policy for a write (ADR-0028, review F03): the rule that forbids the
   * path (its `deny.write`, or a team scope of the agent's role), or null. The hooks apply the same
   * rule; verification is the second defence for writes that went around them.
   */
  policyRule?: (path: string) => { rule: string; message: string } | null;
  /** The exact-path approval a human gave this task's attempt for writing the path, or null. */
  approved?: (path: string) => string | null;
}

/**
 * The changes that are this task's (ADR-0024 §3). In its own worktree, every change. In the shared
 * main checkout, only those its session was seen making or its claim lists: the rest may be other
 * sessions' or the human's work (Friday's own harness files, for example).
 */
export function ownChanges(input: Pick<DiffInput, 'changed' | 'shared' | 'observed' | 'claimed' | 'caseInsensitive'>): {
  own: ChangedPath[];
  others: string[];
} {
  if (!input.shared) return { own: [...input.changed], others: [] };
  const fold = (p: string) => (input.caseInsensitive ? p.toLowerCase() : p);
  const mine = new Set([...(input.observed ?? []), ...(input.claimed ?? [])].map(fold));
  const own = input.changed.filter(
    (c) => mine.has(fold(c.path)) || (c.origPath !== undefined && mine.has(fold(c.origPath))),
  );
  const others = input.changed.filter((c) => !own.includes(c)).map((c) => c.path);
  return { own, others };
}

/** The task's changes against its write scope, Friday's protected files and its claim. */
export function analyzeDiff(input: DiffInput): Finding[] {
  const findings: Finding[] = [];
  const fold = (p: string) => (input.caseInsensitive ? p.toLowerCase() : p);
  const { own, others } = ownChanges(input);
  const touched = [
    ...new Set(own.flatMap((c) => (c.origPath && c.origPath !== c.path ? [c.path, c.origPath] : [c.path]))),
  ].sort();

  const protectedPaths: { path: string; cls: string }[] = [];
  for (const p of touched) {
    const cls = input.protectedClass(p);
    if (cls) protectedPaths.push({ path: p, cls });
  }
  if (protectedPaths.length) {
    findings.push({
      rule: 'diff.protected',
      severity: 'fail',
      message: `changed protected files: ${listed(protectedPaths)
        .map((x) => `${x.path} (${x.cls})`)
        .join(', ')}${more(protectedPaths.map((x) => x.path))}.`,
      paths: listed(protectedPaths.map((x) => x.path)),
    });
  }
  const isProtected = new Set(protectedPaths.map((x) => x.path));
  const writable = Boolean(input.write?.length);
  // A human's exact-path approval lets a write outside the scope, or under a deny rule, stand.
  const grant = new Map<string, string>();
  for (const p of touched) {
    const id = isProtected.has(p) ? null : (input.approved?.(p) ?? null);
    if (id) grant.set(p, id);
  }
  const outside = touched.filter((p) => !isProtected.has(p) && !grant.has(p) && (!writable || !input.inScope(p)));
  const isOutside = new Set(outside);
  const byRule = new Map<string, { message: string; paths: string[] }>();
  for (const p of touched) {
    if (isProtected.has(p) || isOutside.has(p) || grant.has(p)) continue;
    const hit = input.policyRule?.(p);
    if (!hit) continue;
    const entry = byRule.get(hit.rule) ?? { message: hit.message, paths: [] };
    entry.paths.push(p);
    byRule.set(hit.rule, entry);
  }
  for (const [rule, { message, paths }] of byRule) {
    findings.push({ rule, severity: 'fail', message: `${message}: ${show(paths)}.`, paths: listed(paths) });
  }
  if (grant.size) {
    const paths = [...grant.keys()];
    findings.push({
      rule: 'diff.approved',
      severity: 'info',
      message: `changed with a human's approval of that exact path: ${listed(paths)
        .map((p) => `${p} (${grant.get(p)})`)
        .join(', ')}${more(paths)}.`,
      paths: listed(paths),
    });
  }
  if (outside.length) {
    findings.push(
      writable
        ? {
            rule: 'diff.outside_scope',
            severity: 'fail',
            message: `changed outside the write scope (${(input.write ?? []).join(', ')}): ${show(outside)}.`,
            paths: listed(outside),
          }
        : {
            rule: 'diff.read_only',
            severity: 'fail',
            message: `this task has no write scope, but changed: ${show(outside)}.`,
            paths: listed(outside),
          },
    );
  }

  if (input.claimed) {
    const touchedSet = new Set(touched.map(fold));
    const claimedSet = new Set(input.claimed.map(fold));
    const unclaimed = touched.filter((p) => !claimedSet.has(fold(p)));
    const unchanged = [...new Set(input.claimed)].filter((p) => !touchedSet.has(fold(p))).sort();
    if (unclaimed.length) {
      findings.push({
        rule: 'diff.unclaimed',
        severity: 'warn',
        message: `changed but not listed in the completion claim: ${show(unclaimed)}`,
        paths: listed(unclaimed),
      });
    }
    if (unchanged.length) {
      findings.push({
        rule: 'diff.claimed_unchanged',
        severity: 'warn',
        message: `listed in the completion claim but not changed: ${show(unchanged)}`,
        paths: listed(unchanged),
      });
    }
  }
  if (input.expectsChanges && touched.length === 0) {
    findings.push({ rule: 'diff.empty', severity: 'warn', message: 'the task changed no files', paths: [] });
  }
  if (others.length) {
    findings.push({
      rule: 'diff.unattributed',
      severity: 'info',
      message: `not judged: ${others.length} other changed file(s) in the shared main checkout, which this task's session was not seen changing and its claim does not list: ${show(others)}`,
      paths: listed(others),
    });
  }
  return findings;
}

/**
 * Conflict-prone files in a task's changes (ADR-0025 §1): a change to a file another task holds
 * fails; the `required` patterns the changes fall under that the task does not hold yet are the
 * ones it takes now (a spawn run has no hooks to take them at its first write).
 */
export function checkReservations(input: {
  changed: readonly string[];
  required: readonly string[];
  /** Reservations other tasks hold. */
  held: readonly { pattern: string; task_id: string }[];
  /** Patterns this task holds. */
  mine: readonly string[];
  matches: (path: string, pattern: string) => boolean;
}): { findings: Finding[]; acquire: string[] } {
  const conflicts: string[] = [];
  const paths: string[] = [];
  for (const p of input.changed) {
    const holder = input.held.find((h) => input.matches(p, h.pattern));
    if (!holder) continue;
    conflicts.push(`${p} (held by ${holder.task_id} as ${holder.pattern})`);
    paths.push(p);
  }
  const findings: Finding[] = conflicts.length
    ? [
        {
          rule: 'diff.reserved',
          severity: 'fail',
          message: `changed files another task holds reserved: ${show(conflicts)}. That work must be integrated first; then rebase this task's work on it.`,
          paths: listed(paths),
        },
      ]
    : [];
  const acquire = [...new Set(input.changed.flatMap((p) => input.required.filter((r) => input.matches(p, r))))].filter(
    (r) => !input.mine.includes(r),
  );
  return { findings, acquire };
}

/** A configured check, as far as selection is concerned. */
export interface SelectableCheck {
  name: string;
  task_kinds?: string[] | undefined;
}

/** The checks that apply to a task kind: those listing it, and those listing no kind (ADR-0024 §4). */
export function selectChecks<T extends SelectableCheck>(checks: readonly T[], kind: string): T[] {
  return checks.filter((c) => !c.task_kinds?.length || c.task_kinds.includes(kind));
}

/**
 * The version of the checks that judge a task kind (review F15): outcomes judged by other checks
 * are not comparable, so they are counted in another cohort.
 */
export function checksVersion(checks: readonly SelectableCheck[], kind: string): string {
  const order = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(order)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, order((v as Record<string, unknown>)[k])]),
          )
        : v;
  const selected = selectChecks(checks, kind).map(order);
  return createHash('sha256').update(JSON.stringify(selected)).digest('hex').slice(0, 16);
}

export interface TestGraph {
  /** Test files that import the file. */
  testsOf(file: string): string[];
  /** The graph parsed the file (a source file it understands). */
  isSource(file: string): boolean;
  isTest(file: string): boolean;
}

/**
 * Tests related to a change (ADR-0024 §5): every changed test, and the tests that import a changed
 * source file. Changed source files that no test imports are returned as `untested`.
 */
export function relatedTests(changed: readonly string[], graph: TestGraph): { tests: string[]; untested: string[] } {
  const tests = new Set<string>();
  const untested: string[] = [];
  for (const f of new Set(changed)) {
    if (graph.isTest(f)) {
      tests.add(f);
      continue;
    }
    if (!graph.isSource(f)) continue;
    const related = graph.testsOf(f);
    if (related.length) for (const t of related) tests.add(t);
    else untested.push(f);
  }
  return { tests: [...tests].sort(), untested: untested.sort() };
}

/** A line that holds this marker is not scanned (a documented test credential, for example). */
export const ALLOW_SECRET_MARKER = 'friday:allow-secret';

/**
 * The credential scan (ADR-0024 §3): which changed files hold a credential in a well-known format,
 * by file and line. The values never leave this function.
 */
export function scanCredentials(
  files: readonly { path: string; text: string }[],
  find: (text: string) => { kind: string; line: number }[],
): Finding[] {
  const hits: string[] = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    for (const h of find(f.text)) {
      if (lines[h.line - 1]?.includes(ALLOW_SECRET_MARKER)) continue;
      hits.push(`${f.path}:${h.line} (${h.kind})`);
    }
  }
  if (!hits.length) return [];
  return [
    {
      rule: 'secrets.found',
      severity: 'fail',
      message: `credentials in changed files: ${show(hits)}. Remove them and rotate any that were real; a line marked "${ALLOW_SECRET_MARKER}" is not scanned.`,
      paths: [...new Set(listed(hits).map((h) => h.slice(0, h.lastIndexOf(':'))))],
    },
  ];
}
