import { type DaemonClient, DaemonUnreachableError } from '@friday/sdk';
import { describe, expect, it } from 'vitest';
import { GenericHarnessClient } from './index.js';

/** A DaemonClient stand-in that records RPC calls and the token class each one used. */
function fakeDaemon() {
  const calls: Array<{ method: string; params: Record<string, unknown>; token: string }> = [];
  const make = (token: string): DaemonClient =>
    ({
      rpc: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params, token });
        if (method === 'harness.register') {
          return {
            protocol_version: '1.0',
            harness_id: 'harness_test',
            agent_id: 'agent_test',
            harness_token: 'harness-token',
            reconnected: false,
            shadow: false,
            lease: { ttl_ms: 30_000, heartbeat_interval_ms: 10_000, expires_at: '2026-01-01T00:00:30Z' },
            stream_url: '/protocol/v1/stream',
            pending_messages: 0,
          };
        }
        return {};
      },
      withToken: (next: string) => make(next),
    }) as unknown as DaemonClient;
  return { client: make('bootstrap'), calls };
}

describe('GenericHarnessClient', () => {
  it('registers with the bootstrap token, then calls everything else with its harness token', async () => {
    const d = fakeDaemon();
    const h = new GenericHarnessClient(d.client, {
      harness_key: 'generic:1',
      vendor: 'generic',
      name: 'test',
      attach_mode: 'attach',
      project_id: 'proj_test',
      agent_key: 'dev-1',
    });
    expect(() => h.harnessId).toThrow(/not registered/);
    await h.register();
    expect(h.harnessId).toBe('harness_test');
    await h.claim({ next: true });
    await h.reportResult({
      task_id: 'task_1',
      run_id: 'run_1',
      status: 'completed_claim',
      summary: 'done',
      changed_paths: [],
    });

    expect(d.calls.map((c) => [c.method, c.token])).toEqual([
      ['harness.register', 'bootstrap'],
      ['task.claim', 'harness-token'],
      ['agent.result', 'harness-token'],
    ]);
    expect(d.calls[0]?.params).toMatchObject({
      harness_key: 'generic:1',
      vendor: 'generic',
      attach_mode: 'attach',
      agent: { agent_key: 'dev-1', role: 'developer' },
    });
    // Mutating calls carry an idempotency key so a retried request is applied once.
    expect(d.calls[1]?.params.idempotency_key).toMatch(/^msg_/);
    expect(d.calls[2]?.params.idempotency_key).toMatch(/^msg_/);
  });
});

describe('the delivery loop (review M8-R02, R03)', () => {
  /** A daemon whose poll and ack answers a test scripts, one per call. */
  function scripted(polls: Array<() => unknown>, acks: Array<() => unknown>) {
    const seen: string[] = [];
    const make = (): DaemonClient =>
      ({
        rpc: async (method: string) => {
          seen.push(method);
          if (method === 'harness.register') {
            return {
              harness_id: 'harness_test',
              agent_id: 'agent_test',
              harness_token: 't',
              lease: { ttl_ms: 30_000, heartbeat_interval_ms: 10_000, expires_at: '' },
            };
          }
          const next = method === 'harness.poll' ? polls.shift() : method === 'harness.ack' ? acks.shift() : undefined;
          if (!next && method === 'harness.poll') {
            // A long poll with nothing to deliver waits, as the daemon's does.
            await new Promise((r) => setTimeout(r, 10));
            return { messages: [] };
          }
          if (!next) return {};
          return next();
        },
        withToken: () => make(),
      }) as unknown as DaemonClient;
    return { client: make(), seen };
  }
  const start = (id: string) => ({
    message_id: id,
    method: 'task.start',
    params: {},
    sent_at: '',
    expires_at: '',
  });
  const unreachable = () => {
    throw new DaemonUnreachableError('cannot reach the Friday daemon');
  };

  it('polls again after a failed poll, and starts work only where Friday says the run is current', async () => {
    const d = scripted(
      [unreachable, () => ({ messages: [start('m1'), start('m2')] })],
      [
        () => ({ acked: ['m1'], unknown: [], current: ['m1'] }),
        // The answer to the second acknowledgement is lost once; trying again reads it.
        unreachable,
        () => ({ acked: ['m2'], unknown: [], current: [] }),
      ],
    );
    const h = new GenericHarnessClient(d.client, {
      harness_key: 'generic:1',
      vendor: 'generic',
      name: 'test',
      attach_mode: 'spawn',
      project_id: 'proj_test',
    });
    await h.register();
    const outcomes: [string, boolean][] = [];
    const troubles: number[] = [];
    const ctrl = new AbortController();
    const done = h.run(
      async (m) => ({ accepted: true, afterAck: (current) => outcomes.push([m.message_id, current]) }),
      { signal: ctrl.signal, waitMs: 0, onTrouble: (_e, ms) => troubles.push(ms) },
    );
    for (let i = 0; i < 200 && outcomes.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await done;
    expect(troubles).toHaveLength(1);
    expect(outcomes).toEqual([
      ['m1', true],
      ['m2', false],
    ]);
    expect(d.seen.filter((m) => m === 'harness.ack')).toHaveLength(3);
  });
});
