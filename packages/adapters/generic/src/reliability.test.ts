/** Adversarial inputs for the reliability review; desired invariants are tested directly. */
import type { OutboundMessage } from '@friday/protocol';
import type { DaemonClient } from '@friday/sdk';
import { describe, expect, it, vi } from 'vitest';
import { classifyHostFailure } from './host-failure.js';
import { GenericHarnessClient } from './index.js';

describe('reliability audit of failure classification', () => {
  it.each([
    'Unit test failed: expected HTTP 401, received HTTP 200',
    'ENOSPC: disk quota exceeded while writing build output',
    'The application parser rejected a forbidden directive',
  ])('does not bench a provider for a work failure: %s', (text) => {
    expect(classifyHostFailure(text, 'turn')).toBeNull();
  });

  it.each([
    ['authentication failed', { kind: 'auth' }],
    ['rate limit; Retry-After: 90', { kind: 'rate_limit', retry_after_s: 90 }],
    ['unknown model', { kind: 'runtime_unavailable' }],
  ])('still recognizes provider evidence: %s', (text, expected) => {
    expect(classifyHostFailure(text as string, 'turn')).toEqual(expected);
  });
});

describe('reliability audit of the control channel', () => {
  it('disposes late startup after shutdown without starting work or acknowledging it', async () => {
    const h = new GenericHarnessClient({} as DaemonClient, {
      harness_key: 'late-start',
      vendor: 'generic',
      name: 'review',
      attach_mode: 'spawn',
      project_id: 'proj_review',
    });
    const ctrl = new AbortController();
    let release!: () => void;
    const prepared = new Promise<void>((r) => {
      release = r;
    });
    const afterAck = vi.fn();
    const handler = vi.fn(async () => {
      await prepared;
      return { accepted: true, afterAck };
    });
    vi.spyOn(h, 'poll').mockResolvedValue([
      { method: 'task.start', message_id: 'start', params: {}, sent_at: '', expires_at: '', attempt: 1 },
    ]);
    const ack = vi.spyOn(h, 'ack');
    const done = h.run(handler, { signal: ctrl.signal });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    ctrl.abort();
    await done;
    release();
    await vi.waitFor(() => expect(afterAck).toHaveBeenCalledWith(false, 'aborted'));
    expect(afterAck).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
  });
  function client() {
    return new GenericHarnessClient({} as DaemonClient, {
      harness_key: 'reliability-review',
      vendor: 'generic',
      name: 'review',
      attach_mode: 'spawn',
      project_id: 'proj_review',
    });
  }
  const message = (method: OutboundMessage['method'], id: string): OutboundMessage => ({
    method,
    message_id: id,
    params: {},
    sent_at: '',
    expires_at: '',
    attempt: 1,
  });

  it('can stop its delivery loop while a host start handler is stuck', async () => {
    const h = client();
    const ctrl = new AbortController();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(h, 'poll').mockResolvedValue([message('task.start', 'start')]);
    vi.spyOn(h, 'ack').mockResolvedValue({ acked: ['start'], current: [], unknown: [] });
    let stopped = false;
    const done = h
      .run(
        async () => {
          enter();
          await blocked;
          return { accepted: false };
        },
        { signal: ctrl.signal },
      )
      .then(() => {
        stopped = true;
      });
    await entered;
    ctrl.abort();
    await new Promise<void>((r) => setImmediate(r));
    try {
      expect(stopped).toBe(true);
    } finally {
      release();
      await done;
    }
  });

  it('continues serving cancellations after an afterAck callback throws', async () => {
    const h = client();
    const ctrl = new AbortController();
    vi.spyOn(h, 'poll').mockResolvedValue([message('task.start', 'start'), message('task.cancel', 'cancel')]);
    vi.spyOn(h, 'ack').mockResolvedValue({ acked: ['start'], current: ['start'], unknown: [] });
    const seen: string[] = [];
    await h
      .run(
        async (m) => {
          seen.push(m.method);
          if (m.method === 'task.cancel') ctrl.abort();
          return {
            accepted: true,
            afterAck: () => {
              if (m.method === 'task.start') throw new Error('host start callback failed');
            },
          };
        },
        { signal: ctrl.signal },
      )
      .catch(() => undefined);
    expect(seen).toContain('task.cancel');
  });
});
