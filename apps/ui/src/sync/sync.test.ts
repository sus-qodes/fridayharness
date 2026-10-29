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
import { UI_API } from '../shell/version.js';
import { createStore, type FridayStore } from '../store/state.js';
import { makeAgent, makeApproval, makeEvent, makeRun, makeSnapshot, makeTask } from '../test/fixtures.js';
import { approvalFromEvent, Dispatcher, isDomainEvent } from './dispatcher.js';
import {
  DRAINING_CODE,
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
