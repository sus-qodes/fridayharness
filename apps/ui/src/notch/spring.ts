/**
 * Damped springs for the island's geometry (handoff Part 01 §4, plan §7.8). Pure, no DOM.
 *
 * Hooke's law with viscous damping, `F = −k·(x − target) − c·v`, integrated with semi-implicit
 * Euler in fixed sub-steps of 1/240 s. A call's left-over time is carried to the next call, so the
 * motion is the same at 30, 60 or 144 frames per second. A spring settles exactly: once it is
 * within a hundredth of a pixel and nearly still, it snaps to its target and stops. Growing and
 * shrinking use the same spring.
 */

export interface SpringConfig {
  /** k: responsiveness. */
  stiffness: number;
  /** c: overshoot prevention. */
  damping: number;
}

/** Part 01 §4.1: the pill → card width. */
export const WIDTH_SPRING: Readonly<SpringConfig> = Object.freeze({ stiffness: 260, damping: 24 });
/** Part 01 §4: the spring's own values, used for the height (dynamic) and the corner radius. */
export const HEIGHT_SPRING: Readonly<SpringConfig> = Object.freeze({ stiffness: 240, damping: 22 });
export const RADIUS_SPRING: Readonly<SpringConfig> = Object.freeze({ stiffness: 240, damping: 22 });

/** The integration step (seconds). */
export const SUBSTEP = 1 / 240;
/** At most this much time is simulated per call: a tab coming back from the background resumes smoothly. */
export const MAX_DT = 0.1;
/** At rest when this close (px) … */
export const REST_DELTA = 0.01;
/** … and this slow (px/s). */
export const REST_SPEED = 0.1;

/** Float slack when counting sub-steps (1/60 must be exactly four of them). */
const EPS = 1e-9;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export class Spring {
  current: number;
  target: number;
  velocity = 0;
  #carry = 0;

  constructor(
    initial: number,
    readonly config: Readonly<SpringConfig> = HEIGHT_SPRING,
  ) {
    this.current = finite(initial, 0);
    this.target = this.current;
  }

  get moving(): boolean {
    return this.current !== this.target || this.velocity !== 0;
  }

  /** A new target; the spring keeps its velocity. Non-finite targets are ignored. */
  setTarget(target: number): void {
    if (Number.isFinite(target)) this.target = target;
  }

  /** Jumps to `target` (reduced motion): no motion, no velocity. */
  jump(target: number = this.target): void {
    if (Number.isFinite(target)) this.target = target;
    this.current = this.target;
    this.velocity = 0;
    this.#carry = 0;
  }

  /** Advances by `dt` seconds; returns true while it still moves. */
  step(dt: number): boolean {
    if (!this.moving) return false;
    if (!Number.isFinite(dt) || dt <= 0) return true;
    const k = this.config.stiffness;
    const c = this.config.damping;
    let time = Math.min(dt, MAX_DT) + this.#carry;
    while (time >= SUBSTEP - EPS) {
      time -= SUBSTEP;
      const force = -k * (this.current - this.target) - c * this.velocity;
      this.velocity += force * SUBSTEP;
      this.current += this.velocity * SUBSTEP;
      if (!Number.isFinite(this.current) || !Number.isFinite(this.velocity)) {
        this.jump();
        return false;
      }
      if (Math.abs(this.current - this.target) < REST_DELTA && Math.abs(this.velocity) < REST_SPEED) {
        this.jump();
        return false;
      }
    }
    this.#carry = Math.max(0, time);
    return true;
  }
}

export interface Geometry {
  width: number;
  height: number;
  radius: number;
}

/** The island's three springs, moved together. */
export class GeometrySprings {
  readonly width: Spring;
  readonly height: Spring;
  readonly radius: Spring;

  constructor(initial: Geometry) {
    this.width = new Spring(initial.width, WIDTH_SPRING);
    this.height = new Spring(initial.height, HEIGHT_SPRING);
    this.radius = new Spring(initial.radius, RADIUS_SPRING);
  }

  get moving(): boolean {
    return this.width.moving || this.height.moving || this.radius.moving;
  }

  get value(): Geometry {
    return { width: this.width.current, height: this.height.current, radius: this.radius.current };
  }

  get target(): Geometry {
    return { width: this.width.target, height: this.height.target, radius: this.radius.target };
  }

  /** New targets; `instant` (reduced motion) jumps there. */
  setTarget(g: Geometry, instant = false): void {
    for (const [spring, value] of [
      [this.width, g.width],
      [this.height, g.height],
      [this.radius, g.radius],
    ] as const) {
      if (instant) spring.jump(value);
      else spring.setTarget(value);
    }
  }

  /** Advances all three; true while any still moves. */
  step(dt: number): boolean {
    const w = this.width.step(dt);
    const h = this.height.step(dt);
    const r = this.radius.step(dt);
    return w || h || r;
  }
}

// ── Coucou Exact Physics (SwiftUI spring + 340ms close curve parity) ────────────

export const Ease = {
  out: (t: number) => 1 - (1 - t) ** 3,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  back: (t: number) => {
    const c1 = 1.7;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  lin: (t: number) => t,
  easeIn: (t: number) => t * t * t,
};

export type EaseFn = (t: number) => number;

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** cubic-bezier(x1,y1,x2,y2) — used for the 340 ms close curve (.45,0,.2,1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const cx = (t: number) => (1 - t) ** 2 * 3 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3;
  const cy = (t: number) => (1 - t) ** 2 * 3 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3;
  return (x) => {
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 12; i++) {
      const v = cx(t);
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return cy(t);
  };
}

export const closeCurve = cubicBezier(0.45, 0, 0.2, 1);

/**
 * SwiftUI-equivalent spring: ω₀ = 2π / response, ζ = dampingFraction.
 * Integrated per frame (sub-stepped at 240Hz) so a dropped frame never destabilises it.
 */
export class CoucouSpring {
  value: number;
  target: number;
  velocity = 0;
  omega: number;
  zeta: number;

  constructor(value: number, response = 0.5, damping = 0.72) {
    this.value = value;
    this.target = value;
    this.omega = (2 * Math.PI) / response;
    this.zeta = damping;
  }

  configure(response: number, damping: number) {
    this.omega = (2 * Math.PI) / response;
    this.zeta = damping;
  }

  set(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  get settled(): boolean {
    return Math.abs(this.target - this.value) < 0.01 && Math.abs(this.velocity) < 0.05;
  }

  step(dt: number) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const acc = this.omega * this.omega * (this.target - this.value) - 2 * this.zeta * this.omega * this.velocity;
      this.velocity += acc * h;
      this.value += this.velocity * h;
    }
  }
}

/**
 * Value driven either by a spring (growing) or a timed curve (shrinking) —
 * matches Coucou IslandContainer: openSpring for grow, closeEase 340 ms for shrink.
 */
export class Tracked {
  private spring: CoucouSpring;
  private curveFrom = 0;
  private curveTo = 0;
  private curveStart = 0;
  private curveDur = 0;
  private mode: 'spring' | 'curve' | 'idle' = 'idle';

  constructor(value: number) {
    this.spring = new CoucouSpring(value);
  }

  get value(): number {
    return this.spring.value;
  }

  get animating(): boolean {
    return this.mode !== 'idle';
  }

  jump(v: number) {
    this.spring.set(v);
    this.mode = 'idle';
  }

  /** Spring to `v` (open / grow) with SwiftUI response & damping. */
  springTo(v: number, response = 0.5, damping = 0.72) {
    this.spring.configure(response, damping);
    this.spring.target = v;
    this.mode = 'spring';
  }

  /** Timed curve to `v` (close / shrink), no overshoot. */
  curveTowards(v: number, durationMs = 340, now = performance.now()) {
    this.curveFrom = this.spring.value;
    this.curveTo = v;
    this.curveStart = now;
    this.curveDur = durationMs;
    this.spring.target = v;
    this.spring.velocity = 0;
    this.mode = 'curve';
  }

  step(dt: number, now = performance.now()) {
    if (this.mode === 'spring') {
      this.spring.step(dt);
      if (this.spring.settled) {
        this.spring.value = this.spring.target;
        this.spring.velocity = 0;
        this.mode = 'idle';
      }
    } else if (this.mode === 'curve') {
      const p = clamp((now - this.curveStart) / this.curveDur, 0, 1);
      this.spring.value = lerp(this.curveFrom, this.curveTo, closeCurve(p));
      if (p >= 1) {
        this.spring.velocity = 0;
        this.mode = 'idle';
      }
    }
  }
}
