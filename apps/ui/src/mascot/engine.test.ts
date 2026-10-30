import { describe, expect, it } from 'vitest';
import {
  BLINK_MAX_S,
  BLINK_MIN_S,
  BlinkScheduler,
  BOUNCE_TWEEN,
  clamp,
  Ease,
  type Gesture,
  gazeFromPointer,
  JUMP_TWEEN,
  MascotEngine,
  PITCH_LIMIT,
  type Pose,
  Spring,
  seededRandom,
  smooth,
  Timeline,
  YAW_LIMIT,
} from './engine.js';
import { MASCOT_STATES } from './states.js';

function run(engine: MascotEngine, seconds: number, dt = 1 / 60): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) engine.tick(dt);
}

function finitePose(pose: Pose): boolean {
  const nums = [
    pose.t,
    pose.lift,
    pose.drop,
    pose.scaleX,
    pose.scaleY,
    pose.tilt,
    pose.yaw,
    pose.pitch,
    pose.lid,
    pose.blush,
    pose.earX,
    pose.earY,
    pose.tint.r,
    pose.tint.g,
    pose.tint.b,
    pose.glow,
    pose.light,
    pose.led,
    pose.shadow,
  ];
  return nums.every(Number.isFinite);
}

describe('smoothing', () => {
  it('reaches the same value at any frame rate', () => {
    let a = 0;
    let b = 0;
    let c = 0;
    for (let i = 0; i < 60; i++) a = smooth(a, 10, 0.01, 1 / 60);
    for (let i = 0; i < 30; i++) b = smooth(b, 10, 0.01, 1 / 30);
    for (let i = 0; i < 144; i++) c = smooth(c, 10, 0.01, 1 / 144);
    expect(a).toBeCloseTo(10 * (1 - 0.01), 6);
    expect(b).toBeCloseTo(a, 9);
    expect(c).toBeCloseTo(a, 9);
  });

  it('snaps when close, and survives bad input', () => {
    expect(smooth(9.999, 10, 0.01, 1 / 60)).toBe(10);
    expect(smooth(5, 10, 0.01, 0)).toBe(5);
    expect(smooth(5, 10, 0.01, -1)).toBe(5);
    expect(smooth(Number.NaN, 10, 0.01, 0.1)).toBe(10);
    expect(smooth(5, Number.NaN, 0.01, 0.1)).toBe(5);
    expect(clamp(Number.NaN, -1, 1)).toBe(0);
  });
});

describe('springs', () => {
  it('sub-steps at 1/240 s so the frame rate does not change the motion', () => {
    const make = () => {
      const s = new Spring(0, { stiffness: 180, damping: 12 });
      s.target = 10;
      return s;
    };
    const a = make();
    const b = make();
    const c = make();
    for (let i = 0; i < 60; i++) a.step(1 / 60);
    for (let i = 0; i < 30; i++) b.step(1 / 30);
    for (let i = 0; i < 240; i++) c.step(1 / 240);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(c.x).toBeCloseTo(a.x, 9);
    // Odd frame times carry their remainder: 7 ms frames end where 1/240 steps do.
    const d = make();
    for (let i = 0; i < 1000; i++) d.step(0.007);
    expect(Number.isFinite(d.x)).toBe(true);
  });

  it('settles exactly on its target and stays finite', () => {
    const s = new Spring(0);
    s.target = 5;
    for (let i = 0; i < 600 && !s.settled; i++) s.step(1 / 60);
    expect(s.settled).toBe(true);
    expect(s.x).toBe(5);
    s.step(Number.NaN);
    s.step(1 / 60, Number.NaN);
    expect(s.x).toBe(5);
    const wild = new Spring(0, { stiffness: 1e12, damping: 0 });
    wild.target = 1e300;
    wild.step(0.05);
    expect(Number.isFinite(wild.x)).toBe(true);
  });

  it('never simulates more than 0.05 s per call', () => {
    const a = new Spring(0);
    a.target = 10;
    a.step(10);
    const b = new Spring(0);
    b.target = 10;
    b.step(0.05);
    expect(a.x).toBeCloseTo(b.x, 12);
  });
});

describe('gaze', () => {
  it('clamps the pointer gaze to yaw ±0.85 and pitch ±0.65', () => {
    expect(gazeFromPointer(1e6, 1e6)).toEqual({ yaw: YAW_LIMIT, pitch: PITCH_LIMIT });
    expect(gazeFromPointer(-1e6, -1e6)).toEqual({ yaw: -YAW_LIMIT, pitch: -PITCH_LIMIT });
    expect(gazeFromPointer(160, -96)).toEqual({ yaw: 0.5, pitch: -0.3 });
    expect(gazeFromPointer(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ yaw: 0, pitch: 0 });
  });

  it('follows the pointer within the limits, and comes back when it leaves', () => {
    const e = new MascotEngine({ random: seededRandom(1) });
    e.setPointer({ dx: 5000, dy: -5000 });
    run(e, 2);
    expect(e.pose().yaw).toBeCloseTo(YAW_LIMIT, 3);
    expect(e.pose().pitch).toBeCloseTo(-PITCH_LIMIT, 3);
    e.setPointer(null);
    run(e, 2);
    expect(e.pose().yaw).toBe(0);
    expect(e.pose().pitch).toBe(0);
  });

  it('looks up and right while thinking, down while an approval waits', () => {
    const e = new MascotEngine({ random: seededRandom(2) });
    e.setState('thinking');
    run(e, 2);
    expect(e.pose().yaw).toBeCloseTo(0.55, 3);
    expect(e.pose().pitch).toBeCloseTo(-0.55, 3);
    e.setState('approval');
    run(e, 2);
    expect(e.pose().pitch).toBeCloseTo(0.45, 3);
  });
});

describe('tweens', () => {
  it('plays the jump of Part 02 §6 key by key', () => {
    const tl = new Timeline();
    tl.play('lift', JUMP_TWEEN);
    const at = (ms: number) => {
      const t = new Timeline();
      t.play('lift', JUMP_TWEEN);
      t.step(ms / 1000);
      return t.value('lift');
    };
    expect(at(0)).toBe(0);
    expect(at(60)).toBeCloseTo(-4 * Ease.inQuad(0.5), 9);
    expect(at(120)).toBeCloseTo(-4, 9);
    expect(at(360)).toBeCloseTo(28, 9);
    expect(at(440)).toBeCloseTo(26, 9);
    expect(at(620)).toBeCloseTo(-6, 9);
    expect(JUMP_TWEEN.map((k) => k.target)).toEqual([-4, 28, 26, -6, 0]);
    expect(JUMP_TWEEN.reduce((s, k) => s + k.durationMs, 0)).toBe(780);
    tl.step(0.78);
    expect(tl.value('lift')).toBe(0);
    expect(tl.active).toBe(false);
  });

  it('replaces an older tween on the same channel and calls onComplete once', () => {
    const tl = new Timeline();
    let done = 0;
    tl.play('lift', JUMP_TWEEN, () => done++);
    tl.step(0.2);
    const mid = tl.value('lift');
    tl.play('lift', BOUNCE_TWEEN, () => done++);
    // Starts from where the jump was.
    expect(tl.value('lift')).toBe(mid);
    for (let i = 0; i < 60; i++) tl.step(1 / 60);
    expect(done).toBe(1);
    expect(tl.value('lift')).toBe(0);
  });

  it('has easings that start at 0 and end at 1', () => {
    for (const [name, f] of Object.entries(Ease)) {
      expect(f(0), name).toBeCloseTo(0, 9);
      expect(f(1), name).toBeCloseTo(1, 9);
    }
  });
});

describe('blinks', () => {
  it('schedules blinks 3–6 s apart, sometimes double (seeded)', () => {
    const b = new BlinkScheduler(seededRandom(42), 0);
    let t = 0;
    let doubles = 0;
    let singles = 0;
    for (let i = 0; i < 300; i++) {
      const gap = b.next - t;
      expect(gap).toBeGreaterThanOrEqual(BLINK_MIN_S);
      expect(gap).toBeLessThanOrEqual(BLINK_MAX_S);
      expect(b.due(b.next - 0.001)).toBeNull();
      t = b.next;
      const kind = b.due(t);
      if (kind === 'double') doubles++;
      else if (kind === 'single') singles++;
    }
    expect(doubles + singles).toBe(300);
    expect(doubles).toBeGreaterThan(30);
    expect(singles).toBeGreaterThan(doubles);
  });

  it('blinks the idle engine every 3–6 s', () => {
    const e = new MascotEngine({ random: seededRandom(9) });
    const starts: number[] = [];
    let closed = false;
    for (let i = 0; i < 60 * 40; i++) {
      e.tick(1 / 60);
      const shut = e.pose().lid < 0.5;
      if (shut && !closed && (starts.length === 0 || e.t - (starts[starts.length - 1] ?? 0) > 1)) starts.push(e.t);
      closed = shut;
    }
    expect(starts.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < starts.length; i++) {
      const gap = (starts[i] ?? 0) - (starts[i - 1] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(BLINK_MIN_S - 0.05);
      expect(gap).toBeLessThanOrEqual(BLINK_MAX_S + 0.6);
    }
  });

  it('does not blink in states with closed or arched eyes', () => {
    const e = new MascotEngine({ random: seededRandom(3) });
    e.setState('sleeping');
    let minLid = 1;
    for (let i = 0; i < 60 * 15; i++) {
      e.tick(1 / 60);
      minLid = Math.min(minLid, e.pose().lid);
    }
    expect(minLid).toBe(1);
    expect(e.nextWakeIn()).toBeNull();
  });
});

describe('MascotEngine', () => {
  it('holds still once nothing moves, and says when the next blink is due', () => {
    const e = new MascotEngine({ random: seededRandom(4) });
    e.stimulate();
    expect(e.busy).toBe(true);
    run(e, 12);
    // A blink may be mid-way: finish it.
    for (let i = 0; i < 60 && e.busy; i++) e.tick(1 / 60);
    expect(e.busy).toBe(false);
    const wait = e.nextWakeIn();
    expect(wait).not.toBeNull();
    expect(wait ?? -1).toBeGreaterThanOrEqual(0);
    expect(wait ?? 99).toBeLessThanOrEqual(BLINK_MAX_S);
    e.setPointer({ dx: 10, dy: 0 });
    expect(e.busy).toBe(true);
  });

  it('stays finite through every state, gesture and odd frame time', () => {
    const e = new MascotEngine({ random: seededRandom(5) });
    const gestures: Gesture[] = ['bounce', 'hop', 'droop', 'jump', 'celebrate', 'sweat', 'alert', 'wink'];
    const dts = [1 / 60, 0, Number.NaN, -1, 10, 1e-6, 1 / 30, 0.2];
    let i = 0;
    for (const state of MASCOT_STATES) {
      e.setState(state);
      e.setTint({ r: 10 * i, g: 200, b: 30 });
      for (const g of gestures) {
        e.gesture(g);
        e.setPointer({ dx: (i % 3) * 1e4 - 1e4, dy: (i % 5) * 300 - 600 });
        for (const dt of dts) {
          e.tick(dt);
          expect(finitePose(e.pose()), `${state} ${g} ${dt}`).toBe(true);
        }
        i++;
      }
    }
    e.setTint({ r: Number.NaN, g: 0, b: 0 });
    e.tick(1 / 60);
    expect(finitePose(e.pose())).toBe(true);
  });

  it('jumps with confetti on completion, and the particles expire', () => {
    const e = new MascotEngine({ random: seededRandom(6) });
    e.gesture('jump');
    expect(e.particles.length).toBe(18);
    let top = 0;
    for (let k = 0; k < 60 * 3; k++) {
      e.tick(1 / 60);
      top = Math.max(top, e.pose().lift);
    }
    expect(top).toBeGreaterThan(20);
    expect(e.particles).toHaveLength(0);
    expect(e.pose().lift).toBeCloseTo(0, 6);
    e.gesture('celebrate');
    expect(e.particles.length).toBe(28);
  });

  it('bounces for 400 ms on a new node, hops happily, droops when denied', () => {
    const e = new MascotEngine({ random: seededRandom(7) });
    e.gesture('bounce');
    expect(e.eyes).toBe('wide');
    run(e, 0.2);
    expect(e.pose().lift).not.toBe(0);
    run(e, 0.25);
    expect(e.pose().lift).toBeCloseTo(0, 6);
    expect(BOUNCE_TWEEN.reduce((s, k) => s + k.durationMs, 0)).toBe(400);
    e.gesture('hop');
    expect(e.eyes).toBe('happy');
    expect(e.particles.length).toBeGreaterThan(0);
    run(e, 1.5);
    e.gesture('droop');
    expect(e.eyes).toBe('tired');
    run(e, 0.3);
    expect(e.pose().lift).toBeLessThan(0);
    run(e, 1.2);
    expect(e.eyes).toBe(e.look.eyes);
  });

  it('winks and blushes on a click', () => {
    const e = new MascotEngine({ random: seededRandom(8) });
    e.gesture('wink');
    run(e, 0.3);
    expect(e.eyes).toBe('wink');
    expect(e.pose().blush).toBeGreaterThan(0.9);
    run(e, 1.5);
    expect(e.pose().blush).toBe(0);
    expect(e.eyes).toBe('pill');
  });

  it('turns reactions into fades under reduced motion', () => {
    const e = new MascotEngine({ random: seededRandom(10), reduced: true });
    e.gesture('jump');
    expect(e.particles).toHaveLength(0);
    let glow = 0;
    for (let k = 0; k < 30; k++) {
      e.tick(1 / 60);
      glow = Math.max(glow, e.pose().glow);
      expect(e.pose().lift).toBe(0);
    }
    expect(glow).toBeGreaterThan(0.5);
    e.setPointer({ dx: 1e4, dy: 0 });
    run(e, 1);
    expect(e.pose().yaw).toBe(0);
    e.setState('sleeping');
    run(e, 5);
    expect(e.particles).toHaveLength(0);
    expect(e.ambient).toBe(false);
    // Switching it on mid-celebration clears the motion at once.
    const f = new MascotEngine({ random: seededRandom(11) });
    f.gesture('celebrate');
    f.setReduced(true);
    expect(f.particles).toHaveLength(0);
    expect(f.pose().lift).toBe(0);
  });

  it('emits sweat while in error and z while asleep, only while the motion runs', () => {
    const e = new MascotEngine({ random: seededRandom(12) });
    e.setState('error');
    run(e, 1);
    expect(e.particles.some((p) => p.type === 'sweat')).toBe(true);
    e.setState('sleeping');
    run(e, 3);
    expect(e.particles.some((p) => p.type === 'z')).toBe(true);
    run(e, 30);
    expect(e.particles).toHaveLength(0);
    expect(e.busy).toBe(false);
  });

  it('flattens when halted and lets the ears droop', () => {
    const e = new MascotEngine({ random: seededRandom(13) });
    e.setState('halted');
    run(e, 3);
    const pose = e.pose();
    expect(pose.eyes).toBe('x');
    expect(pose.scaleY).toBeCloseTo(0.72, 2);
    expect(pose.earX).toBeGreaterThan(3);
  });

  it('settles everything when it comes back after a pause', () => {
    const e = new MascotEngine({ random: seededRandom(14) });
    e.gesture('celebrate');
    e.setPointer({ dx: 400, dy: 0 });
    e.tick(1 / 60);
    e.resume(10);
    expect(e.particles).toHaveLength(0);
    expect(e.pose().lift).toBe(0);
    expect(e.pose().yaw).toBeCloseTo(0.85, 6);
    expect(e.busy).toBe(false);
    // A short gap (a blink timer) only moves the clock.
    const t = e.t;
    e.resume(0.1);
    expect(e.t).toBeCloseTo(t + 0.1, 9);
  });

  it('fades its tint toward the state colour, and can jump there', () => {
    const e = new MascotEngine({ random: seededRandom(15) });
    e.setTint({ r: 245, g: 158, b: 11 });
    e.tick(1 / 60);
    expect(e.pose().tint.r).toBeLessThan(245);
    e.snapTint();
    expect(e.pose().tint).toEqual({ r: 245, g: 158, b: 11 });
  });
});
