import { describe, expect, it } from 'vitest';
import { GeometrySprings, HEIGHT_SPRING, MAX_DT, RADIUS_SPRING, Spring, SUBSTEP, WIDTH_SPRING } from './spring.js';

function run(spring: Spring, fps: number, seconds: number): number[] {
  const out: number[] = [];
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) {
    spring.step(1 / fps);
    out.push(spring.current);
  }
  return out;
}

function settle(spring: Spring, dt = 1 / 60, limit = 10_000): number {
  let frames = 0;
  while (spring.step(dt) && frames < limit) frames++;
  return frames;
}

describe('springs (Part 01 §4)', () => {
  it('uses the handoff values: width 260/24, height and radius 240/22, sub-steps of 1/240 s', () => {
    expect(WIDTH_SPRING).toEqual({ stiffness: 260, damping: 24 });
    expect(HEIGHT_SPRING).toEqual({ stiffness: 240, damping: 22 });
    expect(RADIUS_SPRING).toEqual({ stiffness: 240, damping: 22 });
    expect(SUBSTEP).toBeCloseTo(1 / 240, 12);
  });

  it('settles exactly on its target and then stops', () => {
    for (const [from, to] of [
      [200, 400],
      [400, 200],
      [32, 272],
      [4, 32],
      [0, 0.004],
      [-50, 1e6],
    ] as const) {
      const s = new Spring(from, WIDTH_SPRING);
      s.setTarget(to);
      const frames = settle(s);
      expect(frames).toBeLessThan(10_000);
      expect(s.current).toBe(to);
      expect(s.velocity).toBe(0);
      expect(s.moving).toBe(false);
      expect(s.step(1 / 60)).toBe(false);
    }
  });

  it('takes under two seconds to settle from pill to card', () => {
    const s = new Spring(200, WIDTH_SPRING);
    s.setTarget(400);
    expect(settle(s) / 60).toBeLessThan(2);
  });

  it('overshoots a little (under 5 %), never wildly', () => {
    const w = new Spring(200, WIDTH_SPRING);
    w.setTarget(400);
    const h = new Spring(32, HEIGHT_SPRING);
    h.setTarget(272);
    const wMax = Math.max(...run(w, 60, 2));
    const hMax = Math.max(...run(h, 60, 2));
    expect(wMax).toBeGreaterThan(400);
    expect(wMax).toBeLessThan(400 + 0.05 * 200);
    expect(hMax).toBeLessThan(272 + 0.05 * 240);
  });

  it('is frame-rate independent: 30, 60, 144 and 240 frames per second agree', () => {
    const at = (fps: number): number => {
      const s = new Spring(200, WIDTH_SPRING);
      s.setTarget(400);
      run(s, fps, 0.25);
      return s.current;
    };
    const ref = at(240);
    for (const fps of [30, 60, 120, 144]) expect(Math.abs(at(fps) - ref)).toBeLessThan(2);
    // 1/60 is exactly four sub-steps: 60 fps and 240 fps match to the float.
    expect(at(60)).toBeCloseTo(ref, 9);
  });

  it('grows and shrinks with the same spring (mirror-image motion)', () => {
    const grow = new Spring(200, WIDTH_SPRING);
    grow.setTarget(400);
    const shrink = new Spring(400, WIDTH_SPRING);
    shrink.setTarget(200);
    const g = run(grow, 60, 1);
    const s = run(shrink, 60, 1);
    for (let i = 0; i < g.length; i++) expect((g[i] ?? 0) - 200).toBeCloseTo(400 - (s[i] ?? 0), 6);
  });

  it('never yields NaN for any dt, and ignores bad targets', () => {
    const s = new Spring(200, WIDTH_SPRING);
    s.setTarget(400);
    for (const dt of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e-12, 1e9, 0.5, 1e-3]) {
      s.step(dt);
      expect(Number.isFinite(s.current)).toBe(true);
      expect(Number.isFinite(s.velocity)).toBe(true);
    }
    s.setTarget(Number.NaN);
    s.setTarget(Number.POSITIVE_INFINITY);
    expect(s.target).toBe(400);
    settle(s);
    expect(s.current).toBe(400);
    expect(new Spring(Number.NaN).current).toBe(0);
  });

  it('simulates at most MAX_DT per call (a tab back from the background resumes smoothly)', () => {
    const a = new Spring(200, WIDTH_SPRING);
    a.setTarget(400);
    a.step(30);
    const b = new Spring(200, WIDTH_SPRING);
    b.setTarget(400);
    b.step(MAX_DT);
    expect(a.current).toBeCloseTo(b.current, 9);
  });

  it('settles under random frame times', () => {
    let seed = 3;
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 50; i++) {
      const s = new Spring(rand() * 500, i % 2 ? WIDTH_SPRING : HEIGHT_SPRING);
      const target = rand() * 500;
      s.setTarget(target);
      let frames = 0;
      while (s.step(rand() * 0.08) && frames < 20_000) frames++;
      expect(s.current).toBe(target);
    }
  });

  it('jumps (reduced motion): at the target at once, not moving', () => {
    const s = new Spring(200, WIDTH_SPRING);
    s.setTarget(400);
    s.step(1 / 60);
    s.jump(320);
    expect(s).toMatchObject({ current: 320, target: 320, velocity: 0 });
    expect(s.moving).toBe(false);
    s.jump(Number.NaN);
    expect(s.current).toBe(320);
  });

  it('keeps its velocity when the target changes mid-flight', () => {
    const s = new Spring(200, WIDTH_SPRING);
    s.setTarget(400);
    run(s, 60, 0.1);
    const v = s.velocity;
    s.setTarget(200);
    expect(s.velocity).toBe(v);
    settle(s);
    expect(s.current).toBe(200);
  });
});

describe('geometry springs', () => {
  it('moves width, height and radius together and settles', () => {
    const g = new GeometrySprings({ width: 200, height: 32, radius: 16 });
    expect(g.moving).toBe(false);
    g.setTarget({ width: 400, height: 240, radius: 24 });
    expect(g.moving).toBe(true);
    expect(g.target).toEqual({ width: 400, height: 240, radius: 24 });
    let frames = 0;
    while (g.step(1 / 60) && frames < 10_000) frames++;
    expect(g.value).toEqual({ width: 400, height: 240, radius: 24 });
    expect(g.moving).toBe(false);
  });

  it('jumps all three with reduced motion', () => {
    const g = new GeometrySprings({ width: 200, height: 32, radius: 16 });
    g.setTarget({ width: 120, height: 4, radius: 2 }, true);
    expect(g.value).toEqual({ width: 120, height: 4, radius: 2 });
    expect(g.step(1 / 60)).toBe(false);
  });
});
