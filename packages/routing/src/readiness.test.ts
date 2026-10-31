import { describe, expect, it } from 'vitest';
import { assessReadiness, type ReadinessEvidence, readinessReasonCode } from './readiness.js';

const NOW = '2026-10-22T12:00:00.000Z';
const ev = (e: Partial<ReadinessEvidence> & Pick<ReadinessEvidence, 'stage' | 'status'>): ReadinessEvidence => ({
  host: 'codex',
  model: null,
  checked_at: '2026-10-22T11:00:00.000Z',
  expires_at: null,
  source: 'test',
  version: null,
  detail: null,
  ...e,
});
const status = (a: ReturnType<typeof assessReadiness>) => Object.fromEntries(a.stages.map((s) => [s.stage, s.status]));

describe('readiness under the loose rule (ADR-0035 §1)', () => {
  it('is dispatchable for a connected host whose sign-in was never seen: it is tried', () => {
    const a = assessReadiness([], { host: 'codex', model: 'openai/gpt-6.1-sol', live: true, now: NOW });
    expect(a.dispatchable).toBe(true);
    expect(status(a)).toEqual({
      detected: 'passed',
      configured: 'passed',
      handshake: 'passed',
      authenticated: 'unknown',
      live_verified: 'unknown',
      benched: 'passed',
      dispatchable: 'passed',
    });
    expect(readinessReasonCode(a)).toBe('readiness.ok');
  });

  it('needs a connection or a fresh doctor check for a host with no session', () => {
    const none = assessReadiness([], { host: 'codex', model: null, live: false, now: NOW });
    expect(none).toMatchObject({ dispatchable: false, blocking: { stage: 'detected', status: 'missing' } });
    expect(none.reason).toContain('no session is connected');
    const doctor = ['detected', 'configured', 'handshake'].map((stage) =>
      ev({ stage: stage as ReadinessEvidence['stage'], status: 'passed', expires_at: '2026-10-23T11:00:00.000Z' }),
    );
    expect(assessReadiness(doctor, { host: 'codex', model: null, live: false, now: NOW }).dispatchable).toBe(true);
    const expired = doctor.map((e) => ({ ...e, expires_at: '2026-10-22T11:30:00.000Z' }));
    expect(assessReadiness(expired, { host: 'codex', model: null, live: false, now: NOW })).toMatchObject({
      dispatchable: false,
      blocking: { stage: 'detected', status: 'stale' },
    });
  });

  it('blocks on a recent sign-in failure, and tries again once it has expired', () => {
    const failed = [ev({ stage: 'authenticated', status: 'failed', detail: 'run "codex login"' })];
    const a = assessReadiness(failed, { host: 'codex', model: 'openai/gpt-6.1-sol', live: true, now: NOW });
    expect(a).toMatchObject({ dispatchable: false, blocking: { stage: 'authenticated', status: 'failed' } });
    expect(a.reason).toContain('codex login');
    expect(readinessReasonCode(a)).toBe('readiness.authenticated.failed');
    const old = [{ ...failed[0], expires_at: '2026-10-22T11:59:00.000Z' } as ReadinessEvidence];
    expect(assessReadiness(old, { host: 'codex', model: null, live: true, now: NOW }).dispatchable).toBe(true);
  });

  it("prefers this model's evidence over the host's", () => {
    const evidence = [
      ev({ stage: 'authenticated', status: 'failed', checked_at: '2026-10-22T10:00:00.000Z' }),
      ev({ stage: 'authenticated', status: 'passed', model: 'openai/gpt-6.1-sol' }),
    ];
    expect(
      assessReadiness(evidence, { host: 'codex', model: 'openai/gpt-6.1-sol', live: true, now: NOW }).dispatchable,
    ).toBe(true);
    expect(
      assessReadiness(evidence, { host: 'codex', model: 'openai/gpt-6-astra', live: true, now: NOW }).dispatchable,
    ).toBe(false);
  });

  it('keeps a bench in force until it expires, for that model or the whole host', () => {
    const modelBench = [
      ev({
        stage: 'benched',
        status: 'failed',
        model: 'openai/gpt-6.1-sol',
        expires_at: '2026-10-22T12:30:00.000Z',
        detail: 'rate limited',
      }),
    ];
    const sol = assessReadiness(modelBench, { host: 'codex', model: 'openai/gpt-6.1-sol', live: true, now: NOW });
    expect(sol).toMatchObject({ dispatchable: false, bench_until: '2026-10-22T12:30:00.000Z' });
    expect(sol.reason).toContain('rate limited');
    expect(readinessReasonCode(sol)).toBe('readiness.benched');
    // Another model of the same host is not benched by it.
    expect(
      assessReadiness(modelBench, { host: 'codex', model: 'openai/gpt-6-astra', live: true, now: NOW }).dispatchable,
    ).toBe(true);
    const hostBench = [ev({ stage: 'benched', status: 'failed', expires_at: '2026-10-22T12:10:00.000Z' })];
    expect(
      assessReadiness(hostBench, { host: 'codex', model: 'openai/gpt-6-astra', live: true, now: NOW }).dispatchable,
    ).toBe(false);
    // An expired bench no longer counts.
    expect(
      assessReadiness(hostBench, { host: 'codex', model: null, live: true, now: '2026-10-22T12:11:00.000Z' })
        .dispatchable,
    ).toBe(true);
  });

  it('never requires a live check, and never lets host-level evidence stand for one', () => {
    const hostLive = [ev({ stage: 'live_verified', status: 'passed' })];
    const a = assessReadiness(hostLive, { host: 'codex', model: 'openai/gpt-6.1-sol', live: true, now: NOW });
    expect(status(a).live_verified).toBe('unknown');
    expect(a.dispatchable).toBe(true);
  });
});
