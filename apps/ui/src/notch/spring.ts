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
