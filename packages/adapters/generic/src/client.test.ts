import type { DaemonClient } from '@friday/sdk';
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
