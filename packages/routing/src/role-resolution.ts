import { createHash } from 'node:crypto';
import { canonicalRole, ROLE_REGISTRY_SOURCE, type RoleRegistry } from './role-registry.js';
import {
  fallbackTaskRole,
  type ProposedRole,
  type RoleDecision,
  type RoutingRoleSource,
  type TaskRoleFacts,
} from './roles.js';

/**
 * Persisted role resolution (R2). The task's role is part of its contract: once resolved, the same
 * task keeps the same role for the same intent and registry version. Only work that no plan, task,
 * human or deterministic fallback can name reaches the decision model; a multi-role answer stays a
 * proposed DAG instead of being collapsed into one role.
 */
export type TaskRoleOrigin = 'plan' | 'task' | 'human' | 'none';
export type TaskRoleDecisionStatus = 'resolved' | 'proposed' | 'blocked';

export interface RoleContractResolution {
  status: TaskRoleDecisionStatus;
  role: string | null;
  source: RoutingRoleSource;
  confidence: number | null;
  intent_version: string;
  registry_version: string | null;
  reason: string;
  roles: ProposedRole[];
  assumptions: string[];
  missing_facts: string[];
  questions: string[];
}

/** The stable facts a role decision was made from (I1 will replace this with real intent versions). */
export function taskRoleIntentVersion(task: TaskRoleFacts): string {
  const intent = {
    version: 1,
    kind: task.kind,
    summary: task.summary ?? '',
    description: task.description ?? '',
    acceptance_criteria: [...(task.acceptance_criteria ?? [])],
    risk_level: task.risk_level ?? null,
    scope: {
      write: [...(task.scope?.write ?? [])].sort(),
      read: [...(task.scope?.read ?? [])].sort(),
    },
    goal_id: task.goal_id ?? null,
    plan_id: task.plan_id ?? null,
    plan_version: task.plan_version ?? null,
    plan_key: task.plan_key ?? null,
  };
  const hash = createHash('sha256').update(JSON.stringify(intent)).digest('hex').slice(0, 16);
  return `ri1_${hash}`;
}

function resolved(
  task: TaskRoleFacts,
  role: string,
  source: RoutingRoleSource,
  confidence: number | null,
  reason: string,
  registryVersion: string | null,
  extras: Partial<RoleContractResolution> = {},
): RoleContractResolution {
  return {
    status: 'resolved',
    role,
    source,
    confidence,
    intent_version: taskRoleIntentVersion(task),
    registry_version: registryVersion,
    reason,
    roles: [],
    assumptions: [],
    missing_facts: [],
    questions: [],
    ...extras,
  };
}

function blocked(
  task: TaskRoleFacts,
  reason: string,
  registryVersion: string | null,
  extras: Partial<RoleContractResolution> = {},
): RoleContractResolution {
  return {
    status: 'blocked',
    role: null,
    source: 'missing',
    confidence: null,
    intent_version: taskRoleIntentVersion(task),
    registry_version: registryVersion,
    reason,
    roles: [],
    assumptions: [],
    missing_facts: [],
    questions: [reason],
    ...extras,
  };
}

function fromDecision(
  task: TaskRoleFacts,
  decision: RoleDecision,
  registryVersion: string | null,
): RoleContractResolution {
  if (decision.status === 'clarification_required') {
    return blocked(task, decision.questions.join('; '), registryVersion, {
      missing_facts: decision.missing_facts,
      questions: decision.questions,
    });
  }
  const roles: ProposedRole[] = decision.roles.map((entry) => ({
    role: entry.role,
    task_summary: entry.task_summary,
    depends_on: [...entry.depends_on],
    confidence: entry.confidence,
  }));
  const confidence = Math.min(...roles.map((entry) => entry.confidence));
  if (roles.length === 1) {
    const only = roles[0] as ProposedRole;
    return resolved(
      task,
      only.role,
      'decision_model',
      only.confidence,
      `decision model classified the task as ${only.role}`,
      registryVersion,
      {
        roles,
        assumptions: decision.assumptions,
      },
    );
  }
  return {
    status: 'proposed',
    role: null,
    source: 'decision_model',
    confidence,
    intent_version: taskRoleIntentVersion(task),
    registry_version: registryVersion,
    reason: `decision model proposed ${roles.length} roles as a DAG; a human decides the work split`,
    roles,
    assumptions: decision.assumptions,
    missing_facts: [],
    questions: [],
  };
}

/**
 * Resolves a task's role contract in the locked order: an explicit plan/task/human role, the
 * deterministic kind/path fallback, then a decision model result for ambiguous work. No decision
 * model is needed when any earlier step names the role.
 */
export function resolveTaskRoleContract(input: {
  task: TaskRoleFacts;
  origin?: TaskRoleOrigin;
  explicit_role?: string | null;
  registry?: RoleRegistry | null;
  intent_version?: string | null;
  decision?: RoleDecision | null;
  /** An already-recorded decision is authoritative (used by recording, never by task creation). */
  prefer_decision?: boolean;
}): RoleContractResolution {
  const registry = input.registry ?? ROLE_REGISTRY_SOURCE;
  const registryVersion = registry.version;
  const origin = input.origin ?? 'none';
  const explicit = input.explicit_role?.trim() ?? '';
  const make = (r: RoleContractResolution): RoleContractResolution => ({
    ...r,
    ...(input.intent_version ? { intent_version: input.intent_version } : {}),
  });
  if (explicit) {
    const source: RoutingRoleSource = origin === 'plan' ? 'plan' : origin === 'human' ? 'human' : 'task';
    const why = source === 'plan' ? 'the plan names' : source === 'human' ? 'a human assigned' : 'the task names';
    const canonical = canonicalRole(explicit, registry);
    return make(
      resolved(
        input.task,
        explicit,
        source,
        1,
        canonical && canonical !== explicit ? `${why} role ${explicit} (${canonical})` : `${why} role ${explicit}`,
        registryVersion,
      ),
    );
  }
  if (input.prefer_decision && input.decision) {
    return make(fromDecision(input.task, input.decision, registryVersion));
  }
  const fallback = fallbackTaskRole(input.task);
  if (fallback) {
    return make({
      ...fallback,
      status: 'resolved',
      confidence: 1,
      intent_version: taskRoleIntentVersion(input.task),
      registry_version: registryVersion,
      roles: [],
      assumptions: [],
      missing_facts: [],
      questions: [],
    });
  }
  if (input.decision) return make(fromDecision(input.task, input.decision, registryVersion));
  return make(
    blocked(
      input.task,
      "The task's kind and scope do not identify one role. Which role should do this work?",
      registryVersion,
    ),
  );
}
