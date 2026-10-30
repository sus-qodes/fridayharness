import { z } from 'zod';
import { canonicalRole, type RoleRegistry } from './role-registry.js';

/** Where a task's execution role came from. */
export type RoutingRoleSource =
  | 'plan'
  | 'task'
  | 'human'
  | 'decision_model'
  | 'kind_fallback'
  | 'path_fallback'
  | 'missing'
  | 'none';

/** One node of a role decision model's proposed work split. */
export interface ProposedRole {
  role: string;
  task_summary: string;
  depends_on: string[];
  confidence: number;
}

export interface TaskRoleFacts {
  kind: string;
  role: string | null | undefined;
  summary?: string;
  description?: string | null;
  acceptance_criteria?: readonly string[];
  risk_level?: string | null;
  scope?: { write: readonly string[]; read: readonly string[] } | null | undefined;
  goal_id?: string | null;
  plan_id?: string | null;
  plan_version?: number | null;
  plan_key?: string | null;
  /** The persisted role contract, when the task already carries one (R2). */
  role_source?: string | null;
  role_confidence?: number | null;
  role_decision_id?: string | null;
  role_intent_version?: string | null;
  role_registry_version?: string | null;
}

export interface RoleResolution {
  role: string | null;
  source: RoutingRoleSource;
  reason: string;
  confidence: number | null;
  decision_id: string | null;
  intent_version: string | null;
  registry_version: string | null;
  /** Empty unless a decision model proposed a multi-role work split. */
  proposed_roles: ProposedRole[];
}

const PERSISTED_ROLE_SOURCES: ReadonlySet<RoutingRoleSource> = new Set([
  'plan',
  'task',
  'human',
  'decision_model',
  'kind_fallback',
  'path_fallback',
  'missing',
]);

function persistedSource(value: string | null | undefined): RoutingRoleSource | null {
  return value && PERSISTED_ROLE_SOURCES.has(value as RoutingRoleSource) ? (value as RoutingRoleSource) : null;
}

const KIND_ROLES: Readonly<Record<string, string>> = {
  implementation: 'implementation',
  verification: 'qa_and_debugging',
  review: 'code_reviewer_and_security',
  research: 'research',
  docs: 'docs',
  chore: 'chore',
};

const DOC_PATH =
  /(^|[\\/])(docs?|documentation)([\\/]|$)|\.(md|mdx|rst|adoc)$|(^|[\\/])(readme|changelog|contributing)(\.|$)/i;
const TEST_PATH = /(^|[\\/])(__tests__|tests?|spec|specs|fixtures?)([\\/]|$)|\.(test|spec)\.[^\\/]+$/i;
const DEVOPS_PATH =
  /(^|[\\/])(\.github|\.gitlab|devops|deploy|deployment|infra|infrastructure|terraform|k8s|kubernetes|helm|ansible|ops)([\\/]|$)|(^|[\\/])(dockerfile|docker-compose\.[^\\/]+|makefile|justfile)$/i;
const FRONTEND_PATH = /(^|[\\/])(frontend|web|ui|client|browser)([\\/]|$)/i;
const BACKEND_PATH = /(^|[\\/])(backend|server|service|services|api|database|db)([\\/]|$)/i;
const CHORE_PATH =
  /(^|[\\/])(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig[^\\/]*\.json|biome\.json|\.gitignore|\.gitattributes)([\\/]|$)/i;
const CODE_PATH = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|sql|sh|ps1)$/i;
const SOURCE_PATH = /(^|[\\/])(src|lib|app|apps|packages|pkg|internal|cmd)([\\/]|$)/i;

function pathRole(path: string): string | null {
  if (DOC_PATH.test(path)) return 'docs';
  if (TEST_PATH.test(path)) return 'qa_and_debugging';
  if (DEVOPS_PATH.test(path)) return 'devops_and_terminal';
  if (FRONTEND_PATH.test(path)) return 'frontend_engineer';
  if (BACKEND_PATH.test(path)) return 'backend_engineer';
  if (CHORE_PATH.test(path)) return 'chore';
  if (CODE_PATH.test(path) || SOURCE_PATH.test(path)) return 'implementation';
  return null;
}

/**
 * A deterministic execution role when the task itself names none: its kind when that kind is one of
 * Friday's own, else the role its paths unambiguously point at. Ambiguous or multi-role work returns
 * null and is left for the decision router; this function never guesses from prose.
 */
type RoleResolutionMetadata = Pick<
  RoleResolution,
  'confidence' | 'decision_id' | 'intent_version' | 'registry_version' | 'proposed_roles'
>;

const emptyResolution = (): RoleResolutionMetadata => ({
  confidence: null,
  decision_id: null,
  intent_version: null,
  registry_version: null,
  proposed_roles: [],
});

export function fallbackTaskRole(task: TaskRoleFacts): RoleResolution | null {
  const byKind = KIND_ROLES[task.kind];
  // A kind other than implementation is unambiguous on its own. Implementation is the general
  // case: a clear frontend/backend/... scope may specialize it, while conflicting scopes are
  // exactly the multi-role work the decision model exists for (R2).
  if (byKind && task.kind !== 'implementation') {
    return {
      role: byKind,
      source: 'kind_fallback',
      reason: `task kind "${task.kind}" is unambiguous`,
      ...emptyResolution(),
    };
  }
  const write = task.scope?.write ?? [];
  const paths = write.length ? write : (task.scope?.read ?? []);
  const roles = new Set(paths.map(pathRole).filter((role): role is string => role !== null));
  if (roles.size > 1) return null;
  if (roles.size === 1) {
    const [role] = roles;
    if (!role) return null;
    // For an implementation task the kind fallback is more direct; for any other kind a
    // non-specialized source path still points unambiguously at implementation.
    if (role !== 'implementation' || !byKind) {
      return {
        role,
        source: 'path_fallback',
        reason: `scope paths point at ${role}`,
        ...emptyResolution(),
      };
    }
  }
  if (byKind) {
    return {
      role: byKind,
      source: 'kind_fallback',
      reason: `task kind "${task.kind}" is unambiguous`,
      ...emptyResolution(),
    };
  }
  return null;
}

/**
 * The execution role a decision may dispatch (R2). The task's persisted contract wins; otherwise
 * the deterministic kind/path fallback applies before the decision model. A decision model result
 * is only consulted when the task itself and the deterministic fallback leave the role ambiguous.
 * Without a registry, a task role is reported as written and an unroled task stays unroled.
 */
export function resolveTaskRole(input: {
  task: TaskRoleFacts;
  registry?: RoleRegistry | null;
  resolvedRole?: string | null;
}): RoleResolution {
  const registry = input.registry ?? null;
  const source = persistedSource(input.task.role_source);
  const withMetadata = (r: Omit<RoleResolution, keyof ReturnType<typeof emptyResolution>>): RoleResolution => ({
    ...r,
    confidence: input.task.role_confidence ?? 1,
    decision_id: input.task.role_decision_id ?? null,
    intent_version: input.task.role_intent_version ?? null,
    registry_version: input.task.role_registry_version ?? registry?.version ?? null,
    proposed_roles: [],
  });
  const named = input.task.role?.trim();
  if (named) {
    const role = registry ? (canonicalRole(named, registry) ?? named) : named;
    const from = source ?? 'task';
    const why =
      from === 'plan'
        ? 'the plan names'
        : from === 'human'
          ? 'a human assigned'
          : from === 'decision_model'
            ? 'the decision model classified'
            : from === 'kind_fallback' || from === 'path_fallback'
              ? 'the deterministic fallback resolved'
              : 'the task names';
    return withMetadata({
      role,
      source: from,
      reason: role === named ? `${why} role ${named}` : `${why} role ${named}, which is ${role}`,
    });
  }
  if (source === 'decision_model' && input.task.role_decision_id) {
    return withMetadata({
      role: null,
      source: 'decision_model',
      reason: 'the decision model proposed more than one role; a human decides the work split',
    });
  }
  if (source === 'missing' && input.task.role_decision_id) {
    return withMetadata({
      role: null,
      source: 'missing',
      reason: 'role resolution is blocked; a human must name the role',
    });
  }
  if (registry) {
    const fallback = fallbackTaskRole(input.task);
    if (fallback) {
      return {
        ...fallback,
        confidence: input.task.role_confidence ?? 1,
        decision_id: input.task.role_decision_id ?? null,
        intent_version: input.task.role_intent_version ?? null,
        registry_version: input.task.role_registry_version ?? registry.version,
        proposed_roles: [],
      };
    }
  }
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
      confidence: null,
      decision_id: null,
      intent_version: null,
      registry_version: registry?.version ?? null,
      proposed_roles: [],
    };
  }
  return withMetadata({
    role: null,
    source: 'missing',
    reason: 'the task names no role and no deterministic kind or path fallback applies',
  });
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

/**
 * Returns the clarification reason when a valid classification is still too uncertain to dispatch.
 * A multi-role answer always waits for a human, so its confidence cannot make dispatch less safe.
 */
export function roleDecisionBlockReason(decision: RoleDecision, minimumConfidence = 0.7): string | null {
  if (decision.status === 'clarification_required') return decision.questions.join('; ');
  if (decision.roles.length !== 1) return null;
  const uncertain = decision.roles.filter((entry) => entry.confidence < minimumConfidence);
  return uncertain.length
    ? `role classification confidence is below ${minimumConfidence}: ${uncertain.map((entry) => `${entry.role}=${entry.confidence}`).join(', ')}`
    : null;
}
