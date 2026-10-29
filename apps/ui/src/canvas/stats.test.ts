import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { makeRun, makeScenario, makeSnapshot, makeTask } from '../test/fixtures.js';
import { StatRefresher, sumStats } from './stats.js';

const A = 'task_00000000000000000000api001';
const UI = 'task_00000000000000000000ui0001';
const DOCS = 'task_0000000000000000000doc001';

const diff = (added: number, removed: number, extra: Record<string, unknown>[] = []) => ({
  task_id: A,
  source: 'worktree',
  root: null,
  base: null,
  truncated: false,
  notes: [],
  files: [{ path: 'a.ts', added, removed }, { path: 'img.png', added: null, removed: null }, ...extra],
});

function setup(answers: Record<string, unknown> = {}): { ctx: TestContext; r: StatRefresher } {
  const ctx = makeContext({ snapshot: makeScenario(), answers });
  const r = new StatRefresher({ store: ctx.store, api: ctx.api, now: () => Date.now() });
  return { ctx, r };
}

const calls = (ctx: TestContext, id: string) => ctx.transport.to('GET', `/tasks/${id}/diff`).length;

describe('sumStats', () => {
  it('adds line counts and treats binary files as nothing', () => {
    expect(sumStats(diff(14, 2, [{ path: 'b.ts', added: 1, removed: 3 }]) as never)).toEqual({
      added: 15,
      removed: 5,
      files: 3,
    });
    expect(sumStats({ files: [] })).toEqual({ added: 0, removed: 0, files: 0 });
  });
});

describe('StatRefresher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the stat diff of a visible task that has a run and no counts yet', async () => {
    const { ctx, r } = setup({ [`GET /tasks/${A}/diff`]: diff(14, 2) });
    r.setVisible([A]);
    expect(calls(ctx, A)).toBe(1);
    expect(ctx.transport.calls[0]?.path).toContain('?stat=1');
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.store.select('ui').stats[A]).toMatchObject({ added: 14, removed: 2 });
    expect(r.filesOf(A)).toBe(2);
    // Counts known and nothing stale: no more reads.
    r.check();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls(ctx, A)).toBe(1);
    r.destroy();
  });

  it('skips tasks off screen and tasks without a run or a stale mark', async () => {
    const { ctx, r } = setup();
    r.setVisible([DOCS]); // PROPOSED, no run
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.transport.calls).toHaveLength(0);
    ctx.store.patch('ui', { staleStats: { [UI]: 1 } });
    r.check();
    expect(ctx.transport.calls).toHaveLength(0); // UI is not visible
    r.setVisible([UI]);
    expect(calls(ctx, UI)).toBe(1);
    r.destroy();
  });

  it('reads a stale task at most once per second', async () => {
    const { ctx, r } = setup({ [`GET /tasks/${A}/diff`]: diff(1, 0) });
    r.setVisible([A]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls(ctx, A)).toBe(1);
    // A write marks it stale right away: the next read waits for the second to pass.
    ctx.store.patch('ui', { staleStats: { [A]: Date.now() } });
    r.check();
    r.check();
    expect(calls(ctx, A)).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls(ctx, A)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls(ctx, A)).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.store.select('ui').staleStats[A]).toBeUndefined();
    // Many writes within a second still give one read per second.
    for (let i = 0; i < 10; i++) {
      ctx.store.patch('ui', { staleStats: { [A]: Date.now() + i } });
      r.check();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(calls(ctx, A)).toBe(3);
    r.destroy();
  });

  it('keeps one request in flight per task and keeps a mark that changed meanwhile', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { ctx, r } = setup({
      [`GET /tasks/${A}/diff`]: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    ctx.store.patch('ui', { staleStats: { [A]: 1 } });
    r.setVisible([A]);
    expect(calls(ctx, A)).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    r.check();
    expect(calls(ctx, A)).toBe(1); // still in flight
    ctx.store.patch('ui', { staleStats: { [A]: 2 } }); // a write during the read
    release(diff(3, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.store.select('ui').stats[A]).toMatchObject({ added: 3, removed: 1 });
    expect(ctx.store.select('ui').staleStats[A]).toBe(2);
    // It is read again (the throttle has long passed).
    expect(calls(ctx, A)).toBe(2);
    r.destroy();
  });

  it('waits after a failure unless a newer write marks the task', async () => {
    let fail = true;
    const { ctx, r } = setup({
      [`GET /tasks/${A}/diff`]: () => {
        if (fail) throw new Error('boom');
        return diff(5, 5);
      },
    });
    r.setVisible([A]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls(ctx, A)).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    r.check();
    expect(calls(ctx, A)).toBe(1);
    fail = false;
    ctx.store.patch('ui', { staleStats: { [A]: 7 } });
    r.check();
    expect(calls(ctx, A)).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.store.select('ui').stats[A]).toMatchObject({ added: 5, removed: 5 });
    r.destroy();
  });

  it('retries a failure after the retry delay', async () => {
    let n = 0;
    const ctx = makeContext({
      snapshot: makeSnapshot({ tasks: [makeTask({ task_id: A })], runs: { [A]: makeRun({ task_id: A }) } }),
      answers: {
        [`GET /tasks/${A}/diff`]: () => {
          n += 1;
          if (n === 1) throw new Error('boom');
          return diff(1, 1);
        },
      },
    });
    const r = new StatRefresher({ store: ctx.store, api: ctx.api, now: () => Date.now() }, { retryMs: 3000 });
    r.setVisible([A]);
    await vi.advanceTimersByTimeAsync(2000);
    r.check();
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    r.check();
    expect(n).toBe(2);
    r.destroy();
  });

  it('stops on destroy: no timer fires and late answers are ignored', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { ctx, r } = setup({
      [`GET /tasks/${A}/diff`]: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      [`GET /tasks/${UI}/diff`]: diff(1, 1),
    });
    r.setVisible([A, UI]);
    await vi.advanceTimersByTimeAsync(0);
    ctx.store.patch('ui', { staleStats: { [UI]: 9 } });
    r.check(); // throttled: a timer is set
    r.destroy();
    release(diff(9, 9));
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.store.select('ui').stats[A]).toBeUndefined();
    expect(calls(ctx, UI)).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
