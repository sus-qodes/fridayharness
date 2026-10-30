import { z } from 'zod';
import { canonicalRole, type RoleRegistry } from './role-registry.js';

/** Where a decision's execution role came from. */
export type RoutingRoleSource = 'task' | 'decision_model' | 'kind_fallback' | 'path_fallback' | 'missing' | 'none';

export interface TaskRoleFacts {
  kind: string;
  role: string | null | undefined;
  summary?: string;
  scope?: { write: readonly string[]; read: readonly string[] } | null | undefined;
}

export interface RoleResolution {
  role: string | null;
  source: RoutingRoleSource;
  reason: string;
}

const KIND_ROLES: Readonly<Record<string, string>> = {
  implementation: 'implementation',
  verification: 'verification',
  review: 'review',
  research: 'research',
  docs: 'docs',
  chore: 'chore',
};

const DOC_PATH =
  /(^|[\\/])(docs?|documentation)([\\/]|$)|\.(md|mdx|rst|adoc)$|(^|[\\/])(readme|changelog|contributing)(\.|$)/i;
const TEST_PATH = /(^|[\\/])(__tests__|tests?|spec|specs|fixtures?)([\\/]|$)|\.(test|spec)\.[^\\/]+$/i;
const CHORE_PATH =
  /(^|[\\/])(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig[^\\/]*\.json|biome\.json|\.gitignore|\.gitattributes|\.github)([\\/]|$)/i;
const CODE_PATH = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|sql|sh|ps1)$/i;
const SOURCE_PATH = /(^|[\\/])(src|lib|app|apps|packages|pkg|internal|cmd)([\\/]|$)/i;

function pathRole(path: string): string | null {
  if (DOC_PATH.test(path)) return 'docs';
  if (TEST_PATH.test(path)) return 'verification';
  if (CHORE_PATH.test(path)) return 'chore';
  if (CODE_PATH.test(path) || SOURCE_PATH.test(path)) return 'implementation';
  return null;
}

/**
 * A deterministic execution role when the task itself names none: its kind when that kind is one of
 * Friday's own, else the role its paths unambiguously point at. Ambiguous or multi-role work returns
 * null and is left for the decision router; this function never guesses from prose.
 */
export function fallbackTaskRole(task: TaskRoleFacts): RoleResolution | null {
  const byKind = KIND_ROLES[task.kind];
  if (byKind) {
    return { role: byKind, source: 'kind_fallback', reason: `task kind "${task.kind}" is unambiguous` };
  }
  const write = task.scope?.write ?? [];
  const paths = write.length ? write : (task.scope?.read ?? []);
  const roles = new Set(paths.map(pathRole).filter((role): role is string => role !== null));
  if (roles.size === 1) {
    const [role] = roles;
    if (role) return { role, source: 'path_fallback', reason: `scope paths point at ${role}` };
  }
  if (roles.size > 1) {
    return null;
  }
  return null;
}

/**
 * The execution role a decision may dispatch: a validated decision-model result, the plan/task role,
 * or a deterministic kind/path fallback for an unroled task when the static registry is in use.
 * Without a registry, a task role is reported as written and an unroled task stays unroled.
 */
export function resolveTaskRole(input: {
  task: TaskRoleFacts;
  registry?: RoleRegistry | null;
  resolvedRole?: string | null;
}): RoleResolution {
  const registry = input.registry ?? null;
  const resolved = input.resolvedRole?.trim();
  if (resolved) {
    const role = registry ? (canonicalRole(resolved, registry) ?? resolved) : resolved;
    return {
      role,
      source: 'decision_model',
      reason:
        role === resolved
          ? `decision model classified the task as ${role}`
          : `decision model classified the task as ${resolved} (${role})`,
    };
  }
  const named = input.task.role?.trim();
  if (named) {
    const role = registry ? (canonicalRole(named, registry) ?? named) : named;
    return {
      role,
      source: 'task',
      reason: role === named ? `task names role ${named}` : `task names role ${named}, which is ${role}`,
    };
  }
  if (registry) {
    const fallback = fallbackTaskRole(input.task);
    if (fallback) return fallback;
  }
  return {
    role: null,
    source: 'missing',
    reason: 'the task names no role and no deterministic kind or path fallback applies',
  };
}

/** The result a decision model may return when Friday needs to assign a role. */
export const RoleDecision = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('classified'),
    roles: z
      .array(
        z.object({
          role: z.string().trim().min(1).max(64),
          task_summary: z.string().trim().min(1).max(500),
          depends_on: z.array(z.string().trim().min(1).max(64)).default([]),
          confidence: z.number().finite().min(0).max(1),
        }),
      )
      .min(1)
      .max(32),
    assumptions: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  }),
  z.object({
    status: z.literal('clarification_required'),
    missing_facts: z.array(z.string().trim().min(1).max(500)).max(20),
    questions: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  }),
]);
export type RoleDecision = z.infer<typeof RoleDecision>;

export interface RoleDecisionInput {
  objective: string;
  constraints: readonly string[];
  outcomes: readonly string[];
  non_goals: readonly string[];
  definition_of_done: readonly string[];
  task_summary: string;
  task_description: string | null;
  kind: string;
  risk_level: 'low' | 'medium' | 'high' | null;
  scope: { write: readonly string[]; read: readonly string[] } | null;
}

/**
 * Validates a decision-model result and applies the registry's role vocabulary.
 * Unknown roles, duplicate task summaries and dependency cycles are blocked before dispatch.
 */
export function parseRoleDecision(value: unknown, allowedRoles: ReadonlySet<string>): RoleDecision {
  const parsed = RoleDecision.parse(value);
  if (parsed.status !== 'classified') return parsed;
  const roles = parsed.roles.map((entry) => ({ ...entry, depends_on: [...new Set(entry.depends_on)] }));
  const keys = new Set<string>();
  const roleIndexes = new Map<string, number>();
  for (const [index, entry] of roles.entries()) {
    if (!allowedRoles.has(entry.role)) throw new Error(`role decision names unsupported role "${entry.role}"`);
    const key = `role-${index + 1}`;
    keys.add(key);
    if (!roleIndexes.has(entry.role)) roleIndexes.set(entry.role, index);
  }
  for (const [index, entry] of roles.entries()) {
    for (const dependency of entry.depends_on) {
      if (!keys.has(dependency) && !roleIndexes.has(dependency)) {
        throw new Error(`role decision depends on unknown node "${dependency}"`);
      }
    }
    if (entry.depends_on.includes(`role-${index + 1}`) || entry.depends_on.includes(entry.role)) {
      throw new Error(`role decision contains a self dependency for "${entry.role}"`);
    }
  }
  // Role names are accepted as dependency labels for compact model output. A DFS proves the DAG.
  const edges = roles.map((entry) =>
    entry.depends_on
      .map((dependency) => {
        if (dependency.startsWith('role-')) return Number(dependency.slice(5)) - 1;
        return roleIndexes.get(dependency) ?? -1;
      })
      .filter((i) => i >= 0),
  );
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (index: number): void => {
    if (visiting.has(index)) throw new Error('role decision contains a dependency cycle');
    if (visited.has(index)) return;
    visiting.add(index);
    for (const dependency of edges[index] ?? []) visit(dependency);
    visiting.delete(index);
    visited.add(index);
  };
  for (let index = 0; index < roles.length; index += 1) visit(index);
  return { ...parsed, roles };
}

/** Returns the first clarification reason when a valid classification is still too uncertain to dispatch. */
export function roleDecisionBlockReason(decision: RoleDecision, minimumConfidence = 0.7): string | null {
  if (decision.status === 'clarification_required') return decision.questions.join('; ');
  const uncertain = decision.roles.filter((entry) => entry.confidence < minimumConfidence);
  return uncertain.length
    ? `role classification confidence is below ${minimumConfidence}: ${uncertain.map((entry) => `${entry.role}=${entry.confidence}`).join(', ')}`
    : null;
}
