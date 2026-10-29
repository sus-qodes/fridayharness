import type { UiSnapshot } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FridayApi } from '../api/client.js';
import { ApiError, type StreamEnd, type StreamHandlers, type Transport } from '../platform/transport.js';
import { createStore, type SystemState } from '../store/state.js';
import { Dispatcher } from '../sync/dispatcher.js';
import { STALE_PAGE_MESSAGE, SyncEngine } from '../sync/sync-engine.js';
import { makeSnapshot } from '../test/fixtures.js';
import { connectionView, mountConnectionStrip } from './connection.js';
import type { Component } from './context.js';

const mounted: Component[] = [];
afterEach(() => {
  for (const c of mounted.splice(0)) c.destroy();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function sys(over: Partial<SystemState> = {}): SystemState {
  return { connection: 'live', sequence: 1, attempts: 0, lastError: null, refreshing: false, snapshotAt: 0, ...over };
}

/** A daemon whose snapshot route fails while `failing` is set, and whose stream stays open. */
class Daemon implements Transport {
  readonly kind = 'http' as const;
  failing = false;
  reads = 0;
  snapshots: UiSnapshot[] = [];

  async request<T>(_m: string, path: string): Promise<T> {
    if (!path.endsWith('/ui/snapshot')) throw new Error(`unexpected ${path}`);
    this.reads++;
    if (this.failing) throw new ApiError(500, 'COS-5000', 'internal_error', 'database is locked', true);
    return (this.snapshots.length > 1 ? this.snapshots.shift() : this.snapshots[0]) as T;
  }

  stream(_path: string, h: StreamHandlers, signal: AbortSignal): Promise<StreamEnd> {
    return new Promise((resolve) => {
      h.onOpen?.();
      signal.addEventListener('abort', () => resolve('closed'));
    });
  }
}

describe('connection strip (review R2)', () => {
  it('offers Try again while connected once a read of the board failed', () => {
    expect(connectionView(sys())).toMatchObject({ message: null, retry: false });
    expect(connectionView(sys({ lastError: 'COS-5000: database is locked' }))).toMatchObject({
      state: 'connected',
      detail: 'COS-5000: database is locked',
      retry: true,
    });
    // A page older than Friday is not a failed read: the banner asks for a reload instead.
    expect(connectionView(sys({ lastError: STALE_PAGE_MESSAGE }))).toMatchObject({ message: null, retry: false });
    // While reconnecting, the engine is already trying.
    expect(connectionView(sys({ connection: 'reconnecting', lastError: 'reset' })).retry).toBe(false);
  });

  it('reads the board again from the strip while the engine runs, and hides once the read succeeds', async () => {
    vi.useFakeTimers();
    const daemon = new Daemon();
    daemon.snapshots = [makeSnapshot({ head: 1 }), makeSnapshot({ head: 7 })];
    const store = createStore();
    const engine = new SyncEngine(new FridayApi(daemon, 'proj_1'), store, new Dispatcher(store), {
      readBackoff: () => 600_000,
    });
    const strip = mountConnectionStrip(store, { onRetry: () => void engine.retry() });
    mounted.push(strip);
    document.body.append(strip.el);
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(strip.el.hidden).toBe(true);
    daemon.failing = true;
    await engine.refresh();
    expect(engine.running).toBe(true);
    expect(strip.el.hidden).toBe(false);
    expect(strip.el.dataset.state).toBe('connected');
    const retry = strip.el.querySelector('.sh-strip-retry') as HTMLButtonElement;
    expect(retry.hidden).toBe(false);
    daemon.failing = false;
    retry.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(daemon.reads).toBe(3);
    expect(store.select('board')?.head).toBe(7);
    expect(strip.el.hidden).toBe(true);
    engine.stop();
  });
});
