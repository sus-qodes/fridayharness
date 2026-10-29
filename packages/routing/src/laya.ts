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
    /** `refused`: the address is not this machine; `cancelled`: the caller went away. */
    readonly kind: 'unreachable' | 'timeout' | 'http' | 'malformed' | 'refused' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'LayaError';
  }
}

/** The most of an answer Friday reads (review F10). */
const MAX_ANSWER_BYTES = 256 * 1024;

/**
 * Laya runs on this machine (review F09): plain http to a literal loopback address, with no
 * credentials in the address. A host name may resolve elsewhere, so only addresses are accepted.
 */
function localAddress(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new LayaError('refused', `${raw} is not an address`);
  }
  if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== '[::1]') || u.username || u.password) {
    throw new LayaError(
      'refused',
      `Laya must run on this machine, at http://127.0.0.1 or http://[::1]; ${u.protocol}//${u.host} is refused`,
    );
  }
  return u;
}

const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Reads at most `max` bytes of a body; the caller's signal still ends it (review F10). */
async function readBounded(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new LayaError('malformed', `Laya's answer is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
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
  /** The checkpoint asked for (`routing.laya.model`); part of the identity (review F11). */
  checkpoint: string | null = null,
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
    checkpoint,
  });
  return { question_id, instructions, options, state };
}

/**
 * Asks `laya-serve` one routing question. Never sends anything but the question's state and
 * options, only to this machine, and follows no redirect (review F09). The deadline covers the whole
 * answer, which is bounded and validated before anything uses it (review F10): a choice among the
 * options, numbers that are probabilities, and the checkpoint that was asked for. `signal` ends the
 * request when its caller goes away (the daemon closing, the task cancelled).
 */
export async function askLaya(
  cfg: {
    url: string;
    model?: string | undefined;
    timeout_ms: number;
    api_key?: string | undefined;
    signal?: AbortSignal | undefined;
  },
  q: LayaQuestion,
): Promise<LayaReply> {
  const base = localAddress(cfg.url);
  const started = performance.now();
  const ctrl = new AbortController();
  let why: 'timeout' | 'cancelled' | null = null;
  const stop = (reason: 'timeout' | 'cancelled') => {
    why ??= reason;
    ctrl.abort();
  };
  const timer = setTimeout(() => stop('timeout'), cfg.timeout_ms);
  const cancel = () => stop('cancelled');
  if (cfg.signal?.aborted) cancel();
  cfg.signal?.addEventListener('abort', cancel, { once: true });
  const ended = () =>
    why === 'cancelled'
      ? new LayaError('cancelled', 'the request to Laya was cancelled')
      : new LayaError('timeout', `Laya did not answer within ${cfg.timeout_ms} ms`);
  try {
    let res: Response;
    try {
      res = await fetch(`${base.origin}${base.pathname.replace(/\/$/, '')}/v1/systemone`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          ...(cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {}),
        },
        body: JSON.stringify({
          state: q.state,
          questions: {
            route: { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.options) },
          },
          ...(cfg.model ? { model: cfg.model } : {}),
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw why
        ? ended()
        : new LayaError('unreachable', `Laya is not reachable at ${cfg.url}: ${(e as Error).message}`);
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => undefined);
      throw new LayaError('http', `Laya answered with a redirect (${res.status}); Friday follows none`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new LayaError('http', `Laya answered ${res.status}`);
    }
    let text: string;
    try {
      text = await readBounded(res, MAX_ANSWER_BYTES);
    } catch (e) {
      if (e instanceof LayaError) throw e;
      throw why ? ended() : new LayaError('unreachable', `Laya's answer broke off: ${(e as Error).message}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new LayaError('malformed', "Laya's answer is not JSON");
    }
    return { ...readReply(body, q, cfg.model), latency_ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
    cfg.signal?.removeEventListener('abort', cancel);
  }
}

/** A reply that holds together, or a `malformed` LayaError (review F10). */
function readReply(raw: unknown, q: LayaQuestion, asked: string | undefined): Omit<LayaReply, 'latency_ms'> {
  const malformed = (m: string) => new LayaError('malformed', m);
  const body = (raw && typeof raw === 'object' ? raw : {}) as {
    model?: unknown;
    answers?: Record<
      string,
      { choice?: unknown; probabilities?: unknown; answer_confidence?: unknown; confidence?: unknown }
    >;
  };
  const a = body.answers?.route;
  if (!a || typeof a.choice !== 'string') throw malformed('Laya returned no choice for the question');
  if (!q.options.some(([label]) => label === a.choice))
    throw malformed(`Laya chose "${a.choice}", which was not an option`);
  if (typeof body.model === 'string' && asked && body.model !== asked) {
    throw malformed(`Laya answered with the checkpoint ${body.model}, not ${asked}, which was asked for`);
  }
  const labels = q.options.map(([l]) => l);
  let probabilities: Record<string, number> | null = null;
  if (Array.isArray(a.probabilities)) {
    if (a.probabilities.length !== labels.length || !a.probabilities.every(unit)) {
      throw malformed("Laya's probabilities are not one number between 0 and 1 per option");
    }
    probabilities = Object.fromEntries(labels.map((l, i) => [l, (a.probabilities as number[])[i] as number]));
  } else if (a.probabilities !== undefined && a.probabilities !== null) {
    const entries =
      typeof a.probabilities === 'object' ? Object.entries(a.probabilities as Record<string, unknown>) : [];
    if (!entries.length || !entries.every(([k, v]) => labels.includes(k) && unit(v))) {
      throw malformed("Laya's probabilities are not numbers between 0 and 1 for the options");
    }
    probabilities = Object.fromEntries(entries) as Record<string, number>;
  }
  for (const [name, v] of [
    ['answer_confidence', a.answer_confidence],
    ['confidence', a.confidence],
  ] as const) {
    if (v !== undefined && v !== null && !unit(v)) throw malformed(`Laya's ${name} is not a number between 0 and 1`);
  }
  let confidence: number;
  let basis: LayaReply['basis'];
  if (unit(a.answer_confidence)) {
    confidence = a.answer_confidence;
    basis = 'answer_confidence';
  } else if (probabilities && Object.keys(probabilities).length) {
    confidence = Math.max(...Object.values(probabilities));
    basis = 'max_probability';
  } else if (unit(a.confidence)) {
    confidence = a.confidence;
    basis = 'confidence';
  } else {
    throw malformed('Laya returned no confidence for its choice');
  }
  return {
    checkpoint: typeof body.model === 'string' ? body.model : (asked ?? 'unknown'),
    choice: a.choice,
    confidence,
    basis,
    probabilities,
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
