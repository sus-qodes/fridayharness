import type { DomainEvent, UiSnapshot } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FridayApi } from '../api/client.js';
import { HttpTransport } from '../platform/http-transport.js';
import {
  ApiError,
  AuthError,
  OfflineError,
  type StreamEnd,
  type StreamHandlers,
  type Transport,
} from '../platform/transport.js';
import { connectionView } from '../shell/connection.js';
import { UI_API } from '../shell/version.js';
import { createStore, type FridayStore } from '../store/state.js';
import {
  makeAgent,
  makeApproval,
  makeEscalation,
  makeEvent,
  makeRun,
  makeSnapshot,
  makeTask,
} from '../test/fixtures.js';
import { Dispatcher, isDomainEvent } from './dispatcher.js';
import { approvalFromEvent, escalationFromEvent } from './rows.js';
import {
  DRAINING_CODE,
  defaultReadBackoff,
  STALE_PAGE_MESSAGE,
  STALL_MS,
  STOPPING_MESSAGE,
  SyncEngine,
  type SyncOptions,
  UNREACHABLE_MESSAGE,
  UNREACHABLE_MS,
} from './sync-engine.js';

const AGENT = { kind: 'agent', id: 'agent_1' };
const TASK = 'task_1';

function event(
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
  actor = { kind: 'system', id: 'friday' },
): DomainEvent {
  return { ...makeEvent(sequence, type, payload, actor), project_id: 'proj_1' } as DomainEvent;
}

function snapshot(head: number, extra: Partial<UiSnapshot> = {}): UiSnapshot {
  return makeSnapshot({ head, ...extra });
}

type Script = (h: StreamHandlers, signal: AbortSignal) => Promise<StreamEnd>;

/** A scripted daemon: a snapshot route and streams that play queued scripts. */
class FakeTransport implements Transport {
  readonly kind = 'http' as const;
  snapshots: UiSnapshot[] = [];
  snapshotCalls = 0;
  /** Thrown by the snapshot route instead of answering, while set. */
  snapshotError: unknown = null;
  /** Answers the snapshot route later (one read in flight). */
  snapshotGate: Promise<void> | null = null;
  streams: Script[] = [];
  /** The script for every stream after the queued ones (default: open, then wait for the abort). */
  fallback: Script | null = null;
  streamPaths: string[] = [];

  async request<T>(_m: string, path: string): Promise<T> {
    if (path.endsWith('/ui/snapshot')) {
      this.snapshotCalls++;
      if (this.snapshotGate) await this.snapshotGate;
      if (this.snapshotError) throw this.snapshotError;
      const s = this.snapshots.length > 1 ? this.snapshots.shift() : this.snapshots[0];
      if (!s) throw new Error('no snapshot');
      return s as T;
    }
    throw new Error(`unexpected ${path}`);
  }

  stream(path: string, h: StreamHandlers, signal: AbortSignal): Promise<StreamEnd> {
    this.streamPaths.push(path);
    const next = this.streams.shift() ?? this.fallback;
    if (!next) return new Promise((resolve) => signal.addEventListener('abort', () => resolve('closed')));
    return next(h, signal);
  }
}

/** A stream that opens and then stays silent until it is aborted. */
const silent: Script = (h, signal) =>
  new Promise((resolve) => {
    h.onOpen?.();
    signal.addEventListener('abort', () => resolve('closed'));
  });

/** A healthy stream that opens and then only pings, every 15 s, until it is aborted. */
const pinging: Script = (h, signal) =>
  new Promise((resolve) => {
    h.onOpen?.();
    const ping = setInterval(() => h.onActivity?.(), 15_000);
    signal.addEventListener('abort', () => {
      clearInterval(ping);
      resolve('closed');
    });
  });

function setup(t: FakeTransport, opts: SyncOptions = {}) {
  const store = createStore();
  const api = new FridayApi(t, 'proj_1');
  const dispatcher = new Dispatcher(store);
  const engine = new SyncEngine(api, store, dispatcher, { debounceMs: 10, maxWaitMs: 30, backoff: () => 5, ...opts });
  return { store, engine, dispatcher };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe('SyncEngine', () => {
  it('streams from the snapshot head and re-reads the snapshot after domain events', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(10), snapshot(12)];
    t.streams.push(async (h) => {
      h.onOpen?.();
      h.onEvent(event(9, 'task.ready'));
      h.onEvent(event(11, 'policy.evaluated', { decision: 'allow' }));
      h.onEvent(event(12, 'task.ready'));
      await tick(60);
      return 'shutdown';
    });
    const { store, engine } = setup(t);
    await engine.start();
    await tick(120);
    expect(t.streamPaths[0]).toBe('/api/v1/projects/proj_1/events/stream?since=10');
    expect(store.select('system').sequence).toBe(12);
    expect(t.snapshotCalls).toBe(2);
    expect(store.select('board')?.head).toBe(12);
  });

  it('a snapshot read ahead of the stream does not swallow the events the stream delivers after it (review M9i)', async () => {
    const t = new FakeTransport();
    // The second read already covers 11 and 12, which the stream delivers only afterwards.
    t.snapshots = [snapshot(10), snapshot(12, { approvals: [makeApproval({ approval_id: 'apr_9' })] })];
    let handlers = null as StreamHandlers | null;
    t.streams.push(
      (h, signal) =>
        new Promise((resolve) => {
          handlers = h;
          h.onOpen?.();
          signal.addEventListener('abort', () => resolve('closed'));
        }),
    );
    const { store, engine } = setup(t);
    await engine.start();
    await tick(5);
    await engine.refresh();
    expect(store.select('board')?.head).toBe(12);
    handlers?.onEvent(event(11, 'approval.requested', { approval: { approval_id: 'apr_9', capability: 'git.push' } }));
    handlers?.onEvent(event(12, 'task.ready'));
    // The request's reaction plays although the snapshot already showed the approval.
    expect(store.select('activity').reactions.map((r) => r.kind)).toContain('approval');
    expect(store.select('system').sequence).toBe(12);
    engine.stop();
  });

  it('debounces re-reads: a burst of domain events reads the snapshot once', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(1)];
    let handlers = null as StreamHandlers | null;
    t.streams.push((h, signal) => {
      handlers = h;
      return silent(h, signal);
    });
    const { engine } = setup(t, { debounceMs: 250, maxWaitMs: 1000 });
    vi.useFakeTimers();
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 2; i < 12; i++) {
      handlers?.onEvent(event(i, 'task.ready'));
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(t.snapshotCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(t.snapshotCalls).toBe(2);
    // Transient events read nothing.
    handlers?.onEvent(event(20, 'policy.evaluated', { decision: 'allow' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(t.snapshotCalls).toBe(2);
    engine.stop();
  });

  it('keeps one read in flight and reads once more after it', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(1)];
    t.fallback = silent;
    const { engine } = setup(t);
    await engine.start();
    let open: () => void = () => undefined;
    t.snapshotGate = new Promise<void>((r) => {
      open = r;
    });
    const a = engine.refresh();
    const b = engine.refresh();
    const c = engine.refresh();
    expect(t.snapshotCalls).toBe(2);
    t.snapshotGate = null;
    open();
    await Promise.all([a, b, c]);
    await tick(5);
    expect(t.snapshotCalls).toBe(3);
    engine.stop();
  });

  it('reconnects with the last sequence after the stream drops', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(5)];
    t.streams.push(async (h) => {
      h.onOpen?.();
      h.onEvent(event(6, 'agent.event', { event_type: 'progress' }));
      throw new Error('connection reset');
    });
    t.streams.push(async (h) => {
      h.onOpen?.();
      await tick(20);
      return 'shutdown';
    });
    const { store, engine } = setup(t);
    await engine.start();
    await tick(100);
    expect(t.streamPaths).toEqual([
      '/api/v1/projects/proj_1/events/stream?since=5',
      '/api/v1/projects/proj_1/events/stream?since=6',
    ]);
    expect(store.select('system').connection).toBe('stopped');
  });

  it('drops a stream that sent no bytes for 45 s and opens it again', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.snapshots = [snapshot(3)];
    t.fallback = silent;
    const { store, engine } = setup(t);
    await engine.start();
    await vi.advanceTimersByTimeAsync(STALL_MS - 1000);
    expect(t.streamPaths).toHaveLength(1);
    expect(store.select('system').connection).toBe('live');
    await vi.advanceTimersByTimeAsync(1000 + 50);
    expect(t.streamPaths).toHaveLength(2);
    expect(t.streamPaths[1]).toBe('/api/v1/projects/proj_1/events/stream?since=3');
    expect(store.select('system').connection).toBe('live');
    engine.stop();
  });

  it('keeps a stream whose pings arrive, although they carry no event', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.snapshots = [snapshot(3)];
    t.fallback = (h, signal) =>
      new Promise((resolve) => {
        h.onOpen?.();
        const ping = setInterval(() => h.onActivity?.(), 15_000);
        signal.addEventListener('abort', () => {
          clearInterval(ping);
          resolve('closed');
        });
      });
    const { engine } = setup(t);
    await engine.start();
    await vi.advanceTimersByTimeAsync(STALL_MS * 4);
    expect(t.streamPaths).toHaveLength(1);
    engine.stop();
  });

  it('reads the board again after one failed read, while the stream stays connected with pings only (review R2)', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.snapshots = [snapshot(1), snapshot(2)];
    let handlers = null as StreamHandlers | null;
    t.fallback = (h, signal) => {
      handlers = h;
      return pinging(h, signal);
    };
    const { store, engine } = setup(t);
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);
    t.snapshotError = new ApiError(500, 'COS-5000', 'internal_error', 'database is locked', true);
    handlers?.onEvent(event(2, 'task.ready'));
    await vi.advanceTimersByTimeAsync(50);
    expect(t.snapshotCalls).toBe(2);
    expect(store.select('system').connection).toBe('live');
    expect(store.select('system').lastError).toContain('COS-5000');
    // The daemon answers again; the stream only pings, and no domain event comes to cause a read.
    t.snapshotError = null;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.snapshotCalls).toBe(3);
    expect(store.select('board')?.head).toBe(2);
    expect(store.select('system')).toMatchObject({ connection: 'live', lastError: null });
    expect(t.streamPaths).toHaveLength(1);
    engine.stop();
  });

  it('retries failed reads with growing, bounded waits, and stops retrying when the engine stops', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.snapshots = [snapshot(1)];
    t.fallback = pinging;
    const waits: number[] = [];
    const { engine } = setup(t, {
      readBackoff: (n) => {
        waits.push(n);
        return n * 1000;
      },
    });
    await engine.start();
    t.snapshotError = new ApiError(500, 'COS-5000', 'internal_error', 'database is locked', true);
    await engine.refresh();
    expect(t.snapshotCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.snapshotCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(1999);
    expect(t.snapshotCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.snapshotCalls).toBe(4);
    expect(waits).toEqual([1, 2, 3]);
    engine.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.snapshotCalls).toBe(4);
    for (let n = 1; n < 40; n++) expect(defaultReadBackoff(n)).toBeLessThanOrEqual(36_000);
    expect(defaultReadBackoff(1)).toBeGreaterThanOrEqual(800);
  });

  it('Try again reads the board at once while the engine runs, and a good read ends the retries', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.snapshots = [snapshot(1), snapshot(4)];
    t.fallback = pinging;
    const { store, engine } = setup(t, { readBackoff: () => 30_000 });
    await engine.start();
    await vi.advanceTimersByTimeAsync(1);
    t.snapshotError = new OfflineError('connection reset');
    await engine.refresh();
    expect(t.snapshotCalls).toBe(2);
    t.snapshotError = null;
    await engine.retry();
    expect(t.snapshotCalls).toBe(3);
    expect(store.select('board')?.head).toBe(4);
    expect(store.select('system').lastError).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.snapshotCalls).toBe(3);
    engine.stop();
  });

  it('does not retry a read while Friday drains, nor after the session ended', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.snapshots = [snapshot(1)];
    t.fallback = pinging;
    const { store, engine } = setup(t, { readBackoff: () => 1000 });
    await engine.start();
    t.snapshotError = new ApiError(503, DRAINING_CODE, 'shutting_down', 'Friday is shutting down', true);
    await engine.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.snapshotCalls).toBe(2);
    engine.stop();
    const t2 = new FakeTransport();
    t2.snapshots = [snapshot(1)];
    t2.fallback = pinging;
    const two = setup(t2, { readBackoff: () => 1000 });
    await two.engine.start();
    t2.snapshotError = new AuthError('COS-3005', 'expired');
    await two.engine.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t2.snapshotCalls).toBe(2);
    expect(two.store.select('system').connection).toBe('signed-out');
    expect(store.select('system').lastError).toBe(STOPPING_MESSAGE);
  });

  it('opens the stream only after a first read succeeded, from its head, with no reaction to older events (review P1c)', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.snapshots = [snapshot(6)];
    t.snapshotError = new ApiError(500, 'COS-5000', 'internal_error', 'database is locked', true);
    // The daemon's stream sends what happened after `since`: a task completed at 3, a question at
    // 5, a new task at 8.
    const history = [event(3, 'task.completed'), event(5, 'escalation.requested'), event(8, 'task.created')];
    t.fallback = (h, signal) =>
      new Promise((resolve) => {
        h.onOpen?.();
        const since = Number(t.streamPaths.at(-1)?.split('since=')[1]);
        for (const e of history) if (e.sequence > since) h.onEvent(e);
        signal.addEventListener('abort', () => resolve('closed'));
      });
    const { store, engine } = setup(t, { readBackoff: () => 2000 });
    await engine.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.streamPaths).toEqual([]);
    expect(store.select('board')).toBeNull();
    // The strip says the board could not be read, with Try again.
    expect(connectionView(store.select('system'))).toMatchObject({
      retry: true,
      detail: expect.stringContaining('COS-5000'),
    });
    t.snapshotError = null;
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.select('board')?.head).toBe(6);
    expect(t.streamPaths).toEqual(['/api/v1/projects/proj_1/events/stream?since=6']);
    expect(store.select('activity').reactions.map((r) => r.kind)).toEqual(['node']);
    expect(connectionView(store.select('system'))).toMatchObject({ state: 'connected', message: null });
    engine.stop();
  });

  it('keeps reading a first board Friday does not give, while it drains, and says it is not reachable once it is gone', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.snapshots = [snapshot(3)];
    t.snapshotError = new ApiError(503, DRAINING_CODE, 'shutting_down', 'Friday is shutting down', true);
    t.fallback = silent;
    const { store, engine } = setup(t, { readBackoff: () => 1000 });
    await engine.start();
    expect(store.select('system').lastError).toBe(STOPPING_MESSAGE);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.snapshotCalls).toBe(2);
    t.snapshotError = new OfflineError('connection refused');
    await vi.advanceTimersByTimeAsync(UNREACHABLE_MS - 1500);
    expect(store.select('system').connection).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.select('system')).toMatchObject({ connection: 'stopped', lastError: UNREACHABLE_MESSAGE });
    expect(t.streamPaths).toEqual([]);
    expect(engine.running).toBe(false);
  });

  it('says Friday is not reachable here after 10 s of failed reconnects, and stops', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.snapshots = [snapshot(3)];
    t.fallback = async () => {
      throw new OfflineError('connection refused');
    };
    const { store, engine } = setup(t, { backoff: () => 1000 });
    await engine.start();
    t.snapshotError = new OfflineError('connection refused');
    await vi.advanceTimersByTimeAsync(UNREACHABLE_MS - 1500);
    expect(store.select('system').connection).toBe('reconnecting');
    expect(store.select('system').attempts).toBeGreaterThan(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.select('system')).toMatchObject({ connection: 'stopped', lastError: UNREACHABLE_MESSAGE });
    const streams = t.streamPaths.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.streamPaths).toHaveLength(streams);
    expect(engine.running).toBe(false);
  });

  it('a stream that comes back resets the 10 s rule', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.snapshots = [snapshot(3)];
    const fail: Script = async () => {
      throw new OfflineError('refused');
    };
    for (let i = 0; i < 6; i++) t.streams.push(fail);
    t.streams.push(async (h) => {
      h.onOpen?.();
      throw new OfflineError('reset');
    });
    for (let i = 0; i < 6; i++) t.streams.push(fail);
    t.fallback = silent;
    const { store, engine } = setup(t, { backoff: () => 1000 });
    await engine.start();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(store.select('system').connection).toBe('live');
    engine.stop();
  });

  it('shows "Friday is stopping" on 503 COS-9001 and stops re-reading', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(5)];
    let handlers = null as StreamHandlers | null;
    t.streams.push((h, signal) => {
      handlers = h;
      return silent(h, signal);
    });
    const { store, engine } = setup(t);
    await engine.start();
    await tick(5);
    t.snapshotError = new ApiError(503, DRAINING_CODE, 'shutting_down', 'Friday is shutting down', true);
    handlers?.onEvent(event(6, 'task.ready'));
    await tick(40);
    expect(t.snapshotCalls).toBe(2);
    expect(store.select('system').lastError).toBe(STOPPING_MESSAGE);
    expect(engine.draining).toBe(true);
    handlers?.onEvent(event(7, 'task.ready'));
    handlers?.onEvent(event(8, 'goal.created'));
    await tick(60);
    expect(t.snapshotCalls).toBe(2);
    await engine.refresh();
    expect(t.snapshotCalls).toBe(2);
    engine.stop();
  });

  it('treats a stream refused with 503 COS-9001 as stopping, then stopped once Friday is gone', async () => {
    vi.useFakeTimers();
    const t = new FakeTransport();
    t.snapshots = [snapshot(5)];
    t.streams.push(async () => {
      throw new ApiError(503, DRAINING_CODE, 'shutting_down', 'draining', true);
    });
    t.fallback = async () => {
      throw new OfflineError('refused');
    };
    const { store, engine } = setup(t, { backoff: () => 1000 });
    await engine.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(store.select('system').lastError).toBe(STOPPING_MESSAGE);
    t.snapshotError = new OfflineError('refused');
    await vi.advanceTimersByTimeAsync(UNREACHABLE_MS + 3000);
    expect(store.select('system')).toMatchObject({ connection: 'stopped', lastError: UNREACHABLE_MESSAGE });
  });

  it('stops after event: shutdown with the not-reachable message', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(1)];
    t.streams.push(async (h) => {
      h.onOpen?.();
      return 'shutdown';
    });
    const { store, engine } = setup(t);
    await engine.start();
    await tick(10);
    expect(store.select('system')).toMatchObject({ connection: 'stopped', lastError: UNREACHABLE_MESSAGE });
    expect(t.streamPaths).toHaveLength(1);
    expect(engine.running).toBe(false);
  });

  it('can be started again after it stopped, from the last sequence', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(4)];
    t.streams.push(async (h) => {
      h.onOpen?.();
      h.onEvent(event(5, 'agent.event', { event_type: 'progress' }));
      return 'shutdown';
    });
    t.fallback = silent;
    const { store, engine } = setup(t);
    await engine.start();
    await tick(10);
    expect(store.select('system').connection).toBe('stopped');
    await engine.retry();
    await tick(10);
    expect(store.select('system').connection).toBe('live');
    expect(t.streamPaths[1]).toBe('/api/v1/projects/proj_1/events/stream?since=5');
    engine.stop();
  });

  it('stops and shows signed-out when the session ends', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(1)];
    t.streams.push(async () => {
      throw new AuthError('COS-3005', 'token revoked');
    });
    const { store, engine } = setup(t);
    await engine.start();
    await tick(30);
    expect(store.select('system').connection).toBe('signed-out');
    expect(t.streamPaths).toHaveLength(1);
  });

  it('a 401 on the first snapshot signs out without opening a stream', async () => {
    const t = new FakeTransport();
    t.snapshotError = new AuthError('COS-3005', 'expired');
    const { store, engine } = setup(t);
    await engine.start();
    expect(store.select('system').connection).toBe('signed-out');
    expect(t.streamPaths).toHaveLength(0);
  });

  it('asks for a reload when the snapshot speaks another interface API', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(1, { ui_api: UI_API + 1 })];
    t.fallback = silent;
    const { store, engine } = setup(t);
    await engine.start();
    await tick(5);
    expect(store.select('system')).toMatchObject({ connection: 'live', lastError: STALE_PAGE_MESSAGE });
    engine.stop();
  });

  it('clears the stale-page message once the API matches again', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(1, { ui_api: 99 }), snapshot(2)];
    t.fallback = silent;
    const { store, engine } = setup(t);
    await engine.start();
    await tick(5);
    expect(store.select('system').lastError).toBe(STALE_PAGE_MESSAGE);
    await engine.refresh();
    expect(store.select('system').lastError).toBeNull();
    engine.stop();
  });

  it('records tool activity, pulses and the file ticker from policy decisions', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(1, { agents: [makeAgent({ agent_id: 'agent_1', agent_key: 'fe-1' })] })];
    t.streams.push(async (h) => {
      h.onOpen?.();
      h.onEvent(
        event(
          2,
          'policy.evaluated',
          { tool: 'Edit', kind: 'write', decision: 'allow', targets: ['frontend/src/a.ts'], task_id: TASK },
          AGENT,
        ),
      );
      await tick(10);
      return 'shutdown';
    });
    const { store, engine } = setup(t);
    await engine.start();
    await tick(50);
    const a = store.select('activity');
    expect(a.agents['fe-1']?.current).toMatchObject({ tool: 'Edit', kind: 'write', target: 'frontend/src/a.ts' });
    expect(a.pulses).toHaveLength(1);
    expect(a.files[TASK]?.[0]?.path).toBe('frontend/src/a.ts');
  });

  it('counts a task’s tool calls on its card as they finish, with no read of the board (review P1a)', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(10, { tasks: [makeTask({ task_id: TASK, status: 'RUNNING', tool_calls: 4 })] })];
    t.streams.push(async (h) => {
      h.onOpen?.();
      h.onEvent(event(11, 'agent.event', { event_type: 'tool.completed', task_id: TASK, tool: 'Read' }, AGENT));
      h.onEvent(event(12, 'agent.event', { event_type: 'tool.failed', task_id: TASK, tool: 'Bash' }, AGENT));
      h.onEvent(event(13, 'agent.event', { event_type: 'progress', task_id: TASK, note: 'halfway' }, AGENT));
      await tick(40);
      return 'shutdown';
    });
    const { store, engine } = setup(t);
    await engine.start();
    await tick(60);
    expect(store.select('board')?.tasks[0]?.tool_calls).toBe(6);
    expect(t.snapshotCalls).toBe(1);
  });

  it('forwards every applied event to its listeners, never one older than the cursor', async () => {
    const t = new FakeTransport();
    t.snapshots = [snapshot(4)];
    t.streams.push(async (h) => {
      h.onOpen?.();
      h.onEvent(event(3, 'task.ready'));
      h.onEvent(event(5, 'task.ready'));
      h.onEvent(event(5, 'task.ready'));
      h.onEvent({ type: 'x' } as unknown as DomainEvent);
      return 'shutdown';
    });
    const { engine } = setup(t);
    const seen: number[] = [];
    engine.onEvent((e) => seen.push(e.sequence));
    await engine.start();
    await tick(10);
    expect(seen).toEqual([5]);
  });
});

// ---------------------------------------------------------------------------------------------

function boardStore(extra: Partial<UiSnapshot> = {}): FridayStore {
  const store = createStore();
  store.setState({
    board: snapshot(10, {
      agents: [makeAgent({ agent_id: 'agent_1', agent_key: 'fe-1', harness_id: 'h1' })],
      tasks: [makeTask({ task_id: TASK, agent_key: 'fe-1', status: 'RUNNING' })],
      runs: { [TASK]: makeRun({ run_id: 'run_1', task_id: TASK, agent_id: 'agent_1' }) },
      approvals: [makeApproval({ approval_id: 'apr_1' }), makeApproval({ approval_id: 'apr_2' })],
      ...extra,
    }),
  });
  return store;
}

describe('Dispatcher (plan §7.2)', () => {
  it('says which events change domain state', () => {
    for (const type of ['task.ready', 'approval.decided', 'brain.call_started', 'goal.created', 'control.paused'])
      expect(isDomainEvent(type)).toBe(true);
    for (const type of ['policy.evaluated', 'agent.event', 'run.paths_observed', 'scope.violation'])
      expect(isDomainEvent(type)).toBe(false);
  });

  it('removes a decided approval at once and asks for a re-read', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    expect(d.handle(event(11, 'approval.decided', { approval_id: 'apr_1', status: 'granted' }))).toBe(true);
    expect(store.select('board')?.approvals.map((a) => a.approval_id)).toEqual(['apr_2']);
  });

  it('removes a revoked approval at once and asks for a re-read', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    expect(d.handle(event(11, 'approval.revoked', { approval_id: 'apr_2', note: null }))).toBe(true);
    expect(store.select('board')?.approvals.map((a) => a.approval_id)).toEqual(['apr_1']);
  });

  it('keeps a decided approval removed from a snapshot read before the decision', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    d.handle(event(11, 'approval.decided', { approval_id: 'apr_1', status: 'denied' }));
    const older = snapshot(10, { approvals: [makeApproval({ approval_id: 'apr_1' })] });
    expect(d.reconcile(older).approvals).toEqual([]);
    const newer = snapshot(11, { approvals: [makeApproval({ approval_id: 'apr_1' })] });
    expect(d.reconcile(newer).approvals).toHaveLength(1);
    // Once a snapshot covers the edit it is forgotten.
    expect(d.reconcile(older).approvals).toHaveLength(1);
  });

  it('keeps an approval decided on this page out of a snapshot read before the decision committed (review M9i)', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    store.patch('ui', { decided: { apr_1: Date.now() } });
    const older = snapshot(10, {
      approvals: [makeApproval({ approval_id: 'apr_1' }), makeApproval({ approval_id: 'apr_2' })],
    });
    const shown = d.reconcile(older);
    expect(shown.approvals.map((a) => a.approval_id)).toEqual(['apr_2']);
    store.setState({ board: shown });
    // Its request replayed by the stream does not bring it back either.
    d.handle(event(9, 'approval.requested', { approval: { approval_id: 'apr_1', capability: 'git.push' } }));
    expect(store.select('board')?.approvals.some((a) => a.approval_id === 'apr_1')).toBe(false);
    // Once a snapshot no longer lists it, the mark ends.
    d.reconcile(snapshot(11, { approvals: [makeApproval({ approval_id: 'apr_2' })] }));
    expect(store.select('ui').decided).toEqual({});
  });

  it('shows a requested approval from its payload in the same tick, and keeps it over an older snapshot', () => {
    const store = boardStore({ approvals: [] });
    const d = new Dispatcher(store);
    const approval = {
      approval_id: 'apr_9',
      capability: 'shell.exec',
      target: 'rm -rf build',
      risk: 'high',
      reuse: 'task',
    };
    expect(d.handle(event(12, 'approval.requested', { approval }, AGENT))).toBe(true);
    const shown = store.select('board')?.approvals ?? [];
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ approval_id: 'apr_9', risk: 'high', reuse: 'task', status: 'pending' });
    expect(store.select('activity').reactions.at(-1)).toMatchObject({ kind: 'approval' });
    expect(d.reconcile(snapshot(11)).approvals.map((a) => a.approval_id)).toEqual(['apr_9']);
  });

  it('ignores a decided approval replayed before its request', () => {
    const store = boardStore({ approvals: [] });
    const d = new Dispatcher(store);
    d.handle(event(13, 'approval.decided', { approval_id: 'apr_9' }));
    d.handle(event(12, 'approval.requested', { approval: { approval_id: 'apr_9' } }));
    expect(store.select('board')?.approvals).toEqual([]);
  });

  it('shows a question from its payload in the same tick, and keeps it over an older snapshot (review R2)', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    const escalation = {
      escalation_id: 'esc_9',
      task_id: TASK,
      run_id: 'run_1',
      question: 'Which plan names should the page show?',
      options: ['Basic and Pro', 'Free and Team'],
      context: 'the spec names none',
    };
    expect(d.handle(event(12, 'escalation.requested', { escalation }, AGENT))).toBe(true);
    const shown = store.select('board')?.escalations ?? [];
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      escalation_id: 'esc_9',
      task_id: TASK,
      run_id: 'run_1',
      question: 'Which plan names should the page show?',
      options: ['Basic and Pro', 'Free and Team'],
      status: 'pending',
      kind: null,
      details: null,
      requested_by_kind: 'agent',
      requested_by_id: 'agent_1',
    });
    expect(store.select('activity').reactions.at(-1)).toMatchObject({ kind: 'question' });
    // A read from before the request still shows it; a read that covers the request replaces it.
    expect(d.reconcile(snapshot(11)).escalations.map((e) => e.escalation_id)).toEqual(['esc_9']);
    expect(d.reconcile(snapshot(12)).escalations).toEqual([]);
    expect(d.reconcile(snapshot(11)).escalations).toEqual([]);
  });

  it('takes an answered question off the board at once, and keeps it off an older snapshot', () => {
    const store = boardStore({ escalations: [makeEscalation({ escalation_id: 'esc_1' })] });
    const d = new Dispatcher(store);
    expect(d.handle(event(11, 'escalation.answered', { escalation_id: 'esc_1', answer: 'yes' }))).toBe(true);
    expect(store.select('board')?.escalations).toEqual([]);
    const older = snapshot(10, { escalations: [makeEscalation({ escalation_id: 'esc_1' })] });
    expect(d.reconcile(older).escalations).toEqual([]);
    // Its request replayed after the answer does not bring it back.
    d.handle(event(9, 'escalation.requested', { escalation: { escalation_id: 'esc_1', question: 'q' } }));
    expect(store.select('board')?.escalations).toEqual([]);
  });

  it('does not bring back a question a snapshot covering its request no longer lists', () => {
    const store = boardStore({ escalations: [] });
    const d = new Dispatcher(store);
    d.handle(event(9, 'escalation.requested', { escalation: { escalation_id: 'esc_2', question: 'q' } }));
    expect(store.select('board')?.escalations).toEqual([]);
  });

  it('builds question rows only from well-formed payloads, as Friday’s own questions carry them', () => {
    expect(escalationFromEvent(event(1, 'escalation.requested', {}))).toBeNull();
    expect(escalationFromEvent(event(1, 'escalation.requested', { escalation: { escalation_id: 'e' } }))).toBeNull();
    const own = escalationFromEvent(
      event(1, 'escalation.requested', {
        escalation: {
          escalation_id: 'e',
          task_id: null,
          goal_id: 'goal_1',
          question: 'The plan was rejected',
          options: [],
          kind: 'plan_rejected',
          details: { why: 'no planner' },
        },
      }),
    );
    expect(own).toMatchObject({
      task_id: null,
      goal_id: 'goal_1',
      kind: 'plan_rejected',
      options: [],
      details: { why: 'no planner' },
      requested_by_kind: 'system',
    });
    const odd = escalationFromEvent(
      event(1, 'escalation.requested', {
        escalation: { escalation_id: 'e', question: 'q', options: 'yes', details: ['x'] },
      }),
    );
    expect(odd).toMatchObject({ options: null, details: null });
  });

  it('builds approval rows only from well-formed payloads', () => {
    expect(approvalFromEvent(event(1, 'approval.requested', {}))).toBeNull();
    expect(
      approvalFromEvent(event(1, 'approval.requested', { approval: { approval_id: 'a', status: 'granted' } })),
    ).toBeNull();
    const row = approvalFromEvent(
      event(1, 'approval.requested', { approval: { approval_id: 'a', risk: 'critical', reuse: 'session' } }),
    );
    expect(row).toMatchObject({ risk: null, reuse: 'once', capability: 'unknown' });
  });

  it('reacts to a blocked agent, and only to a blocked one', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    d.handle(event(11, 'task.waiting', { task_id: TASK, changes: { waiting_reason: 'dependency_wait' } }));
    expect(store.select('activity').reactions).toHaveLength(0);
    expect(d.handle(event(12, 'task.waiting', { task_id: TASK, changes: { waiting_reason: 'blocked' } }))).toBe(true);
    expect(store.select('activity').reactions.map((r) => r.kind)).toEqual(['question']);
  });

  it('plays a happy reaction for a new agent and re-reads after a Master Brain call starts', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    d.handle(event(11, 'harness.registered', { harness: { harness_id: 'h2' } }));
    expect(store.select('activity').reactions.at(-1)).toMatchObject({ kind: 'approved', label: 'agent' });
    const before = store.select('activity').reactions.length;
    expect(d.handle(event(12, 'brain.call_started', { job_id: 'j', kind: 'plan', goal_id: 'g' }))).toBe(true);
    expect(store.select('activity').reactions).toHaveLength(before);
  });

  it('maps the remaining reactions', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    d.handle(event(11, 'escalation.requested', {}));
    d.handle(event(12, 'plan.proposed', {}));
    d.handle(event(13, 'task.completed', {}));
    d.handle(event(14, 'goal.status_changed', { transition: { to: 'COMPLETED' } }));
    d.handle(event(15, 'goal.status_changed', { transition: { to: 'ACTIVE' } }));
    d.handle(event(16, 'task.failed', {}));
    d.handle(event(17, 'verification.finished', { status: 'FAILED' }));
    d.handle(event(18, 'verification.finished', { status: 'PASSED' }));
    d.handle(event(19, 'task.harness_lost', {}));
    d.handle(event(20, 'task.created', {}));
    d.handle(event(21, 'control.halted', {}));
    expect(store.select('activity').reactions.map((r) => r.kind)).toEqual([
      'question',
      'plan',
      'completed',
      'goal-completed',
      'failed',
      'failed',
      'lost',
      'node',
      'halt',
    ]);
  });

  it('marks a task’s line counts stale after a write, not after a read or a denial', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    d.handle(
      event(11, 'policy.evaluated', { tool: 'Read', kind: 'read', decision: 'allow', task_id: TASK }, AGENT),
      1000,
    );
    d.handle(
      event(12, 'policy.evaluated', { tool: 'Edit', kind: 'write', decision: 'deny', task_id: TASK }, AGENT),
      1100,
    );
    expect(store.select('ui').staleStats).toEqual({});
    d.handle(
      event(13, 'policy.evaluated', { tool: 'Edit', kind: 'write', decision: 'allow', task_id: TASK }, AGENT),
      1200,
    );
    expect(store.select('ui').staleStats[TASK]).toBe(1200);
    d.handle(
      event(14, 'agent.event', { event_type: 'tool.completed', run_id: 'run_1', changed_paths: ['a.ts'] }, AGENT),
      1500,
    );
    expect(store.select('ui').staleStats[TASK]).toBe(1500);
    d.handle(event(15, 'agent.event', { event_type: 'tool.completed', run_id: 'run_1' }, AGENT), 1900);
    expect(store.select('ui').staleStats[TASK]).toBe(1500);
  });

  it('marks the line counts stale even before the writing agent is on the board', () => {
    const store = boardStore({ agents: [] });
    const d = new Dispatcher(store);
    d.handle(event(11, 'policy.evaluated', { kind: 'write', decision: 'allow', task_id: 'task_2' }, AGENT), 50);
    expect(store.select('ui').staleStats.task_2).toBe(50);
  });

  it('does not count again a tool call the board’s snapshot already counted (review P1a)', () => {
    const store = boardStore({ tasks: [makeTask({ task_id: TASK, agent_key: 'fe-1', tool_calls: 3 })] });
    const d = new Dispatcher(store);
    // The board's snapshot has its head at 10: these two are in its count.
    d.handle(event(9, 'agent.event', { event_type: 'tool.completed', task_id: TASK }, AGENT));
    d.handle(event(10, 'agent.event', { event_type: 'tool.failed', task_id: TASK }, AGENT));
    expect(store.select('board')?.tasks[0]?.tool_calls).toBe(3);
    d.handle(event(11, 'agent.event', { event_type: 'tool.completed', task_id: TASK }, AGENT));
    expect(store.select('board')?.tasks[0]?.tool_calls).toBe(4);
    // A task not on the board, and agent events that are not tool calls, count nothing.
    d.handle(event(12, 'agent.event', { event_type: 'tool.completed', task_id: 'task_gone' }, AGENT));
    d.handle(event(13, 'agent.event', { event_type: 'progress', task_id: TASK }, AGENT));
    expect(store.select('board')?.tasks.map((t) => t.tool_calls)).toEqual([4]);
    // A tool event naming only its run is not in the daemon's count, so the page does not count it
    // either: the count would fall at the next reload.
    d.handle(event(14, 'agent.event', { event_type: 'tool.completed', run_id: 'run_1' }, AGENT));
    expect(store.select('board')?.tasks.map((t) => t.tool_calls)).toEqual([4]);
  });

  it('keeps the larger tool count: an older snapshot does not lower it, a newer one raises it (review P1a)', () => {
    const store = boardStore({ tasks: [makeTask({ task_id: TASK, agent_key: 'fe-1', tool_calls: 2 })] });
    const d = new Dispatcher(store);
    for (const sequence of [11, 12, 13])
      d.handle(event(sequence, 'agent.event', { event_type: 'tool.completed', task_id: TASK }, AGENT));
    expect(store.select('board')?.tasks[0]?.tool_calls).toBe(5);
    // Read before 12 and 13 arrived, so it counts 3.
    const older = d.reconcile(snapshot(11, { tasks: [makeTask({ task_id: TASK, tool_calls: 3 })] }));
    expect(older.tasks[0]?.tool_calls).toBe(5);
    store.setState({ board: older });
    // A call after that snapshot counts on top of it.
    d.handle(event(14, 'agent.event', { event_type: 'tool.failed', task_id: TASK }, AGENT));
    expect(store.select('board')?.tasks[0]?.tool_calls).toBe(6);
    // A snapshot that counted more than the page saw raises it.
    expect(
      d.reconcile(snapshot(16, { tasks: [makeTask({ task_id: TASK, tool_calls: 8 })] })).tasks[0]?.tool_calls,
    ).toBe(8);
  });

  it('measures the last tool from its policy decision to its completion, per agent', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    expect(d.lastToolDuration('fe-1')).toBeNull();
    d.handle(
      event(11, 'policy.evaluated', { tool: 'Bash', kind: 'command', decision: 'allow', task_id: TASK }, AGENT),
      1000,
    );
    d.handle(event(12, 'agent.event', { event_type: 'tool.completed', tool: 'Bash', run_id: 'run_1' }, AGENT), 1750);
    expect(d.lastToolDuration('fe-1')).toBe(750);
    // A completion of another tool does not end this one.
    d.handle(
      event(13, 'policy.evaluated', { tool: 'Edit', kind: 'write', decision: 'allow', task_id: TASK }, AGENT),
      2000,
    );
    d.handle(event(14, 'agent.event', { event_type: 'tool.completed', tool: 'Bash', run_id: 'run_1' }, AGENT), 2100);
    expect(d.lastToolDuration('fe-1')).toBe(750);
    d.handle(event(15, 'agent.event', { event_type: 'tool.failed', tool: 'edit', run_id: 'run_1' }, AGENT), 2600);
    expect(d.lastToolDuration('fe-1')).toBe(600);
    // A denied tool never ran, so nothing is measured for it.
    d.handle(
      event(16, 'policy.evaluated', { tool: 'Bash', kind: 'command', decision: 'deny', task_id: TASK }, AGENT),
      3000,
    );
    d.handle(event(17, 'agent.event', { event_type: 'tool.completed', tool: 'Bash', run_id: 'run_1' }, AGENT), 3400);
    expect(d.lastToolDuration('fe-1')).toBe(600);
    expect(d.lastToolDuration('nobody')).toBeNull();
  });

  it('logs an unmediated write, marks the task stale and adds the files to the ticker', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    d.handle(
      event(
        11,
        'agent.event',
        { event_type: 'host.unmediated_write', run_id: 'run_1', data: { paths: ['src/x.ts', 'src/y.ts'] } },
        { kind: 'harness', id: 'h1' },
      ),
      900,
    );
    const a = store.select('activity');
    expect(a.agents['fe-1']?.log.at(-1)).toMatchObject({ stream: 'error' });
    expect(a.agents['fe-1']?.log.at(-1)?.text).toContain('wrote without asking first');
    expect(a.files[TASK]?.map((f) => f.path)).toEqual(['src/x.ts', 'src/y.ts']);
    expect(store.select('ui').staleStats[TASK]).toBe(900);
  });

  it('sends scope violations and ownership conflicts to the error log', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    d.handle(event(11, 'scope.violation', { task_id: TASK, path: 'secrets/.env' }, AGENT));
    d.handle(event(12, 'ownership.conflict', { task_id: TASK, path: 'a.ts' }));
    const log = store.select('activity').agents['fe-1']?.log ?? [];
    expect(log.map((l) => l.stream)).toEqual(['error', 'error']);
    expect(log[0]?.text).toContain('scope.violation');
    expect(log[1]?.text).toContain('ownership.conflict');
  });

  it('keeps hostile text as plain, clean, bounded log lines', () => {
    const store = boardStore();
    const d = new Dispatcher(store);
    d.handle(
      event(
        11,
        'agent.event',
        { event_type: 'progress', run_id: 'run_1', note: `\u001b[31m<img src=x onerror=alert(1)>‮${'x'.repeat(5000)}` },
        AGENT,
      ),
    );
    const line = store.select('activity').agents['fe-1']?.log.at(-1)?.text ?? '';
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('‮');
    expect(line).toContain('<img src=x onerror=alert(1)>');
    expect(Array.from(line).length).toBeLessThan(400);
  });
});

describe('HttpTransport', () => {
  it('sends the session as a bearer and maps error bodies', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'COS-2002', name: 'invalid_state_transition', message: 'no' } }), {
          status: 409,
        }),
    );
    const t = new HttpTransport('http://127.0.0.1:4310', () => 'tok', fetchImpl as unknown as typeof fetch);
    const err = await t.request('POST', '/x', { a: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('COS-2002');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(init.credentials).toBe('omit');
  });

  it('parses a split SSE stream, reports raw activity for pings and stops at shutdown', async () => {
    const chunks = [
      'id: 1\nevent: task.ready\ndata: {"sequence":1,"type":"task.ready","payload":{}}\n\n',
      ': ping\n\n',
      'id: 2\nevent: task.',
      'started\ndata: {"sequence":2,"type":"task.started","payload":{}}\n\nevent: shutdown\ndata: {}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const t = new HttpTransport('http://127.0.0.1:4310', () => 'tok', fetchImpl as unknown as typeof fetch);
    const seen: number[] = [];
    const opened = vi.fn();
    const activity = vi.fn();
    const end = await t.stream(
      '/s',
      { onOpen: opened, onEvent: (e) => seen.push(e.sequence), onActivity: activity },
      new AbortController().signal,
    );
    expect(end).toBe('shutdown');
    expect(seen).toEqual([1, 2]);
    expect(opened).toHaveBeenCalledOnce();
    expect(activity.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('treats a 401 as the end of the session', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: 'COS-3005', message: 'revoked' } }), { status: 401 }),
    );
    const t = new HttpTransport('http://127.0.0.1:4310', () => 'tok', fetchImpl as unknown as typeof fetch);
    await expect(t.request('GET', '/x')).rejects.toBeInstanceOf(AuthError);
  });
});
