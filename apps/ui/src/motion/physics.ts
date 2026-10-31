/**
 * Universal physics-based motion engine for Friday.
 *
 * Implements Hooke's Law damped harmonic motion with viscous damping:
 *   F = −k·(x − target) − c·v
 * Integrated with semi-implicit Euler in fixed sub-steps of 1/240 s with
 * fractional remainder time carry across frames for perfectly consistent
 * dynamics across 30, 60, 120 and 144 Hz displays.
 */

export interface SpringConfig {
  /** Stiffness (k): responsiveness and oscillation frequency. */
  stiffness: number;
  /** Damping (c): friction and overshoot suppression. */
  damping: number;
}

/**
 * Standard Apple Human Interface spring dynamics configurations.
 */
export const AppleSpring = {
  /** Snappy micro-interactions: buttons, pills, toggles, icon switches. */
  Snappy: Object.freeze<SpringConfig>({ stiffness: 340, damping: 28 }),
  /** Smooth transitions: slide rails, drawers, modals, sheet entries. */
  Smooth: Object.freeze<SpringConfig>({ stiffness: 240, damping: 24 }),
  /** Bouncy tactile reactions: mascot hops, alert pops, celebration badges. */
  Bouncy: Object.freeze<SpringConfig>({ stiffness: 180, damping: 14 }),
  /** Gentle ambient motion: gaze tracking, floating companion, idle breathing. */
  Gentle: Object.freeze<SpringConfig>({ stiffness: 120, damping: 18 }),
} as const;

export const SUBSTEP = 1 / 240;
export const MAX_DT = 0.1;
export const REST_DELTA = 0.01;
export const REST_SPEED = 0.1;
const EPS = 1e-9;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * A continuous 1D damped harmonic spring solver.
 */
export class PhysicsSpring {
  current: number;
  target: number;
  velocity = 0;
  #carry = 0;

  constructor(
    initial: number,
    readonly config: Readonly<SpringConfig> = AppleSpring.Smooth,
  ) {
    this.current = finite(initial, 0);
    this.target = this.current;
  }

  get moving(): boolean {
    return this.current !== this.target || this.velocity !== 0;
  }

  get settled(): boolean {
    return !this.moving;
  }

  setTarget(target: number): void {
    if (Number.isFinite(target)) this.target = target;
  }

  jump(target: number = this.target): void {
    if (Number.isFinite(target)) this.target = target;
    this.current = this.target;
    this.velocity = 0;
    this.#carry = 0;
  }

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

/**
 * Animates a DOM element numeric property using a PhysicsSpring.
 * Returns a cancel function.
 */
export function animateSpring(
  apply: (value: number) => void,
  from: number,
  to: number,
  config: Readonly<SpringConfig> = AppleSpring.Smooth,
  onComplete?: () => void,
): () => void {
  const spring = new PhysicsSpring(from, config);
  spring.setTarget(to);

  let rafId: number | null = null;
  let lastTime: number | null = null;

  function loop(now: number): void {
    if (lastTime === null) lastTime = now;
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    const moving = spring.step(dt);
    apply(spring.current);

    if (moving) {
      rafId = requestAnimationFrame(loop);
    } else {
      rafId = null;
      onComplete?.();
    }
  }

  rafId = requestAnimationFrame(loop);

  return () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}
