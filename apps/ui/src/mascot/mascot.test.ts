import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { makeApproval, makeSnapshot } from '../test/fixtures.js';
import { seededRandom } from './engine.js';
import { createMascot, createMascotWith, type MascotEnv, type MascotHandle, setCursor } from './mascot.js';
import { type Recorded, recordingContext } from './testing.js';

interface FakeEnv extends MascotEnv {
  frames: Map<number, () => void>;
  timers: Map<number, { fn: () => void; ms: number }>;
  clock: { ms: number };
  dpr: number;
  logs: Recorded[];
  observers: { cb: IntersectionObserverCallback; disconnected: boolean }[];
  /** Runs the pending frames, advancing the clock by `dt` ms first. */
  step(dt?: number): number;
  /** Runs frames until none is pending (at most `max`). */
  settle(max?: number): number;
  /** Fires the soonest timer, advancing the clock to it. */
  fireNext(): void;
  /** Timers due within `ms` (the blink timer; the state re-check waits longer). */
  soon(ms?: number): number;
}

function fakeEnv(opts: { io?: boolean; dpr?: number } = {}): FakeEnv {
  let next = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const clock = { ms: 1_000 };
  const logs: Recorded[] = [];
  const observers: FakeEnv['observers'] = [];
  class FakeIO {
    readonly entry: { cb: IntersectionObserverCallback; disconnected: boolean };
    constructor(cb: IntersectionObserverCallback) {
      this.entry = { cb, disconnected: false };
      observers.push(this.entry);
    }
    observe() {}
    disconnect() {
      this.entry.disconnected = true;
    }
  }
  const env: FakeEnv = {
    doc: document,
    frames,
    timers,
    clock,
    logs,
    observers,
    dpr: opts.dpr ?? 1,
    raf: (cb) => {
      const id = next++;
      frames.set(id, cb);
      return id;
    },
    caf: (id) => {
      frames.delete(id);
    },
    now: () => clock.ms,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
    devicePixelRatio: () => env.dpr,
    context: () => {
      const { g, log } = recordingContext();
      logs.push(log);
      return g;
    },
    matchMedia: null,
    IntersectionObserver: opts.io ? (FakeIO as unknown as typeof IntersectionObserver) : null,
    random: seededRandom(3),
    step(dt = 16) {
      clock.ms += dt;
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, cb] of pending) cb();
      return pending.length;
    },
    settle(max = 2_000) {
      let n = 0;
      while (frames.size && n < max) {
        env.step();
        n++;
      }
      return n;
    },
    fireNext() {
      const first = [...timers.entries()].sort((a, b) => a[1].ms - b[1].ms)[0];
      if (!first) return;
      timers.delete(first[0]);
      clock.ms += first[1].ms;
      first[1].fn();
    },
    soon(ms = 6_000) {
      return [...timers.values()].filter((t) => t.ms <= ms).length;
    },
  };
  return env;
}

let ctx: TestContext;
let mascot: MascotHandle | null = null;

beforeEach(() => {
  ctx = makeContext();
  ctx.store.patch('system', { connection: 'live', snapshotAt: ctx.clock.now - 1_000 });
  ctx.store.patch('activity', { lastActivityAt: ctx.clock.now - 1_000 });
});

afterEach(() => {
  mascot?.destroy();
  mascot = null;
  setCursor(null);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('createMascot', () => {
  it('renders a canvas of size × size CSS pixels with its backing store at min(2, dpr)', () => {
    for (const [dpr, backing] of [
      [1, 40],
      [1.5, 60],
      [3, 80],
      [0, 40],
    ] as const) {
      const env = fakeEnv({ dpr });
      const m = createMascotWith(ctx, { size: 40 }, env);
      expect(m.el.tagName).toBe('CANVAS');
      expect(m.el.style.width).toBe('40px');
      expect(m.el.style.height).toBe('40px');
      expect(m.el.width).toBe(backing);
      expect(m.el.height).toBe(backing);
      expect(m.el.className).toBe('ms-canvas');
      expect(m.el.getAttribute('role')).toBe('img');
      expect(m.el.hasAttribute('tabindex')).toBe(false);
      m.destroy();
    }
  });

  it('draws its first picture at once and works in a real page without a canvas implementation', () => {
    const env = fakeEnv();
    mascot = createMascotWith(ctx, { size: 36 }, env);
    expect(env.logs[0]?.calls.some((c) => c.name === 'setTransform')).toBe(true);
    // happy-dom has no 2D context: the default environment draws nothing and does not throw.
    const real = createMascot(ctx, { size: 24 });
    expect(real.el.width).toBeGreaterThan(0);
    real.destroy();
  });

  it('animates only while something moves, then waits for the next blink', () => {
    const env = fakeEnv();
    mascot = createMascotWith(ctx, { size: 36 }, env);
    expect(env.frames.size).toBe(1);
    const frames = env.settle();
    expect(frames).toBeGreaterThan(10);
    expect(env.frames.size).toBe(0);
    // Holding still: no frames, one timer for the next blink (and the state's slow re-check).
    expect(env.soon()).toBe(1);
    const wait = Math.min(...[...env.timers.values()].map((t) => t.ms));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(6_000);
    env.fireNext();
    expect(env.frames.size).toBe(1);
    env.settle();
    expect(env.frames.size).toBe(0);
  });

  it('wakes for a state change and a reaction', () => {
    const env = fakeEnv();
    mascot = createMascotWith(ctx, { size: 36 }, env);
    env.settle();
    ctx.board(makeSnapshot({ approvals: [makeApproval()] }));
    expect(mascot.state).toBe('approval');
    expect(env.frames.size).toBe(1);
    env.settle(200);
    const a = ctx.store.select('activity');
    ctx.store.setState({ activity: { ...a, reactions: [{ id: 999, kind: 'completed', at: ctx.clock.now }] } });
    env.step();
    expect(mascot.engine.particles.length).toBeGreaterThan(0);
  });

  it('stops its loop and timers on destroy, and removes the canvas', () => {
    const env = fakeEnv();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const m = createMascotWith(ctx, { size: 36 }, env);
    host.appendChild(m.el);
    expect(m.running).toBe(true);
    m.destroy();
    expect(m.running).toBe(false);
    expect(env.frames.size).toBe(0);
    expect(env.timers.size).toBe(0);
    expect(host.contains(m.el)).toBe(false);
    // Nothing wakes it any more: store changes, pointer moves, visibility.
    ctx.board(makeSnapshot({ approvals: [makeApproval()] }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 5 }));
    setCursor(10, 10);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(env.frames.size).toBe(0);
    expect(env.timers.size).toBe(0);
    m.destroy();
  });

  it('stops while the document is hidden and resumes when it is shown', () => {
    const env = fakeEnv();
    mascot = createMascotWith(ctx, { size: 36 }, env);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(env.frames.size).toBe(0);
    expect(env.soon()).toBe(0);
    ctx.board(makeSnapshot({ approvals: [makeApproval()] }));
    expect(env.frames.size).toBe(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(env.frames.size).toBe(1);
  });

  it('stops while off screen (IntersectionObserver) and stops observing on destroy', () => {
    const env = fakeEnv({ io: true });
    mascot = createMascotWith(ctx, { size: 36 }, env);
    const io = env.observers[0];
    expect(io).toBeDefined();
    io?.cb([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(env.frames.size).toBe(0);
    io?.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(env.frames.size).toBe(1);
    mascot.destroy();
    expect(io?.disconnected).toBe(true);
    mascot = null;
  });

  it('follows the cursor, from the page or from the desktop shell', () => {
    const env = fakeEnv();
    mascot = createMascotWith(ctx, { size: 36 }, env);
    vi.spyOn(mascot.el, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 0,
      width: 36,
      height: 36,
      right: 136,
      bottom: 36,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
    env.settle();
    setCursor(5_000, 18);
    expect(env.frames.size).toBe(1);
    env.settle();
    expect(mascot.engine.pose().yaw).toBeCloseTo(0.85, 3);
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 0, clientY: 18 }));
    env.settle();
    expect(mascot.engine.pose().yaw).toBeLessThan(0);
    document.dispatchEvent(new PointerEvent('pointerout', { clientX: 0, clientY: 0 }));
    env.settle();
    expect(mascot.engine.pose().yaw).toBe(0);
  });

  it('winks and blushes when an interactive mascot is clicked or pressed', () => {
    const env = fakeEnv();
    mascot = createMascotWith(ctx, { size: 56, interactive: true }, env);
    expect(mascot.el.getAttribute('role')).toBe('button');
    expect(mascot.el.tabIndex).toBe(0);
    expect(mascot.el.className).toContain('ms-interactive');
    expect(mascot.el.getAttribute('aria-label')).toContain('Friday');
    mascot.el.click();
    expect(mascot.engine.eyes).toBe('wink');
    env.settle();
    const key = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    mascot.el.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(mascot.engine.eyes).toBe('wink');
    const other = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
    mascot.el.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it('does not react to clicks when not interactive', () => {
    const env = fakeEnv();
    mascot = createMascotWith(ctx, { size: 56 }, env);
    mascot.el.click();
    expect(mascot.engine.eyes).toBe('pill');
  });

  it('says what it shows, with agent text as visible text', () => {
    const env = fakeEnv();
    mascot = createMascotWith(ctx, { size: 56 }, env);
    expect(mascot.el.getAttribute('aria-label')).toBe('Friday is idle');
    const hostile = `<img src=x onerror=alert(1)>‮​${'a'.repeat(5_000)}`;
    ctx.board(makeSnapshot({ approvals: [makeApproval({ capability: hostile })] }));
    const label = mascot.el.getAttribute('aria-label') ?? '';
    expect(label.startsWith('An approval waits for you (')).toBe(true);
    expect(label).toContain('<img src=x onerror=alert(1)>');
    expect(label).toContain('⟨U+202E⟩');
    expect(label).toContain('⟨U+200B⟩');
    expect(label).not.toContain('‮');
    expect(label.length).toBeLessThan(200);
    expect(mascot.el.title).toBe(label);
    expect(document.querySelector('img')).toBeNull();
    expect(mascot.el.childNodes).toHaveLength(0);
    ctx.store.patch('board', {
      control: { paused: true, reason: null, changed_at: null, changed_by: null, halted_at: null },
      approvals: [],
    });
    expect(mascot.el.getAttribute('aria-label')).toBe('Friday is paused');
  });

  it('clamps a nonsense size', () => {
    const env = fakeEnv();
    mascot = createMascotWith(ctx, { size: Number.NaN }, env);
    expect(mascot.el.style.width).toBe('24px');
    mascot.destroy();
    mascot = createMascotWith(ctx, { size: 1e6 }, env);
    expect(mascot.el.style.width).toBe('512px');
  });

  it('redraws with the chosen outfit', () => {
    const env = fakeEnv();
    mascot = createMascotWith(ctx, { size: 56 }, env);
    env.settle();
    ctx.store.patch('prefs', { outfit: 'witch' });
    expect(env.frames.size).toBe(1);
    env.step();
    const log = env.logs[0];
    // The witch hat's brim is an ellipse drawn on the canvas.
    expect(log?.calls.some((c) => c.name === 'ellipse')).toBe(true);
  });
});
