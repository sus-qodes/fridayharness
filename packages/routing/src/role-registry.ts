import type { ModelRecord } from './registry.js';

export interface RoleRegistryCandidate {
  rank: number;
  model: string;
  harness: string;
  dispatchable: boolean;
  mcp_required: boolean;
  reason_if_unavailable: string | null;
}

export interface RoleRegistryRole {
  role: string;
  description: string;
  candidates: readonly RoleRegistryCandidate[];
}

export interface RoleRegistry {
  version: string;
  roles: Readonly<Record<string, RoleRegistryRole>>;
  aliases: Readonly<Record<string, string>>;
}

/**
 * A project's extension of one role's candidate list (`routing.role_candidates`). An unset rank is
 * appended after the role's shipped candidates, so a project never has to know Friday's ranks.
 */
export interface ProjectRoleCandidate {
  rank?: number;
  model: string;
  harness: string;
  dispatchable?: boolean;
  mcp_required?: boolean;
  reason_if_unavailable?: string | null;
}

/**
 * Typed canonical role registry. Model/harness readiness is checked at dispatch time; entries that
 * are declared for future adapters remain visible but are deliberately non-dispatchable.
 */
export const ROLE_REGISTRY_SOURCE: RoleRegistry = {
  version: '2026-10-21.2',
  aliases: {
    backend: 'implementation',
    frontend: 'implementation',
    developer: 'implementation',
    dev: 'implementation',
    engineer: 'implementation',
    qa: 'verification',
    test: 'verification',
    tester: 'verification',
    testing: 'verification',
    documentation: 'docs',
    maintenance: 'chore',
    investigate: 'research',
  },
  roles: {
    decision_router: {
      role: 'decision_router',
      description: 'Classifies an unassigned task into one or more execution roles.',
      candidates: [
        {
          rank: 1,
          model: 'claude-haiku-5-5',
          harness: 'claude-code',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
        {
          rank: 2,
          model: 'claude-sonnet-5-5',
          harness: 'claude-code',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
      ],
    },
    implementation: {
      role: 'implementation',
      description: 'Changes application or library source code and tests.',
      candidates: [
        {
          rank: 1,
          model: 'claude-opus-5-5',
          harness: 'claude-code',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
        {
          rank: 2,
          model: 'gpt-5.6-luna',
          harness: 'codex',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
        {
          rank: 3,
          model: 'future-implementation-model',
          harness: 'future-harness',
          dispatchable: false,
          mcp_required: true,
          reason_if_unavailable: 'adapter_not_verified',
        },
      ],
    },
    verification: {
      role: 'verification',
      description: 'Runs checks, reproduces failures and reports verification results.',
      candidates: [
        {
          rank: 1,
          model: 'claude-sonnet-5-5',
          harness: 'claude-code',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
        {
          rank: 2,
          model: 'claude-haiku-5-5',
          harness: 'claude-code',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
      ],
    },
    review: {
      role: 'review',
      description: 'Reviews changes for correctness, security and architectural regressions.',
      candidates: [
        {
          rank: 1,
          model: 'claude-opus-5-5',
          harness: 'claude-code',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
        {
          rank: 2,
          model: 'gpt-5.6-luna',
          harness: 'codex',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
      ],
    },
    research: {
      role: 'research',
      description: 'Navigates the repository and produces bounded technical findings.',
      candidates: [
        {
          rank: 1,
          model: 'claude-sonnet-5-5',
          harness: 'claude-code',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
        {
          rank: 2,
          model: 'gpt-5.6-luna',
          harness: 'codex',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
      ],
    },
    docs: {
      role: 'docs',
      description: 'Writes or updates project documentation.',
      candidates: [
        {
          rank: 1,
          model: 'claude-sonnet-5-5',
          harness: 'claude-code',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
        {
          rank: 2,
          model: 'claude-haiku-5-5',
          harness: 'claude-code',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
      ],
    },
    chore: {
      role: 'chore',
      description: 'Performs small mechanical maintenance changes.',
      candidates: [
        {
          rank: 1,
          model: 'claude-haiku-5-5',
          harness: 'claude-code',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
        {
          rank: 2,
          model: 'claude-sonnet-5-5',
          harness: 'claude-code',
          dispatchable: true,
          mcp_required: true,
          reason_if_unavailable: null,
        },
      ],
    },
  },
};

export function roleRegistryRoles(registry: RoleRegistry = ROLE_REGISTRY_SOURCE): ReadonlySet<string> {
  return new Set([...Object.keys(registry.roles), ...Object.keys(registry.aliases)]);
}

/** A role as the registry spells it: its canonical name, an alias, or null when unknown. */
export function canonicalRole(role: string, registry: RoleRegistry = ROLE_REGISTRY_SOURCE): string | null {
  const trimmed = role.trim();
  if (!trimmed) return null;
  for (const key of [trimmed, trimmed.toLowerCase()]) {
    if (registry.roles[key]) return key;
    const target = registry.aliases[key];
    if (target) return target;
  }
  return null;
}

/**
 * Friday's canonical candidates plus a project's own (`routing.role_candidates`). A project may
 * append candidates to a declared role; it may not invent a role or renumber Friday's ranks. An
 * omitted rank is appended after the role's highest shipped rank.
 */
export function withProjectRoleCandidates(
  base: RoleRegistry,
  extensions: Readonly<Record<string, readonly ProjectRoleCandidate[]>>,
): RoleRegistry {
  const roles: Record<string, RoleRegistryRole> = { ...base.roles };
  for (const [name, projectCandidates] of Object.entries(extensions)) {
    const role = canonicalRole(name, base);
    if (!role) throw new Error(`project role candidates name unknown role "${name}"`);
    if (!projectCandidates.length) continue;
    const definition = roles[role];
    if (!definition) throw new Error(`project role candidates name unknown role "${name}"`);
    let nextRank = Math.max(0, ...definition.candidates.map((candidate) => candidate.rank)) + 1;
    const added: RoleRegistryCandidate[] = projectCandidates.map((candidate) => ({
      rank: candidate.rank ?? nextRank++,
      model: candidate.model,
      harness: candidate.harness,
      dispatchable: candidate.dispatchable ?? true,
      mcp_required: candidate.mcp_required ?? false,
      reason_if_unavailable: candidate.reason_if_unavailable ?? null,
    }));
    roles[role] = {
      ...definition,
      candidates: [...definition.candidates, ...added].sort((a, b) => a.rank - b.rank),
    };
  }
  return { ...base, roles };
}

export function validateRoleRegistry(registry: RoleRegistry, models: readonly ModelRecord[]): void {
  const known = new Set(models.map((model) => model.id));
  for (const [alias, target] of Object.entries(registry.aliases)) {
    if (registry.roles[alias]) throw new Error(`role alias "${alias}" shadows a canonical role`);
    if (!registry.roles[target]) throw new Error(`role alias "${alias}" targets unknown role "${target}"`);
  }
  for (const [role, definition] of Object.entries(registry.roles)) {
    if (role !== definition.role) throw new Error(`role registry key does not match role "${role}"`);
    const ranks = definition.candidates.map((candidate) => candidate.rank);
    if (new Set(ranks).size !== ranks.length) throw new Error(`role ${role} has duplicate candidate ranks`);
    if (ranks.some((rank) => !Number.isInteger(rank) || rank < 1))
      throw new Error(`role ${role} has an invalid candidate rank`);
    if (!definition.candidates.length) throw new Error(`role ${role} has no candidates`);
    for (const candidate of definition.candidates) {
      if (!known.has(candidate.model) && candidate.dispatchable) {
        throw new Error(`role ${role} dispatches unknown model "${candidate.model}"`);
      }
      if (!candidate.dispatchable && !candidate.reason_if_unavailable) {
        throw new Error(`role ${role} declares a non-dispatchable candidate without a reason`);
      }
    }
  }
}

export function generatedRegistryView(registry: RoleRegistry = ROLE_REGISTRY_SOURCE): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}
