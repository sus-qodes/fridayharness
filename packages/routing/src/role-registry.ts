import type { ModelRecord } from './registry.js';

/**
 * What a candidate needs before it may be dispatched. These are requirements, never observations:
 * the static registry does not claim that a host, model or MCP server is available now. Runtime
 * readiness (a later slice) answers that question from installed/configured/authenticated state.
 */
export interface RoleCandidateRequirements {
  mcp_required: boolean;
  auth_required: boolean;
  host_verified: boolean;
  model_verified: boolean;
  mcp_verified: boolean;
}

/** Where a candidate's cost information comes from. No cost value is claimed here. */
export interface RoleCandidateCostProvenance {
  source: string;
  /** YYYY-MM-DD. */
  observed_at: string;
}

/** A benchmark claim and the evidence that supports it; null means no benchmark claim is made. */
export interface RoleCandidateBenchmarkProvenance {
  source: string;
  metric: string;
  value: number;
  /** YYYY-MM-DD. */
  measured_at: string;
  samples: number;
}

export interface RoleRegistryCandidate {
  rank: number;
  model: string;
  harness: string;
  /**
   * Friday ships this candidate as dispatchable once readiness allows it. It is not a claim that
   * the host, credentials, MCP connection or model are available on this machine now.
   */
  declared_dispatchable: boolean;
  reason_if_unavailable: string | null;
  requirements: RoleCandidateRequirements;
  /** The last time a human reviewed this declaration and its sources; null when never reviewed. */
  last_checked: string | null;
  cost: RoleCandidateCostProvenance | null;
  benchmark: RoleCandidateBenchmarkProvenance | null;
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
  declared_dispatchable?: boolean;
  reason_if_unavailable?: string | null;
  requirements?: Partial<RoleCandidateRequirements>;
  last_checked?: string | null;
  cost?: RoleCandidateCostProvenance | null;
  benchmark?: RoleCandidateBenchmarkProvenance | null;
}

/**
 * Friday knows how to reach these harnesses. Unknown names may still appear on a candidate that is
 * declared non-dispatchable (a future adapter); they may not be dispatched.
 */
export const KNOWN_HARNESSES: ReadonlySet<string> = new Set([
  'claude-code',
  'codex',
  'cursor',
  'antigravity',
  'gemini',
  'opencode',
  'october',
  'generic',
]);

const REGISTRY_CHECKED_AT = '2026-10-21';
const DEFAULT_REQUIREMENTS: RoleCandidateRequirements = {
  mcp_required: true,
  auth_required: true,
  host_verified: true,
  model_verified: true,
  mcp_verified: true,
};

interface CandidateOptions {
  declared_dispatchable?: boolean;
  reason_if_unavailable?: string | null;
  requirements?: Partial<RoleCandidateRequirements>;
  last_checked?: string | null;
  cost?: RoleCandidateCostProvenance | null;
  benchmark?: RoleCandidateBenchmarkProvenance | null;
}

function candidate(
  rank: number,
  model: string,
  harness: string,
  options: CandidateOptions = {},
): RoleRegistryCandidate {
  return {
    rank,
    model,
    harness,
    declared_dispatchable: options.declared_dispatchable ?? true,
    reason_if_unavailable: options.reason_if_unavailable ?? null,
    requirements: { ...DEFAULT_REQUIREMENTS, ...options.requirements },
    last_checked: options.last_checked === undefined ? REGISTRY_CHECKED_AT : options.last_checked,
    cost: options.cost ?? null,
    benchmark: options.benchmark ?? null,
  };
}

/** Prices and benchmark notes come from the owner's cost table (2026-10-21). */
const HANDOFF_COST: RoleCandidateCostProvenance = {
  source: 'Friday registry cost table (2026-10-21)',
  observed_at: '2026-10-21',
};
/** The decision router classifies roles; it reads no code graph, so it needs no MCP connection. */
const NO_MCP: Partial<RoleCandidateRequirements> = { mcp_required: false, mcp_verified: false };
/** DeepSeek Harness has no Friday adapter yet: its entries keep their rank and wait for one. */
const DEEPSEEK: CandidateOptions = {
  declared_dispatchable: false,
  reason_if_unavailable: 'adapter_not_implemented',
  last_checked: null,
  cost: HANDOFF_COST,
};
const ranked = (rank: number, model: string, harness: string, options: CandidateOptions = {}) =>
  candidate(rank, model, harness, { cost: HANDOFF_COST, ...options });

/**
 * Typed canonical role registry: the owner's static ranking, in the
 * owner's order. It is the same on every machine. What a machine has installed, configured and
 * signed in to only filters the list at dispatch time; it never reorders it, so a host someone
 * lacks is skipped and everyone else keeps their place. Handoff harness names map to Friday's:
 * claude_code_cli → claude-code, codex_cli → codex, gemini_cli → gemini, opencode_cli → opencode,
 * cursor_ide → cursor (always the headless `cursor-agent`), deepseek_harness → deepseek.
 *
 * Friday's own task kinds (implementation, research, docs, chore) are aliases of these roles, so
 * no ranking exists that the owner did not write.
 */
export const ROLE_REGISTRY_SOURCE: RoleRegistry = {
  version: '2026-10-21.4',
  aliases: {
    classifier: 'decision_router',
    router: 'decision_router',
    architect: 'system_architect',
    'system-architect': 'system_architect',
    architecture: 'system_architect',
    research: 'system_architect',
    investigate: 'system_architect',
    backend: 'backend_engineer',
    'backend-engineer': 'backend_engineer',
    implementation: 'backend_engineer',
    developer: 'backend_engineer',
    dev: 'backend_engineer',
    engineer: 'backend_engineer',
    docs: 'backend_engineer',
    documentation: 'backend_engineer',
    doc: 'backend_engineer',
    frontend: 'frontend_engineer',
    'frontend-engineer': 'frontend_engineer',
    ui: 'frontend_engineer',
    web: 'frontend_engineer',
    qa: 'qa_and_debugging',
    test: 'qa_and_debugging',
    tester: 'qa_and_debugging',
    testing: 'qa_and_debugging',
    verification: 'qa_and_debugging',
    debugger: 'qa_and_debugging',
    devops: 'devops_and_terminal',
    ops: 'devops_and_terminal',
    infrastructure: 'devops_and_terminal',
    infra: 'devops_and_terminal',
    terminal: 'devops_and_terminal',
    chore: 'devops_and_terminal',
    maintenance: 'devops_and_terminal',
    review: 'code_reviewer_and_security',
    reviewer: 'code_reviewer_and_security',
    security: 'code_reviewer_and_security',
    'security-reviewer': 'code_reviewer_and_security',
  },
  roles: {
    decision_router: {
      role: 'decision_router',
      description: 'Classifies unassigned work into execution roles; it never chooses a model or harness.',
      candidates: [
        ranked(1, 'anthropic/claude-haiku-5.5', 'opencode', { requirements: NO_MCP }),
        ranked(2, 'openai/gpt-6-luna', 'codex', { requirements: NO_MCP }),
        ranked(3, 'deepseek/deepseek-v4.1-flash-1017', 'deepseek', { ...DEEPSEEK, requirements: NO_MCP }),
      ],
    },
    system_architect: {
      role: 'system_architect',
      description: 'Bounds system architecture, interfaces, trade-offs and migration plans; investigates code.',
      candidates: [
        ranked(1, 'claude-opus-5-5', 'claude-code'),
        ranked(2, 'claude-fable-5-1', 'claude-code'),
        ranked(3, 'openai/gpt-6-astra', 'codex'),
        ranked(4, 'anthropic/claude-opus-5.5', 'opencode'),
      ],
    },
    backend_engineer: {
      role: 'backend_engineer',
      description: 'Changes server, API, data-path, library and general application code, with its tests and docs.',
      candidates: [
        ranked(1, 'claude-sonnet-5-5', 'claude-code'),
        ranked(2, 'claude-opus-5-5', 'cursor'),
        ranked(3, 'deepseek-flash', 'deepseek', DEEPSEEK),
        ranked(4, 'openai/gpt-6.1-sol', 'codex'),
        ranked(5, 'z-ai/glm-5.3', 'opencode'),
      ],
    },
    frontend_engineer: {
      role: 'frontend_engineer',
      description: 'Changes browser, client and user-interface code, with its tests.',
      candidates: [
        ranked(1, 'gemini-4-argon', 'cursor'),
        ranked(2, 'claude-sonnet-5-5', 'cursor'),
        ranked(3, 'gemini-4-argon', 'gemini'),
        ranked(4, 'claude-opus-5-5', 'claude-code'),
      ],
    },
    qa_and_debugging: {
      role: 'qa_and_debugging',
      description: 'Reproduces failures, runs checks and investigates defects in bounded scope.',
      candidates: [
        ranked(1, 'claude-sonnet-5-5', 'claude-code'),
        ranked(2, 'openai/gpt-6.1-sol', 'codex'),
        ranked(3, 'openai/gpt-6-astra', 'codex'),
        ranked(4, 'deepseek-flash', 'deepseek', DEEPSEEK),
      ],
    },
    devops_and_terminal: {
      role: 'devops_and_terminal',
      description: 'Changes build, CI, deployment, environment, configuration and terminal automation.',
      candidates: [
        ranked(1, 'gemini-3.8-flash', 'gemini'),
        ranked(2, 'openai/gpt-6.1-sol', 'codex'),
        ranked(3, 'claude-opus-5-5', 'claude-code'),
        ranked(4, 'deepseek/deepseek-v4.1-flash-1017', 'opencode'),
      ],
    },
    code_reviewer_and_security: {
      role: 'code_reviewer_and_security',
      description: 'Reviews correctness, security, permissions and architectural regressions.',
      candidates: [
        ranked(1, 'claude-opus-5-5', 'claude-code'),
        ranked(2, 'claude-sonnet-5-5', 'cursor'),
        ranked(3, 'gemini-4-argon', 'gemini'),
        ranked(4, 'z-ai/glm-5.3', 'opencode'),
      ],
    },
  },
};

/** The canonical roles a decision may report. Aliases are input spellings, not decision output. */
export function roleRegistryRoles(registry: RoleRegistry = ROLE_REGISTRY_SOURCE): ReadonlySet<string> {
  return new Set(Object.keys(registry.roles));
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

function projectCandidate(candidate: ProjectRoleCandidate, defaultRank: number): RoleRegistryCandidate {
  const requirements = candidate.requirements ?? {};
  return {
    rank: candidate.rank ?? defaultRank,
    model: candidate.model,
    harness: candidate.harness,
    declared_dispatchable: candidate.declared_dispatchable ?? true,
    reason_if_unavailable: candidate.reason_if_unavailable ?? null,
    requirements: {
      mcp_required: requirements.mcp_required ?? false,
      auth_required: requirements.auth_required ?? false,
      host_verified: requirements.host_verified ?? true,
      model_verified: requirements.model_verified ?? true,
      mcp_verified: requirements.mcp_verified ?? false,
    },
    last_checked: candidate.last_checked ?? null,
    cost: candidate.cost ?? null,
    benchmark: candidate.benchmark ?? null,
  };
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
    const added = projectCandidates.map((entry) => projectCandidate(entry, nextRank++));
    roles[role] = {
      ...definition,
      candidates: [...definition.candidates, ...added].sort((a, b) => a.rank - b.rank),
    };
  }
  return { ...base, roles };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value: string): boolean => ISO_DATE.test(value);

export function validateRoleRegistry(registry: RoleRegistry, models: readonly ModelRecord[]): void {
  const knownModels = new Set(models.map((model) => model.id));
  const names = new Map<string, string>();
  for (const role of Object.keys(registry.roles)) names.set(role.toLowerCase(), `role ${role}`);
  for (const [alias, target] of Object.entries(registry.aliases)) {
    if (registry.roles[alias]) throw new Error(`role alias "${alias}" shadows a canonical role`);
    if (!registry.roles[target]) throw new Error(`role alias "${alias}" targets unknown role "${target}"`);
    const lower = alias.toLowerCase();
    const collision = names.get(lower);
    if (collision) throw new Error(`role alias "${alias}" collides with ${collision}`);
    names.set(lower, `alias ${alias}`);
  }
  for (const [role, definition] of Object.entries(registry.roles)) {
    if (role !== definition.role) throw new Error(`role registry key does not match role "${role}"`);
    if (!definition.description.trim()) throw new Error(`role ${role} has no description`);
    if (!definition.candidates.length) throw new Error(`role ${role} has no candidates`);
    const ranks = definition.candidates.map((candidate) => candidate.rank);
    if (new Set(ranks).size !== ranks.length) throw new Error(`role ${role} has duplicate candidate ranks`);
    if (ranks.some((rank) => !Number.isInteger(rank) || rank < 1))
      throw new Error(`role ${role} has an invalid candidate rank`);
    for (let index = 1; index < ranks.length; index += 1) {
      if ((ranks[index] as number) < (ranks[index - 1] as number)) {
        throw new Error(`role ${role} has candidates out of rank order`);
      }
    }
    for (const candidate of definition.candidates) {
      if (!candidate.model.trim() || !candidate.harness.trim()) {
        throw new Error(`role ${role} has a candidate with an empty model or harness`);
      }
      if (candidate.declared_dispatchable) {
        if (!knownModels.has(candidate.model)) {
          throw new Error(`role ${role} dispatches unknown model "${candidate.model}"`);
        }
        if (!KNOWN_HARNESSES.has(candidate.harness)) {
          throw new Error(`role ${role} dispatches unknown harness "${candidate.harness}"`);
        }
        const requirements = candidate.requirements;
        if (
          !requirements ||
          typeof requirements.mcp_required !== 'boolean' ||
          typeof requirements.auth_required !== 'boolean' ||
          typeof requirements.host_verified !== 'boolean' ||
          typeof requirements.model_verified !== 'boolean' ||
          typeof requirements.mcp_verified !== 'boolean'
        ) {
          throw new Error(
            `role ${role} dispatches candidate "${candidate.model}" without complete dispatch requirements`,
          );
        }
        if (candidate.reason_if_unavailable) {
          throw new Error(
            `role ${role} declares candidate "${candidate.model}" dispatchable with an unavailability reason`,
          );
        }
      } else if (!candidate.reason_if_unavailable?.trim()) {
        throw new Error(`role ${role} declares a non-dispatchable candidate without a reason`);
      }
      if (candidate.requirements.mcp_verified && !candidate.requirements.mcp_required) {
        throw new Error(`role ${role} candidate "${candidate.model}" requires MCP verification but not MCP`);
      }
      if (candidate.last_checked !== null && !isDate(candidate.last_checked)) {
        throw new Error(`role ${role} candidate "${candidate.model}" has an invalid last_checked date`);
      }
      if (candidate.cost && (!candidate.cost.source.trim() || !isDate(candidate.cost.observed_at))) {
        throw new Error(`role ${role} candidate "${candidate.model}" has invalid cost provenance`);
      }
      if (candidate.benchmark) {
        const benchmark = candidate.benchmark;
        if (
          !benchmark.source.trim() ||
          !benchmark.metric.trim() ||
          !Number.isFinite(benchmark.value) ||
          !isDate(benchmark.measured_at) ||
          !Number.isInteger(benchmark.samples) ||
          benchmark.samples < 1
        ) {
          throw new Error(`role ${role} candidate "${candidate.model}" has invalid benchmark provenance`);
        }
      }
    }
  }
}

export function generatedRegistryView(registry: RoleRegistry = ROLE_REGISTRY_SOURCE): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}
