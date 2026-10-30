import { type ReadinessAssessment, readinessReasonCode } from './readiness.js';
import type { ModelRecord } from './registry.js';
import { canonicalRole, ROLE_REGISTRY_SOURCE, type RoleRegistry, type RoleRegistryCandidate } from './role-registry.js';
import { type RoutingRoleSource, resolveTaskRole } from './roles.js';

/**
 * The routing decision (spec Part 08 §7, §11; ADR-0031's 2026-10-21 amendment): pure and
 * deterministic. The static role registry is the only dispatch authority. Human pins and hard
 * constraints still come first, and a task whose role is unresolved or proposed as a DAG never
 * dispatches on a guess.
 */

export interface RoutingSettings {
  must_use_local: boolean;
  /** Task kinds and roles whose work is secret-sensitive: only a human-pinned local model. */
  sensitive: { kinds: string[]; roles: string[] };
}

export const DEFAULT_ROUTING: RoutingSettings = {
  must_use_local: false,
  sensitive: { kinds: [], roles: [] },
};

/** A human's routing policy: a model for a scope, with its source and expiry. */
export interface RoutingPin {
  pin_id: string;
  scope: 'project' | 'kind' | 'role' | 'task';
  /** The kind, role or task id; null for the project. */
  target: string | null;
  model: string | null;
  sensitive: boolean;
  needs_vision: boolean;
  until: string | null;
  source: string;
  note: string | null;
}

export interface RouteInput {
  task: {
    task_id: string;
    kind: string;
    role: string | null;
    /** The persisted role contract (R2); absent on records older than it. */
    role_source?: string | null;
    role_confidence?: number | null;
    role_decision_id?: string | null;
    role_intent_version?: string | null;
    role_registry_version?: string | null;
    summary: string;
    description?: string | null;
    acceptance_criteria?: readonly string[];
    risk_level: 'low' | 'medium' | 'high' | null | undefined;
    scope: { write: readonly string[]; read: readonly string[] } | null | undefined;
  };
  /** The vendor of the harness that will run it; null for a dry run over every model. */
  vendor: string | null;
  /** The models the harness says it can run; null: the registry's vendors decide. */
  harness_models: readonly string[] | null;
  /** `set`: the harness applies the model it is given (spawn adapters); `none`: advice only. */
  model_control: 'set' | 'none';
  /**
   * The model the harness reports running (an attached session at its start), if any: an advisory
   * host meets a hard constraint only when it is seen running a model that does (review F01).
   */
  observed_model?: string | null;
  models: readonly ModelRecord[];
  settings: RoutingSettings;
  /** Active pins (not expired, not revoked). */
  pins: readonly RoutingPin[];
  /** The static role registry; defaults to Friday's shipped registry. */
  role_registry?: RoleRegistry;
  /** A role already assigned by the plan or a validated decision-model result. */
  resolved_role?: string | null;
  /**
   * What Friday has observed of a host and model on this machine (ADR-0035 §1); unset: no
   * readiness filter (a pure decision, as in tests of the registry alone).
   */
  readiness?: (host: string, model: string) => ReadinessAssessment | null;
}

/** One readiness check routing made, for the receipt and `routing explain` (ADR-0035 §2). */
export interface ReadinessCheck {
  host: string;
  model: string;
  dispatchable: boolean;
  reason: string;
  bench_until: string | null;
}

export interface Candidate {
  model: string;
  /** Registry preference: 1 for rank 1, 0.5 for rank 2, and so on. Not a capability score. */
  score: number;
  /** The same registry preference, kept for delegation's fit arithmetic. */
  fit: number;
  /** No measured outcome changes dispatch; evidence is reported, not scored. */
  pass_rate: number | null;
  samples: number;
  cost: number | null;
  reasons: string[];
}

export interface RoutingDecision {
  /** The dispatch mode: registry is the only one. */
  mode: 'registry';
  task_class: string;
  model: string | null;
  /** The harness applies it (true) or may ignore it (false). */
  binding: boolean;
  /**
   * The work must not start here: a pinned model that cannot run, a hard constraint no runnable
   * model meets, an unsupported or unresolved role, or an advisory host not seen running a model
   * that meets the constraints.
   */
  blocked: boolean;
  source: 'pin' | 'registry' | 'none';
  reason: string;
  reason_codes: string[];
  candidates: Candidate[];
  excluded: { model: string; reason: string }[];
  constraints: string[];
  fallback_chain: { model: string | null; reason: string }[];
  confidence: number | null;
  pin_id: string | null;
  role: string | null;
  role_source: RoutingRoleSource;
  role_confidence: number | null;
  role_decision_id: string | null;
  role_intent_version: string | null;
  role_registry_version: string | null;
  /** The role decision model returned a multi-role DAG instead of one role (R2). */
  role_proposed: boolean;
  registry_version: string | null;
  selected_rank: number | null;
  selected_harness: string | null;
  decision_model: string | null;
  decision_confidence: number | null;
  failover_policy: 'host_failure' | 'none';
  /** The readiness checks made, in the order made (ADR-0035 §2); empty without a readiness source. */
  readiness: ReadinessCheck[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const SPECIFICITY: Record<RoutingPin['scope'], number> = { task: 3, role: 2, kind: 1, project: 0 };

/** The pins that apply to a task, most specific first. */
export function applicablePins(
  pins: readonly RoutingPin[],
  task: Pick<RouteInput['task'], 'task_id' | 'kind' | 'role'>,
  resolvedRole: string | null = task.role,
): RoutingPin[] {
  return pins
    .filter(
      (p) =>
        p.scope === 'project' ||
        (p.scope === 'task' && p.target === task.task_id) ||
        (p.scope === 'kind' && p.target === task.kind) ||
        (p.scope === 'role' &&
          ((task.role !== null && p.target === task.role) || (resolvedRole !== null && p.target === resolvedRole))),
    )
    .sort((a, b) => SPECIFICITY[b.scope] - SPECIFICITY[a.scope]);
}

export function decideRoute(input: RouteInput): RoutingDecision {
  const { task, settings } = input;
  const registry = input.role_registry ?? ROLE_REGISTRY_SOURCE;
  const resolved = resolveTaskRole({
    task,
    registry,
    resolvedRole: input.resolved_role ?? null,
  });
  const role = resolved.role;
  const roleSource = resolved.source;
  const pins = applicablePins(input.pins, task, role);
  const task_class = role ?? task.kind;

  const pinModel = pins.find((p) => p.model);
  const sensitive =
    settings.sensitive.kinds.includes(task.kind) ||
    (task.role !== null && settings.sensitive.roles.includes(task.role)) ||
    (role !== null && settings.sensitive.roles.includes(role)) ||
    pins.some((p) => p.sensitive);
  const needsVision = pins.some((p) => p.needs_vision);

  const constraints: string[] = [];
  const excluded: RoutingDecision['excluded'] = [];
  const codes: string[] = [];
  if (roleSource === 'kind_fallback') codes.push('role.kind_fallback');
  if (roleSource === 'path_fallback') codes.push('role.path_fallback');
  if (roleSource === 'plan') codes.push('role.plan');
  if (roleSource === 'human') codes.push('role.human');

  const exclude = (model: string, reason: string): void => {
    const at = excluded.findIndex((entry) => entry.model === model);
    if (at >= 0) excluded.splice(at, 1);
    excluded.push({ model, reason });
  };
  // Readiness filters candidates after the hard constraints and before rank (ADR-0035 §2): the
  // host that runs the work, or the candidate's own host for a dry run.
  const readinessChecks: ReadinessCheck[] = [];
  const ready = (host: string, model: string): ReadinessAssessment | null => {
    const a = input.readiness?.(host, model) ?? null;
    if (a) {
      readinessChecks.push({ host, model, dispatchable: a.dispatchable, reason: a.reason, bench_until: a.bench_until });
    }
    return a;
  };

  // What the harness can run: its own list, else the registry's vendors.
  const known = new Map(input.models.map((m) => [m.id, m]));
  const runnable: ModelRecord[] = [];
  if (input.harness_models) {
    for (const id of input.harness_models) {
      runnable.push(
        known.get(id) ?? {
          id,
          provider: 'unknown',
          vendors: input.vendor ? [input.vendor] : [],
          vision: false,
          local: false,
          context_tokens: null,
          price: null,
          latency_ms: null,
          cost_class: null,
          capabilities: {},
          notes: 'declared by the harness; not in the registry',
          source: 'project',
        },
      );
    }
    for (const m of input.models) {
      if (!input.harness_models.includes(m.id)) exclude(m.id, 'harness.cannot_run');
    }
  } else {
    for (const m of input.models) {
      if (input.vendor === null || m.vendors.includes(input.vendor)) runnable.push(m);
      else exclude(m.id, 'harness.cannot_run');
    }
  }
  const runnableIds = new Set(runnable.map((m) => m.id));

  // Hard constraints (spec Part 08 §11): always before registry rank.
  let eligible = runnable;
  if (settings.must_use_local) {
    constraints.push('must_use_local');
    for (const m of eligible.filter((x) => !x.local)) exclude(m.id, 'constraint.must_use_local');
    eligible = eligible.filter((m) => m.local);
  }
  if (needsVision) {
    constraints.push('vision');
    for (const m of eligible.filter((x) => !x.vision)) exclude(m.id, 'constraint.vision');
    eligible = eligible.filter((m) => m.vision);
  }
  // Secret-sensitive work runs only on a local model a human pinned for it (spec Part 08 §11).
  if (sensitive) {
    constraints.push('sensitive');
    for (const m of eligible.filter((x) => !x.local)) exclude(m.id, 'constraint.sensitive_local');
    eligible = eligible.filter((m) => m.local);
  }
  const constrained = eligible;

  const binding = input.model_control === 'set';
  const observed = input.observed_model ?? null;
  const assemble = (
    model: string | null,
    source: RoutingDecision['source'],
    reason: string,
    extra: Partial<RoutingDecision> = {},
  ): RoutingDecision => ({
    mode: 'registry',
    task_class,
    model,
    binding: model !== null && binding,
    blocked: false,
    source,
    reason: model && !binding ? `${reason}; advisory: this session's host chooses its own model` : reason,
    reason_codes: [...codes],
    candidates: [],
    excluded: [...excluded],
    constraints: [...constraints],
    fallback_chain: [],
    confidence: null,
    pin_id: null,
    role,
    role_source: roleSource,
    role_confidence: resolved.confidence,
    role_decision_id: resolved.decision_id,
    role_intent_version: resolved.intent_version,
    role_registry_version: resolved.registry_version ?? registry.version,
    role_proposed:
      resolved.proposed_roles.length > 1 ||
      (roleSource === 'decision_model' && role === null && resolved.decision_id !== null),
    registry_version: registry.version,
    selected_rank: null,
    selected_harness: null,
    decision_model: null,
    decision_confidence: null,
    failover_policy: model === null ? 'none' : 'host_failure',
    readiness: [...readinessChecks],
    ...extra,
  });
  /**
   * A host that chooses its own model meets a hard constraint only when it is seen running a model
   * that does; otherwise the work does not start there (review F01).
   */
  const result = (...args: Parameters<typeof assemble>): RoutingDecision => {
    const d = assemble(...args);
    if (d.blocked || d.model === null || binding || !constraints.length) return d;
    const meets = observed !== null && (sensitive ? observed === d.model : constrained.some((m) => m.id === observed));
    if (meets && observed !== null) {
      return observed === d.model
        ? d
        : {
            ...d,
            model: observed,
            reason: `${observed}, which this session runs and which meets ${constraints.join(', ')}`,
          };
    }
    return {
      ...d,
      model: null,
      binding: false,
      blocked: true,
      source: 'none',
      failover_policy: 'none',
      reason_codes: [...d.reason_codes, 'advisory.unverified'],
      reason: `${constraints.join(', ')} must hold, but this session's host chooses its own model and ${observed ? `reports ${observed}, which does not meet them` : 'has not reported one'}; ${sensitive ? `run it where ${d.model} is applied, ` : ''}a human decides`,
    };
  };
  const blocked = (reason: string, extra: Partial<RoutingDecision> = {}) =>
    assemble(null, 'none', reason, { ...extra, blocked: true, failover_policy: 'none' });

  // A task whose persisted role resolution is blocked or still a proposed multi-role DAG does not
  // dispatch on a guess, pinned or not: choosing a model is no approval of a split (review
  // 2026-10-22 R3, which found a project pin returning before this check).
  if (!role) {
    if (roleSource === 'decision_model') {
      codes.push('role.proposed_dag');
      return blocked(resolved.reason);
    }
    if (roleSource === 'missing' && resolved.decision_id) {
      codes.push('role.classification_required');
      return blocked(resolved.reason);
    }
    codes.push('role.missing');
    return blocked('role classification is required before static registry dispatch; clarification is required');
  }

  // A human's pinned model is never silently replaced. Sensitive work takes only a pin made for it:
  // a general pin is no consent.
  const chosen = sensitive ? pins.find((p) => p.model && p.sensitive) : pinModel;
  const wanted = chosen?.model ?? null;
  if (wanted) {
    const pin_id = chosen?.pin_id ?? null;
    const why = excluded.find((e) => e.model === wanted)?.reason;
    // A pinned model still needs a ready host (ADR-0035 §2): the harness that runs the work, or on
    // a dry run any host the registry says runs the model. A model no host runs is not checked.
    if (eligible.some((m) => m.id === wanted)) {
      const hosts = input.vendor ? [input.vendor] : (known.get(wanted)?.vendors ?? []);
      const checks = hosts.map((h) => ready(h, wanted)).filter((a): a is ReadinessAssessment => a !== null);
      const unready = checks.length > 0 && !checks.some((a) => a.dispatchable) ? checks : [];
      if (unready.length) {
        const first = unready[0] as ReadinessAssessment;
        codes.push('pin.unavailable', readinessReasonCode(first));
        exclude(wanted, readinessReasonCode(first));
        return blocked(`${wanted} is pinned, but ${unready.map((a) => a.reason).join('; ')}; a human decides`, {
          pin_id,
        });
      }
    }
    if (eligible.some((m) => m.id === wanted)) {
      codes.push(chosen ? `pin.${chosen.scope}` : 'pin');
      return result(
        wanted,
        'pin',
        chosen
          ? `${wanted}, pinned by ${chosen.source}${chosen.until ? ` until ${chosen.until}` : ''}`
          : `${wanted}, pinned`,
        { pin_id },
      );
    }
    codes.push('pin.unavailable');
    return blocked(`${wanted} is pinned but cannot run here (${why ?? 'not in the registry'}); a human decides`, {
      pin_id,
    });
  }
  if (sensitive) {
    codes.push('constraint.sensitive');
    return blocked(
      'sensitive work runs only on a local model a human pinned for it ("friday routing pin --sensitive --model <local model>")',
    );
  }

  const registryRole = canonicalRole(role, registry);
  const definition = registryRole ? registry.roles[registryRole] : undefined;
  if (!registryRole || !definition) {
    codes.push('role.unsupported');
    return blocked(`role "${role}" is not declared in the static role registry`);
  }

  const registryCandidates = [...definition.candidates].sort((a, b) => a.rank - b.rank);
  const selected: { candidate: RoleRegistryCandidate; row: Candidate }[] = [];
  for (const candidate of registryCandidates) {
    if (!candidate.declared_dispatchable) {
      exclude(candidate.model, candidate.reason_if_unavailable ?? 'registry.not_dispatchable');
      continue;
    }
    if (
      input.vendor !== null &&
      candidate.harness !== input.vendor &&
      !(input.harness_models?.includes(candidate.model) ?? false)
    ) {
      exclude(candidate.model, `registry.harness.${candidate.harness}`);
      continue;
    }
    if (input.harness_models && !input.harness_models.includes(candidate.model)) {
      exclude(candidate.model, 'harness.cannot_run');
      continue;
    }
    const model = known.get(candidate.model);
    if (!model) {
      exclude(candidate.model, 'registry.model_unknown');
      continue;
    }
    if (!runnableIds.has(candidate.model)) {
      exclude(candidate.model, 'harness.cannot_run');
      continue;
    }
    if (settings.must_use_local && !model.local) {
      exclude(candidate.model, 'constraint.must_use_local');
      continue;
    }
    if (needsVision && !model.vision) {
      exclude(candidate.model, 'constraint.vision');
      continue;
    }
    if (sensitive && !model.local) {
      exclude(candidate.model, 'constraint.sensitive_local');
      continue;
    }
    const readiness = ready(input.vendor ?? candidate.harness, candidate.model);
    if (readiness && !readiness.dispatchable) {
      exclude(candidate.model, readinessReasonCode(readiness));
      continue;
    }
    const preference = round(1 / candidate.rank);
    selected.push({
      candidate,
      row: {
        model: candidate.model,
        score: preference,
        fit: preference,
        pass_rate: null,
        samples: 0,
        cost: null,
        reasons: [`registry.rank(${candidate.rank})`, `registry.harness(${candidate.harness})`],
      },
    });
  }
  if (!selected.length) {
    codes.push('registry.none_eligible');
    const unready = readinessChecks.filter((c) => !c.dispatchable);
    if (unready.length) codes.push('readiness.none_ready');
    return blocked(
      `no dispatchable candidate for role "${role}" on this harness${constraints.length ? ` while ${constraints.join(', ')} must hold` : ''}${unready.length ? `; not ready: ${unready.map((c) => c.reason).join('; ')}` : ''}`,
      { candidates: [] },
    );
  }
  const first = selected[0] as (typeof selected)[number];
  codes.push('registry.rank');
  return result(
    first.row.model,
    'registry',
    `${first.row.model}, rank ${first.candidate.rank} for role ${role}${registryRole !== role ? ` (${registryRole})` : ''}`,
    {
      candidates: selected.map((entry) => entry.row),
      fallback_chain: [
        ...selected.slice(1).map((entry) => ({ model: entry.row.model, reason: 'registry.rank.next' })),
        { model: null, reason: 'human' },
      ],
      selected_rank: first.candidate.rank,
      selected_harness: first.candidate.harness,
    },
  );
}
