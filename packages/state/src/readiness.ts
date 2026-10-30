import {
  type Actor,
  FridayError,
  type HarnessView,
  type ReadinessEvidenceView,
  ReadinessRecordRequest,
  type RunView,
} from '@friday/protocol';
import { assessReadiness, type ReadinessAssessment } from '@friday/routing';
import type { z } from 'zod';
import type { CommandContext } from './bus.js';
import type { FridayState } from './service.js';

/** A completed attempt shows the host and model signed in for this long, renewed by each success (ADR-0035 §1). */
export const AUTHENTICATED_TTL_MS = 7 * 86_400_000;
/** What a doctor check saw counts for this long. */
export const DOCTOR_TTL_MS = 86_400_000;

export interface ReadinessObservation {
  host: string;
  model: string | null;
  stage: ReadinessEvidenceView['stage'];
  status: ReadinessEvidenceView['status'];
  source: string;
  version?: string | null;
  detail?: string | null;
  expires_at: string | null;
  /** The session it came from; its evidence ends with the session. */
  harness_id?: string | null;
}

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/**
 * Runtime readiness (ADR-0035 §1–§3): what Friday has observed of each host and model on this
 * machine, as evidence with an expiry, never what the ranking declares. A session that registers
 * shows its host installed, configured and connected while it is live; a completed attempt shows
 * the host and model signed in for seven days; a doctor check counts for a day; a host failure
 * benches the host or model (slice 2.2). Routing filters on the verdict and never reorders.
 */
export class ReadinessService {
  constructor(private readonly state: FridayState) {}

  /** Records observations inside a command; the newest of a stage is the one that counts. */
  recordWithin(ctx: CommandContext, projectId: string, observations: readonly ReadinessObservation[]): string[] {
    if (!observations.length) return [];
    const evidence = observations.map((o) => ({
      evidence_id: this.state.ids.next('rdy'),
      host: o.host,
      model: o.model,
      stage: o.stage,
      status: o.status,
      checked_at: ctx.now,
      expires_at: o.expires_at,
      source: o.source,
      version: o.version ?? null,
      // Never a credential: what a host prints can carry one.
      detail: o.detail ? this.state.redactor.redactString(o.detail.slice(0, 300)).value : null,
      harness_id: o.harness_id ?? null,
    }));
    const sessions = [...new Set(evidence.map((e) => e.harness_id).filter((h): h is string => h !== null))];
    ctx.emit({
      type: 'readiness.recorded',
      payload: { project_id: projectId, evidence },
      refs: sessions.map((id) => ({ kind: 'harness' as const, id })),
    });
    return evidence.map((e) => e.evidence_id);
  }

  /** A session registered: its host is installed, configured and connected while the session lives. */
  observeRegistration(ctx: CommandContext, projectId: string, harness: HarnessView): void {
    const detail = `${harness.name} registered (${harness.attach_mode})`;
    this.recordWithin(
      ctx,
      projectId,
      (['detected', 'configured', 'handshake'] as const).map((stage) => ({
        host: harness.vendor,
        model: null,
        stage,
        status: 'passed' as const,
        source: 'harness.register',
        version: harness.version,
        detail,
        expires_at: null,
        harness_id: harness.harness_id,
      })),
    );
  }

  /** An attempt ended in a completion claim: the host and model are signed in, for seven days. */
  observeCompletion(ctx: CommandContext, projectId: string, run: RunView, harness: HarnessView): void {
    const model = run.model_observed ?? run.model_requested ?? null;
    this.recordWithin(ctx, projectId, [
      {
        host: harness.vendor,
        model,
        stage: 'authenticated',
        status: 'passed',
        source: `run:${run.run_id}`,
        version: harness.version,
        detail: `attempt ${run.attempt} of ${run.task_id} claimed completion`,
        expires_at: plus(ctx.now, AUTHENTICATED_TTL_MS),
      },
    ]);
  }

  /** `POST readiness/evidence`: what a host check outside the daemon saw (`friday harness doctor`). */
  record(projectId: string, actor: Actor, input: z.input<typeof ReadinessRecordRequest>): ReadinessEvidenceView[] {
    const req = ReadinessRecordRequest.parse(input);
    if (actor.kind !== 'human' && actor.kind !== 'system') {
      throw new FridayError('permission_denied', 'only a human or Friday records readiness');
    }
    return this.state.bus.execute({ name: 'readiness.record', project_id: projectId, actor, params: req }, (ctx) => {
      const ids = this.recordWithin(
        ctx,
        projectId,
        req.stages.map((s) => ({
          host: req.host,
          model: s.model,
          stage: s.stage,
          status: s.status,
          source: req.source,
          version: req.version,
          detail: s.detail,
          expires_at: plus(ctx.now, req.ttl_s * 1000),
        })),
      );
      return this.state.q
        .readinessEvidence(projectId, { host: req.host, all: true })
        .filter((e) => ids.includes(e.evidence_id));
    }).result;
  }

  /**
   * A human lifts what keeps a host, or one of its models, out: its benches and its failed sign-in
   * (ADR-0035 §3). Passed evidence stays. Returns the evidence ended.
   */
  clear(projectId: string, actor: Actor, host: string, model: string | null = null): ReadinessEvidenceView[] {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human clears readiness');
    return this.state.bus.execute(
      { name: 'readiness.clear', project_id: projectId, actor, params: { host, model } },
      (ctx) => {
        const ended = this.state.q
          .readinessEvidence(projectId, { host })
          .filter((e) => e.status === 'failed' && (model === null || e.model === null || e.model === model));
        if (ended.length) {
          ctx.emit({
            type: 'readiness.invalidated',
            payload: { evidence_ids: ended.map((e) => e.evidence_id), reason: `cleared by ${actor.id}`, host, model },
            refs: [],
          });
        }
        return this.state.q
          .readinessEvidence(projectId, { host, all: true })
          .filter((e) => ended.some((x) => x.evidence_id === e.evidence_id));
      },
    ).result;
  }

  /** The loose-rule verdict for one host and model now (ADR-0035 §1). */
  assess(projectId: string, host: string, model: string | null, now = this.state.clock.now()): ReadinessAssessment {
    const live = (this.state.q.liveHarnessesByVendor(projectId, now).get(host) ?? 0) > 0;
    return assessReadiness(this.state.q.readinessEvidence(projectId, { host }), { host, model, live, now });
  }
}
