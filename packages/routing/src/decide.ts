import type { GuideClass, ModelRecord } from './registry.js';
import { REQUIREMENTS_VERSION, type Requirements, requirementsFor } from './requirements.js';

/**
 * The routing decision (spec Part 08 §7, §11–§12; ADR-0031 §4–§5): pure and deterministic, so the
 * same records always route the same way. Human pins and hard constraints come first; then the
 * guide, measured evidence and Laya's calibrated answer, by mode; then the fallback chain.
 */

export type RoutingMode = 'manual' | 'policy' | 'auto' | 'hybrid';
export type Optimize = 'quality' | 'balanced' | 'cost' | 'latency';
export type LowConfidence = 'score' | 'strongest' | 'human' | 'block';

export interface RoutingSettings {
  mode: RoutingMode;
  optimize: Optimize;
  /** The model `manual` mode uses when no pin names one. */
  default_model: string | null;
  must_use_local: boolean;
  prefer_cheaper_if_score_delta_below: number;
  /** What happens when Laya's answer is not confident (spec Part 12 §10). */
  low_confidence: LowConfidence;
  /** Outcomes a model needs for a task class before they count. */
  min_samples: number;
  /** Task kinds and roles whose work is secret-sensitive: only a human-pinned model. */
  sensitive: { kinds: string[]; roles: string[] };
}

export const DEFAULT_ROUTING: RoutingSettings = {
  mode: 'hybrid',
  optimize: 'balanced',
  default_model: null,
  must_use_local: false,
  prefer_cheaper_if_score_delta_below: 0.05,
  low_confidence: 'score',
  min_samples: 5,
  sensitive: { kinds: [], roles: [] },
};

/** A human's routing policy (spec Part 12 §11): a model or a mode for a scope, with its source and expiry. */
export interface RoutingPin {
  pin_id: string;
  scope: 'project' | 'kind' | 'role' | 'task';
  /** The kind, role or task id; null for the project. */
  target: string | null;
  model: string | null;
  mode: RoutingMode | null;
  sensitive: boolean;
  needs_vision: boolean;
  until: string | null;
  source: string;
  note: string | null;
}

/** Measured outcomes of a model for a task class (ADR-0031 §8). */
export interface Evidence {
  model: string;
  task_class: string;
  samples: number;
  passed: number;
}

/** Laya's stored answer to this task's routing question (ADR-0031 §10). */
export interface LayaAnswer {
  question_id: string;
  checkpoint: string;
  choice: string;
  confidence: number;
  /** The fitted threshold for this checkpoint and option count; null: not calibrated. */
  threshold: number | null;
}

export interface RouteInput {
  task: { task_id: string; kind: string; role: string | null };
  /** The vendor of the harness that will run it; null for a dry run over every model. */
  vendor: string | null;
  /** The models the harness says it can run; null: the registry's vendors decide. */
  harness_models: readonly string[] | null;
  /** `set`: the harness applies the model it is given (spawn adapters); `none`: advice only. */
  model_control: 'set' | 'none';
  models: readonly ModelRecord[];
  guide: Readonly<Record<string, GuideClass>>;
  guide_version: string;
  settings: RoutingSettings;
  /** Active pins (not expired, not revoked). */
  pins: readonly RoutingPin[];
  evidence: readonly Evidence[];
  laya: LayaAnswer | null;
}

export interface Candidate {
  model: string;
  score: number;
  fit: number;
  /** Measured pass rate when it counted. */
  pass_rate: number | null;
  samples: number;
  /** Relative cost among the candidates, 0 (cheapest) to 1; null when the price is unknown. */
  cost: number | null;
  reasons: string[];
}

export interface RoutingDecision {
  mode: RoutingMode;
  task_class: string;
  model: string | null;
  /** The harness applies it (true) or may ignore it (false). */
  binding: boolean;
  source: 'pin' | 'manual' | 'laya' | 'score' | 'guide' | 'fallback' | 'none';
  reason: string;
  reason_codes: string[];
  candidates: Candidate[];
  excluded: { model: string; reason: string }[];
  constraints: string[];
  fallback_chain: { model: string | null; reason: string }[];
  confidence: number | null;
  pin_id: string | null;
  requirements_version: string;
  guide_version: string;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const SPECIFICITY: Record<RoutingPin['scope'], number> = { task: 3, role: 2, kind: 1, project: 0 };

/** The pins that apply to a task, most specific first. */
export function applicablePins(pins: readonly RoutingPin[], task: RouteInput['task']): RoutingPin[] {
  return pins
    .filter(
      (p) =>
        p.scope === 'project' ||
        (p.scope === 'task' && p.target === task.task_id) ||
        (p.scope === 'kind' && p.target === task.kind) ||
        (p.scope === 'role' && task.role !== null && p.target === task.role),
    )
    .sort((a, b) => SPECIFICITY[b.scope] - SPECIFICITY[a.scope]);
}

function fitOf(m: ModelRecord, req: Requirements): { fit: number; known: boolean } {
  const entries = Object.entries(req.weights) as [keyof ModelRecord['capabilities'], number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!total) return { fit: 0.5, known: false };
  let known = false;
  let sum = 0;
  for (const [d, w] of entries) {
    const v = m.capabilities[d];
    if (v !== undefined) known = true;
    sum += w * (v ?? 0.5);
  }
  return { fit: sum / total, known };
}

export function decideRoute(input: RouteInput): RoutingDecision {
  const { task, settings } = input;
  const req = requirementsFor(task.kind);
  const pins = applicablePins(input.pins, task);
  const pinModel = pins.find((p) => p.model);
  const pinMode = pins.find((p) => p.mode);
  const mode = pinMode?.mode ?? settings.mode;
  const roleClass = task.role ? `role:${task.role}` : null;
  const task_class = roleClass && input.guide[roleClass] ? roleClass : task.kind;
  const guide = input.guide[task_class] ?? input.guide[task.kind];
  const sensitive =
    settings.sensitive.kinds.includes(task.kind) ||
    (task.role !== null && settings.sensitive.roles.includes(task.role)) ||
    pins.some((p) => p.sensitive);
  const needsVision = req.vision || pins.some((p) => p.needs_vision);
  const constraints: string[] = [];
  const excluded: RoutingDecision['excluded'] = [];
  const codes: string[] = [];

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
          capabilities: {},
          notes: 'declared by the harness; not in the registry',
          source: 'project',
        },
      );
    }
    for (const m of input.models) {
      if (!input.harness_models.includes(m.id)) excluded.push({ model: m.id, reason: 'harness.cannot_run' });
    }
  } else {
    for (const m of input.models) {
      if (input.vendor === null || m.vendors.includes(input.vendor)) runnable.push(m);
      else excluded.push({ model: m.id, reason: 'harness.cannot_run' });
    }
  }

  // Hard constraints (spec Part 08 §11): always before Laya and the score.
  let eligible = runnable;
  if (settings.must_use_local) {
    constraints.push('must_use_local');
    for (const m of eligible.filter((x) => !x.local))
      excluded.push({ model: m.id, reason: 'constraint.must_use_local' });
    eligible = eligible.filter((m) => m.local);
  }
  if (needsVision) {
    constraints.push('vision');
    for (const m of eligible.filter((x) => !x.vision)) excluded.push({ model: m.id, reason: 'constraint.vision' });
    eligible = eligible.filter((m) => m.vision);
  }
  if (sensitive) constraints.push('sensitive');

  const binding = input.model_control === 'set';
  const result = (
    model: string | null,
    source: RoutingDecision['source'],
    reason: string,
    extra: Partial<RoutingDecision> = {},
  ): RoutingDecision => ({
    mode,
    task_class,
    model,
    binding: model !== null && binding,
    source,
    reason: model && !binding ? `${reason}; advisory: this session's host chooses its own model` : reason,
    reason_codes: codes,
    candidates: [],
    excluded,
    constraints,
    fallback_chain: [],
    confidence: null,
    pin_id: null,
    requirements_version: REQUIREMENTS_VERSION,
    guide_version: input.guide_version,
    ...extra,
  });

  // A human's pinned model (or manual mode's default) is never silently replaced.
  const wanted = pinModel?.model ?? (mode === 'manual' ? settings.default_model : null);
  if (wanted) {
    const pin_id = pinModel?.pin_id ?? null;
    const src = pinModel ? 'pin' : 'manual';
    const why = excluded.find((e) => e.model === wanted)?.reason;
    if (eligible.some((m) => m.id === wanted)) {
      codes.push(pinModel ? `pin.${pinModel.scope}` : 'manual.default');
      return result(
        wanted,
        src,
        pinModel
          ? `${wanted}, pinned by ${pinModel.source}${pinModel.until ? ` until ${pinModel.until}` : ''}`
          : `${wanted}, the manual default`,
        { pin_id },
      );
    }
    codes.push('pin.unavailable');
    return result(
      null,
      'none',
      `${wanted} is ${pinModel ? 'pinned' : 'the manual default'} but cannot run here (${why ?? 'not in the registry'}); a human decides`,
      { pin_id },
    );
  }
  if (sensitive) {
    codes.push('constraint.sensitive');
    return result(null, 'none', 'sensitive work runs only on a model a human pinned for it ("friday routing pin")');
  }
  if (mode === 'manual') {
    codes.push('manual.none');
    return result(null, 'none', 'manual routing: no model is pinned or set as routing.default_model');
  }

  // The guide's avoid list; scores for the rest.
  for (const m of eligible.filter((x) => guide?.avoid.includes(x.id)))
    excluded.push({ model: m.id, reason: 'guide.avoid' });
  eligible = eligible.filter((m) => !guide?.avoid.includes(m.id));
  if (!eligible.length) {
    codes.push('none.eligible');
    return result(null, 'none', 'no eligible model can run this task here; a human decides');
  }
  // Relative to the dearest and slowest model in the registry, not among these candidates: a
  // model's cost rating must not change with what else one harness happens to run.
  const priceOf = (m: ModelRecord) => (m.price ? (m.price.input + m.price.output) / 2 : null);
  const prices = eligible.map(priceOf);
  const maxPrice = Math.max(0, ...input.models.map(priceOf).filter((p): p is number => p !== null));
  const latencies = eligible.map((m) => m.latency_ms);
  const maxLatency = Math.max(0, ...input.models.map((m) => m.latency_ms).filter((l): l is number => l !== null));
  const candidates: Candidate[] = eligible.map((m, i) => {
    const reasons: string[] = [];
    const { fit, known: hasCaps } = fitOf(m, req);
    if (!hasCaps) reasons.push('capabilities.unknown');
    const ev = input.evidence.find((e) => e.model === m.id && e.task_class === task_class);
    const samples = ev?.samples ?? 0;
    let quality = fit;
    let pass_rate: number | null = null;
    if (ev && samples >= settings.min_samples) {
      pass_rate = ev.passed / samples;
      quality = 0.5 * fit + 0.5 * pass_rate;
      reasons.push(`evidence.used(${samples})`);
    } else {
      reasons.push(`evidence.too_few(${samples}/${settings.min_samples})`);
    }
    const price = prices[i] ?? null;
    const cost = price !== null && maxPrice > 0 ? price / maxPrice : null;
    const lat = latencies[i] ?? null;
    const latency = lat !== null && maxLatency > 0 ? lat / maxLatency : null;
    const c = cost ?? 0;
    const l = latency ?? 0;
    let score =
      settings.optimize === 'quality'
        ? quality
        : settings.optimize === 'cost'
          ? quality - 0.3 * c
          : settings.optimize === 'latency'
            ? quality - 0.3 * l
            : quality - 0.1 * c * (0.5 + req.cost_sensitivity) - 0.05 * l * (0.5 + req.latency_sensitivity);
    const rank = guide?.preferred.indexOf(m.id) ?? -1;
    if (rank >= 0 && rank < 3) {
      score += 0.03 - 0.01 * rank;
      reasons.push(`guide.preferred(${rank + 1})`);
    }
    return {
      model: m.id,
      score: round(score),
      fit: round(fit),
      pass_rate,
      samples,
      cost: cost === null ? null : round(cost),
      reasons,
    };
  });
  candidates.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));
  // Between models within the delta of the best, the cheaper one (spec Part 08 §13).
  const top = candidates[0] as Candidate;
  const close = candidates.filter(
    (c) => top.score - c.score < settings.prefer_cheaper_if_score_delta_below && c.cost !== null,
  );
  const cheapest = close.length > 1 ? close.reduce((a, b) => ((b.cost ?? 1) < (a.cost ?? 1) ? b : a)) : top;
  const best = cheapest.model !== top.model ? cheapest : top;
  if (best !== top) codes.push('cheaper.within_delta');
  const strongest = [...candidates].sort((a, b) => b.fit - a.fit || a.model.localeCompare(b.model))[0] as Candidate;
  const chainFor = (chosen: string) => [
    ...(guide?.fallback ?? [])
      .filter((id) => id !== chosen && candidates.some((c) => c.model === id))
      .map((id) => ({ model: id, reason: 'guide.fallback' })),
    ...candidates
      .filter((c) => c.model !== chosen && !(guide?.fallback ?? []).includes(c.model))
      .slice(0, 2)
      .map((c) => ({ model: c.model, reason: 'score.next' })),
    { model: null, reason: 'human' },
  ];
  const scored = (model: string, source: RoutingDecision['source'], reason: string, confidence: number | null = null) =>
    result(model, source, reason, { candidates, fallback_chain: chainFor(model), confidence });
  const fitText = (c: Candidate) =>
    `fit ${c.fit}${c.pass_rate !== null ? `, ${Math.round(c.pass_rate * 100)}% verified in ${c.samples} ${task_class} task(s)` : `, no measured outcomes yet (${c.samples} of ${settings.min_samples})`}`;

  if (mode === 'policy') {
    const preferred = guide?.preferred.find((id) => candidates.some((c) => c.model === id));
    if (preferred) {
      codes.push('guide.preferred');
      return scored(preferred, 'guide', `${preferred}, the guide's preference for ${task_class} tasks`);
    }
    const fallback = guide?.fallback.find((id) => candidates.some((c) => c.model === id));
    if (fallback) {
      codes.push('guide.fallback');
      return scored(fallback, 'fallback', `${fallback}, the guide's fallback for ${task_class} tasks`);
    }
    codes.push('score.best');
    return scored(best.model, 'score', `${best.model}, the best score (${fitText(best)})`);
  }

  // auto and hybrid: Laya when its calibrated answer is confident, else the configured fallback.
  if (input.laya) {
    const a = input.laya;
    const usable = candidates.some((c) => c.model === a.choice);
    if (usable && a.threshold !== null && a.confidence >= a.threshold) {
      codes.push('laya.confident');
      return scored(
        a.choice,
        'laya',
        `${a.choice}, Laya's choice (${a.checkpoint}, confidence ${round(a.confidence)} ≥ calibrated ${a.threshold})`,
        a.confidence,
      );
    }
    codes.push(!usable ? 'laya.ineligible_choice' : a.threshold === null ? 'laya.uncalibrated' : 'laya.low_confidence');
    if (settings.low_confidence === 'human' || settings.low_confidence === 'block') {
      return result(
        null,
        'none',
        `Laya's answer is not reliable enough (${codes.at(-1)}); ${settings.low_confidence === 'human' ? 'a human decides' : 'autonomous routing is blocked'}`,
        { candidates, confidence: a.confidence },
      );
    }
    if (settings.low_confidence === 'strongest') {
      return scored(
        strongest.model,
        'fallback',
        `${strongest.model}, the strongest eligible model (Laya was not confident)`,
        a.confidence,
      );
    }
  } else {
    codes.push('laya.none');
  }
  codes.push('score.best');
  return scored(best.model, 'score', `${best.model} for ${task_class} tasks: ${fitText(best)}`);
}
