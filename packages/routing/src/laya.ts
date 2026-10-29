import { createHash } from 'node:crypto';
import type { RoutingSettings } from './decide.js';
import type { ModelRecord } from './registry.js';
import { REQUIREMENTS_VERSION, requirementsFor } from './requirements.js';

/**
 * Laya, the lightweight decision model (spec Part 08 §6, ADR-0031 §10), over `laya-serve`'s HTTP
 * contract: `POST /v1/systemone` with a `state` and typed `questions` keyed by id; a `choice`
 * question lists its options as `criteria` (label → description). Its confidence is not a
 * probability until calibrated on this project's data, so Friday stores the answer with the
 * question's identity and gates it on a fitted threshold.
 */

export interface LayaQuestion {
  /** Identity of the question: options and their descriptions in order, requirements, guide. */
  question_id: string;
  instructions: string;
  /** Ordered: label → description. */
  options: [string, string][];
  state: Record<string, unknown>;
}

export interface LayaReply {
  checkpoint: string;
  choice: string;
  /** `answer_confidence` when Laya gives it, else the highest probability. */
  confidence: number;
  basis: 'answer_confidence' | 'max_probability' | 'confidence';
  probabilities: Record<string, number> | null;
  latency_ms: number;
}

export class LayaError extends Error {
  constructor(
    readonly kind: 'unreachable' | 'timeout' | 'http' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'LayaError';
  }
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

function describe(m: ModelRecord, kind: string): string {
  const req = requirementsFor(kind);
  const top = Object.entries(req.weights)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 3)
    .map(([d]) => `${d.replaceAll('_', ' ')} ${m.capabilities[d as keyof ModelRecord['capabilities']] ?? '?'}`);
  return [
    `${m.provider} model`,
    m.local ? 'runs locally' : 'remote',
    m.vision ? 'sees images' : 'text only',
    m.price ? `costs ${m.price.input}/${m.price.output} USD per million tokens in/out` : 'price unknown',
    `priors: ${top.join(', ')}`,
  ].join('; ');
}

/**
 * The routing question for a task (ADR-0031 §10): the models eligible under the hard constraints
 * that do not depend on the harness, in registry order. The same inputs give the same identity,
 * so a stored answer is used only while the question it answered still stands.
 */
export function layaQuestion(
  task: { task_id: string; kind: string; role: string | null; summary: string },
  models: readonly ModelRecord[],
  settings: RoutingSettings,
  avoid: readonly string[],
  guideVersion: string,
): LayaQuestion | null {
  const req = requirementsFor(task.kind);
  const eligible = models.filter(
    (m) => (!settings.must_use_local || m.local) && (!req.vision || m.vision) && !avoid.includes(m.id),
  );
  if (eligible.length < 2) return null;
  const options = eligible.map((m) => [m.id, describe(m, task.kind)] as [string, string]);
  const state = {
    task: { kind: task.kind, role: task.role, summary: task.summary.slice(0, 500) },
    needs: req.weights,
    latency_sensitivity: req.latency_sensitivity,
    cost_sensitivity: req.cost_sensitivity,
    optimize: settings.optimize,
  };
  const instructions =
    "Choose the model that should handle this software engineering task, given what the task needs and each model's strengths, cost and locality.";
  const question_id = hash({
    options,
    kind: task.kind,
    role: task.role,
    summary: state.task.summary,
    req: REQUIREMENTS_VERSION,
    guideVersion,
    optimize: settings.optimize,
  });
  return { question_id, instructions, options, state };
}

/** Asks `laya-serve` one routing question. Never sends anything but the question's state and options. */
export async function askLaya(
  cfg: { url: string; model?: string | undefined; timeout_ms: number; api_key?: string | undefined },
  q: LayaQuestion,
): Promise<LayaReply> {
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeout_ms);
  let res: Response;
  try {
    res = await fetch(`${cfg.url.replace(/\/$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {}),
      },
      body: JSON.stringify({
        state: q.state,
        questions: { route: { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.options) } },
        ...(cfg.model ? { model: cfg.model } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw ctrl.signal.aborted
      ? new LayaError('timeout', `Laya did not answer within ${cfg.timeout_ms} ms`)
      : new LayaError('unreachable', `Laya is not reachable at ${cfg.url}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new LayaError('http', `Laya answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as {
    model?: unknown;
    answers?: Record<
      string,
      { choice?: unknown; probabilities?: unknown; answer_confidence?: unknown; confidence?: unknown }
    >;
  } | null;
  const a = body?.answers?.route;
  if (!a || typeof a.choice !== 'string') throw new LayaError('malformed', 'Laya returned no choice for the question');
  if (!q.options.some(([label]) => label === a.choice)) {
    throw new LayaError('malformed', `Laya chose "${a.choice}", which was not an option`);
  }
  const labels = q.options.map(([l]) => l);
  const probabilities = Array.isArray(a.probabilities)
    ? Object.fromEntries(labels.map((l, i) => [l, Number((a.probabilities as unknown[])[i] ?? 0)]))
    : a.probabilities && typeof a.probabilities === 'object'
      ? Object.fromEntries(Object.entries(a.probabilities as Record<string, unknown>).map(([k, v]) => [k, Number(v)]))
      : null;
  let confidence: number;
  let basis: LayaReply['basis'];
  if (typeof a.answer_confidence === 'number') {
    confidence = a.answer_confidence;
    basis = 'answer_confidence';
  } else if (probabilities && Object.keys(probabilities).length) {
    confidence = Math.max(...Object.values(probabilities));
    basis = 'max_probability';
  } else if (typeof a.confidence === 'number') {
    confidence = a.confidence;
    basis = 'confidence';
  } else {
    throw new LayaError('malformed', 'Laya returned no confidence for its choice');
  }
  return {
    checkpoint: typeof body?.model === 'string' ? body.model : (cfg.model ?? 'unknown'),
    choice: a.choice,
    confidence,
    basis,
    probabilities,
    latency_ms: Math.round(performance.now() - started),
  };
}

/** One labelled answer of a held-out set: was Laya's choice right? */
export interface CalibrationRecord {
  checkpoint: string;
  /** Number of options in the question. */
  options: number;
  confidence: number;
  correct: boolean;
}

export interface Calibration {
  checkpoint: string;
  /** `choice:<n>`: thresholds are fitted per checkpoint and option count. */
  shape: string;
  /** Answers at or above it reached `target` accuracy on the labelled set; null when none did. */
  threshold: number | null;
  accuracy: number | null;
  /** Share of the bucket's answers at or above the threshold. */
  coverage: number;
  support: number;
  target: number;
}

/**
 * Fits a threshold per checkpoint and question shape (Laya's documentation: "a threshold is a policy
 * you choose from measured accuracy at that coverage on your data"; spec Part 13 §10 asks for it): the lowest confidence at which
 * the answers at or above it are at least `target` accurate, with at least `minSupport` of them.
 * Arithmetic only: it says nothing about routing quality beyond the labelled set.
 */
export function fitThresholds(
  records: readonly CalibrationRecord[],
  opts: { target?: number; minSupport?: number } = {},
): Calibration[] {
  const target = opts.target ?? 0.9;
  const minSupport = opts.minSupport ?? 20;
  const buckets = new Map<string, CalibrationRecord[]>();
  for (const r of records) {
    const key = `${r.checkpoint}\u0000choice:${r.options}`;
    buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }
  const out: Calibration[] = [];
  for (const [key, rs] of [...buckets].sort(([a], [b]) => a.localeCompare(b))) {
    const [checkpoint = '', shape = ''] = key.split('\u0000');
    const sorted = [...rs].sort((a, b) => b.confidence - a.confidence);
    let best: { threshold: number; accuracy: number; covered: number } | null = null;
    let correct = 0;
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i] as CalibrationRecord;
      if (r.correct) correct += 1;
      const covered = i + 1;
      // Only at the end of a run of equal confidences: a threshold cannot split them.
      const next = sorted[i + 1];
      if (next && next.confidence === r.confidence) continue;
      const accuracy = correct / covered;
      if (covered >= minSupport && accuracy >= target) best = { threshold: r.confidence, accuracy, covered };
    }
    out.push({
      checkpoint,
      shape,
      threshold: best?.threshold ?? null,
      accuracy: best ? Math.round(best.accuracy * 1000) / 1000 : null,
      coverage: best ? Math.round((best.covered / sorted.length) * 1000) / 1000 : 0,
      support: sorted.length,
      target,
    });
  }
  return out;
}
