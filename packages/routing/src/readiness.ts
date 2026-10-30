/**
 * Runtime readiness (ADR-0035 §1): what Friday has actually observed about a host and a model on
 * this machine, never what the static registry declares. Under the owner's loose rule a candidate
 * is dispatchable when its host is connected (or a fresh doctor check found it installed and
 * configured), its sign-in has not failed recently, and no bench is in force. A sign-in never seen
 * is tried; a paid live check is recorded when it happens and never required.
 */
export const READINESS_EVIDENCE_STAGES = [
  'detected',
  'configured',
  'handshake',
  'authenticated',
  'live_verified',
  'benched',
] as const;
export const READINESS_STAGES = [...READINESS_EVIDENCE_STAGES, 'dispatchable'] as const;

export type ReadinessEvidenceStage = (typeof READINESS_EVIDENCE_STAGES)[number];
export type ReadinessStage = (typeof READINESS_STAGES)[number];
export type ReadinessEvidenceStatus = 'passed' | 'failed';
/** `unknown`: never observed, which the loose rule allows for a sign-in. */
export type ReadinessStageStatus = ReadinessEvidenceStatus | 'missing' | 'stale' | 'unknown';

/** One observation for one host (and, where it matters, one model): never a credential or token. */
export interface ReadinessEvidence {
  host: string;
  /** The model the evidence is about; null for a host-level observation. */
  model: string | null;
  stage: ReadinessEvidenceStage;
  status: ReadinessEvidenceStatus;
  checked_at: string;
  /** When the evidence stops counting; null means it does not expire. */
  expires_at: string | null;
  /** Where it came from: `harness doctor`, a completed run, a host failure, a human. */
  source: string;
  /** The host or model version the check saw; null when unknown. */
  version: string | null;
  /** A short, credential-free explanation. */
  detail: string | null;
}

export interface ReadinessStageView {
  stage: ReadinessStage;
  status: ReadinessStageStatus;
  checked_at: string | null;
  expires_at: string | null;
  source: string | null;
  detail: string | null;
}

export interface ReadinessAssessment {
  host: string;
  model: string | null;
  /** A session of this host is connected to Friday now. */
  live: boolean;
  /** Every stage in order, the computed `dispatchable` last. */
  stages: ReadinessStageView[];
  dispatchable: boolean;
  /** The stage that keeps it from dispatch, and how; null when dispatchable. */
  blocking: { stage: ReadinessEvidenceStage; status: ReadinessStageStatus } | null;
  /** Until when a bench keeps it out; null without a bench. */
  bench_until: string | null;
  /** Why, in plain words. */
  reason: string;
}

const CONNECTION: readonly ReadinessEvidenceStage[] = ['detected', 'configured', 'handshake'];
const WORDS: Record<ReadinessEvidenceStage, string> = {
  detected: 'installed',
  configured: 'configured for Friday',
  handshake: 'connected to Friday',
  authenticated: 'signed in',
  live_verified: 'live-verified',
  benched: 'benched',
};

const isFresh = (e: ReadinessEvidence, nowMs: number) => e.expires_at === null || Date.parse(e.expires_at) > nowMs;

/**
 * The newest evidence for a stage: this model's first, then the host's. A live check is about one
 * model only, so host-level evidence never stands for it.
 */
function evidenceFor(
  evidence: readonly ReadinessEvidence[],
  host: string,
  model: string | null,
  stage: ReadinessEvidenceStage,
): ReadinessEvidence | null {
  const newest = (xs: ReadinessEvidence[]) =>
    [...xs].sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at))[0] ?? null;
  const forHost = evidence.filter((e) => e.host === host && e.stage === stage);
  const exact = newest(forHost.filter((e) => model !== null && e.model === model));
  if (exact || stage === 'live_verified') return exact;
  return newest(forHost.filter((e) => e.model === null));
}

/**
 * The sign-in evidence that counts for a model: the newest fresh observation among the model's own
 * and the host's (an indefinite failure stays fresh); with none fresh, the newest of all, so an
 * expired pass reads as stale rather than as a sign-in.
 */
function authEvidenceFor(
  evidence: readonly ReadinessEvidence[],
  host: string,
  model: string | null,
  nowMs: number,
): ReadinessEvidence | null {
  const byTime = (xs: ReadinessEvidence[]) =>
    [...xs].sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at))[0] ?? null;
  const rows = evidence.filter(
    (e) => e.host === host && e.stage === 'authenticated' && (e.model === null || e.model === model),
  );
  return byTime(rows.filter((e) => isFresh(e, nowMs))) ?? byTime(rows);
}

const view = (stage: ReadinessStage, status: ReadinessStageStatus, e: ReadinessEvidence | null, detail?: string) => ({
  stage,
  status,
  checked_at: e?.checked_at ?? null,
  expires_at: e?.expires_at ?? null,
  source: e?.source ?? null,
  detail: detail ?? e?.detail ?? null,
});

/** The loose-rule verdict for one host and model (ADR-0035 §1). */
export function assessReadiness(
  evidence: readonly ReadinessEvidence[],
  input: { host: string; model: string | null; live: boolean; now: string },
): ReadinessAssessment {
  const nowMs = Date.parse(input.now);
  const label = `${input.host}${input.model ? `/${input.model}` : ''}`;
  const stages: ReadinessStageView[] = [];
  let blocking: ReadinessAssessment['blocking'] = null;
  let reason = 'ready';
  let benchUntil: string | null = null;
  const block = (stage: ReadinessEvidenceStage, status: ReadinessStageStatus, why: string) => {
    if (blocking) return;
    blocking = { stage, status };
    reason = why;
  };

  for (const stage of CONNECTION) {
    const e = evidenceFor(evidence, input.host, input.model, stage);
    if (input.live) {
      stages.push(view(stage, 'passed', e, 'a session is connected now'));
      continue;
    }
    const status: ReadinessStageStatus = !e ? 'missing' : !isFresh(e, nowMs) ? 'stale' : e.status;
    stages.push(view(stage, status, e));
    if (status !== 'passed') {
      block(
        stage,
        status,
        status === 'missing'
          ? `${label} is not ${WORDS[stage]}: no session is connected and no doctor check has seen it`
          : status === 'stale'
            ? `the check that ${label} is ${WORDS[stage]} expired at ${e?.expires_at}`
            : `${label} is not ${WORDS[stage]}${e?.detail ? `: ${e.detail}` : ''}`,
      );
    }
  }

  // Sign-in: a recent failure blocks; never seen, or a pass that expired, is tried (the loose rule).
  // The model's own evidence and the host's are read by time, not by level (review 2026-10-22 R4):
  // a host-wide sign-in failure newer than a model's pass blocks that model; a model's pass newer
  // than the failure lets that model back, and the host's other models wait.
  const auth = authEvidenceFor(evidence, input.host, input.model, nowMs);
  const authStatus: ReadinessStageStatus = !auth
    ? 'unknown'
    : !isFresh(auth, nowMs)
      ? auth.status === 'failed'
        ? 'unknown'
        : 'stale'
      : auth.status;
  stages.push(view('authenticated', authStatus, auth));
  if (authStatus === 'failed') {
    block('authenticated', 'failed', `${label} is not signed in${auth?.detail ? `: ${auth.detail}` : ''}`);
  }

  const live = evidenceFor(evidence, input.host, input.model, 'live_verified');
  stages.push(view('live_verified', !live ? 'unknown' : !isFresh(live, nowMs) ? 'stale' : live.status, live));

  // A bench: this model's or the whole host's, in force until it expires (ADR-0035 §3).
  const benches = evidence.filter(
    (e) =>
      e.host === input.host &&
      e.stage === 'benched' &&
      e.status === 'failed' &&
      (e.model === null || e.model === input.model) &&
      isFresh(e, nowMs),
  );
  const bench = [...benches].sort((a, b) => Date.parse(b.expires_at ?? '9999') - Date.parse(a.expires_at ?? '9999'))[0];
  if (bench) {
    benchUntil = bench.expires_at;
    stages.push(view('benched', 'failed', bench));
    block(
      'benched',
      'failed',
      `${label} is benched${bench.expires_at ? ` until ${bench.expires_at}` : ' until a human clears it'}${bench.detail ? `: ${bench.detail}` : ''}`,
    );
  } else {
    stages.push(view('benched', 'passed', null, 'not benched'));
  }

  const dispatchable = blocking === null;
  stages.push(view('dispatchable', dispatchable ? 'passed' : 'failed', null, dispatchable ? undefined : reason));
  return {
    host: input.host,
    model: input.model,
    live: input.live,
    stages,
    dispatchable,
    blocking,
    bench_until: benchUntil,
    reason,
  };
}

/** The reason code routing records for an excluded candidate (ADR-0035 §2). */
export function readinessReasonCode(a: ReadinessAssessment): string {
  if (!a.blocking) return 'readiness.ok';
  return a.blocking.stage === 'benched' ? 'readiness.benched' : `readiness.${a.blocking.stage}.${a.blocking.status}`;
}
