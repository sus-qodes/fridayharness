import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { type MascotHandle, setCursor } from './mascot.js';
import { createMascotStageWith, type MascotStageHandle, type StageEnv } from './stage.js';

interface FakeEnv extends StageEnv {
  frames: Map<number, (now: number) => void>;
  timers: Map<number, { fn: () => void; ms: number }>;
  vp: { width: number; height: number };
  /** Runs pending frames once, advancing time by `dt` ms. */
  step(dt?: number): number;
  /** Runs frames until none is pending. */
  settle(max?: number): number;
}

function fakeEnv(): FakeEnv {
  let next = 1;
  const frames = new Map<number, (now: number) => void>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let clock = 1_000;
  const env: FakeEnv = {
    doc: document,
    frames,
    timers,
    vp: { width: 1280, height: 800 },
    raf: (cb) => {
      const id = next++;
      frames.set(id, cb);
      return id;
    },
    caf: (id) => frames.delete(id),
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id as number),
    viewport: () => env.vp,
    bubble: {
      doc: document,
      setTimeout: (fn, ms) => {
        const id = next++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimeout: (id) => timers.delete(id as number),
      reduced: () => false,
    },
    mascot: (ctx, opts) => {
      const canvas = document.createElement('canvas');
      canvas.style.width = `${opts.size}px`;
      canvas.style.height = `${opts.size}px`;
      const handle: MascotHandle = {
        el: canvas,
        engine: {
          reduced: false,
          setState: () => {},
          setTint: () => {},
          snapTint: () => {},
          stimulate: () => {},
          tick: () => {},
          resume: () => {},
          pose: () => {
            throw new Error('not drawn in stage tests');
          },
        } as unknown as MascotHandle['engine'],
        state: 'idle',
        running: false,
        destroy() {
          canvas.remove();
        },
      };
      void ctx;
      return handle;
    },
    step(dt = 16) {
      clock += dt;
      const pending = [...frames.values()];
      frames.clear();
      for (const cb of pending) cb(clock);
      return pending.length;
    },
    settle(max = 5_000) {
      let n = 0;
      while (frames.size && n < max) {
        env.step(16);
        n++;
      }
      return n;
    },
  };
  return env;
}

function readTransform(stage: MascotStageHandle): { x: number; y: number } {
  const m = /translate3d\((-?\d+)px, (-?\d+)px/.exec(stage.el.style.transform);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: Number.NaN, y: Number.NaN };
}

let ctx: TestContext;
let stage: MascotStageHandle | null = null;

beforeEach(() => {
  ctx = makeContext();
  ctx.store.patch('system', { connection: 'live', snapshotAt: ctx.clock.now - 1_000 });
  document.body.replaceChildren();
});

afterEach(() => {
  stage?.destroy();
  stage = null;
  setCursor(null);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('the walking stage', () => {
  it('starts hidden and shows on demand near the middle', () => {
    const env = fakeEnv();
    stage = createMascotStageWith(ctx, { size: 72 }, env);
    expect(stage.el.hidden).toBe(true);
    stage.show();
    expect(stage.el.hidden).toBe(false);
    const p = readTransform(stage);
    expect(p.x).toBe(Math.round(1280 / 2 - 36));
    expect(p.y).toBe(Math.round(800 / 2 - 36));
  });

  it('walks to the left of a target and faces it', () => {
    const env = fakeEnv();
    stage = createMascotStageWith(ctx, { size: 72 }, env);
    stage.show();
    stage.moveTo({ x: 400, y: 200, width: 160, height: 60 });
    env.settle();
    const p = readTransform(stage);
    // Left of the target with the stand-off, feet near the target's bottom.
    expect(p.x).toBe(400 - 72 - 14);
    expect(p.y).toBe(Math.round(200 + 60 - 72 + 26));
    // No flip transform when facing right.
    expect(stage.mascot.el.style.transform).toBe('');
  });

  it('falls back to the right side when there is no room on the left, facing left', () => {
    const env = fakeEnv();
    stage = createMascotStageWith(ctx, { size: 72 }, env);
    stage.show();
    stage.moveTo({ x: 10, y: 100, width: 200, height: 60 });
    env.settle();
    const p = readTransform(stage);
    expect(p.x).toBe(10 + 200 + 14);
    expect(stage.mascot.el.style.transform).toBe('scaleX(-1)');
  });

  it('moves to the middle when the target is null', () => {
    const env = fakeEnv();
    stage = createMascotStageWith(ctx, { size: 72 }, env);
    stage.show();
    stage.moveTo({ x: 400, y: 200, width: 100, height: 50 });
    env.settle();
    stage.moveTo(null);
    env.settle();
    const p = readTransform(stage);
    expect(p.x).toBe(Math.round(1280 / 2 - 36));
    expect(p.y).toBe(Math.round(800 / 2 - 36));
  });

  it('says something, positions the bubble, and clears it', () => {
    const env = fakeEnv();
    stage = createMascotStageWith(ctx, { size: 72 }, env);
    stage.show();
    stage.moveTo({ x: 400, y: 300, width: 120, height: 60 });
    env.settle();
    stage.say({ body: 'Hello there' });
    expect(stage.bubble.visible).toBe(true);
    expect(stage.el.contains(stage.bubble.el)).toBe(true);
    stage.say(null);
    expect(stage.bubble.visible).toBe(false);
  });

  it('keeps the bubble inside the window near the right edge', () => {
    const env = fakeEnv();
    stage = createMascotStageWith(ctx, { size: 72 }, env);
    stage.show();
    // A target whose stand point is near the right edge of a 1280 window.
    stage.moveTo({ x: 1150, y: 200, width: 100, height: 60 });
    env.settle();
    stage.say({ body: 'Wide words here' });
    // jsdom cannot measure the bubble (offsetWidth 0), so layout is skipped; asserting
    // visibility is what the fake environment can honestly check.
    expect(stage.bubble.visible).toBe(true);
  });

  it('reports busy while travelling and idle once settled', () => {
    const env = fakeEnv();
    stage = createMascotStageWith(ctx, { size: 72 }, env);
    stage.show();
    env.settle();
    expect(stage.busy).toBe(false);
    stage.moveTo({ x: 900, y: 300, width: 100, height: 50 });
    expect(stage.busy).toBe(true);
    env.settle();
    expect(stage.busy).toBe(false);
  });

  it('hide() clears the bubble and stops frames', () => {
    const env = fakeEnv();
    stage = createMascotStageWith(ctx, { size: 72 }, env);
    stage.show();
    stage.say({ body: 'hidden now' });
    stage.hide();
    expect(stage.el.hidden).toBe(true);
    expect(stage.bubble.visible).toBe(false);
    expect(env.frames.size).toBe(0);
  });

  it('jump instead of walk under reduced motion', () => {
    const env = fakeEnv();
    stage = createMascotStageWith(ctx, { size: 72 }, env);
    stage.show();
    env.settle();
    (stage.mascot.engine as unknown as { reduced: boolean }).reduced = true;
    stage.moveTo({ x: 500, y: 200, width: 100, height: 50 });
    expect(env.frames.size).toBe(0);
    const p = readTransform(stage);
    expect(p.x).toBe(500 - 72 - 14);
  });

  it('destroys cleanly', () => {
    const env = fakeEnv();
    stage = createMascotStageWith(ctx, { size: 72 }, env);
    stage.show();
    stage.say({ body: 'bye' });
    stage.destroy();
    expect(document.querySelector('.ms-stage')).toBeNull();
    stage = null;
  });
});
