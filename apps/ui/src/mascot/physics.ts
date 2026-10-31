/**
 * Hooke's Law Spring Physics & 11-DOF Mascot Rigging Solver.
 * Canonical character: "Friday". Strictly zero emojis.
 *
 * Implements second-order damped harmonic motion:
 *   m·a = -k·(x - target) - c·v
 * Integrated via semi-implicit Euler in fixed sub-steps of 1/240 s with
 * fractional remainder time carry across frames for frame-rate independence
 * across 30, 60, 120, and 144 Hz displays.
 */

import { FRIDAY_PIVOT_BODY, FRIDAY_PIVOT_SQUASH, type FridayPose, type MascotState } from './types.js';

export const SUBSTEP = 1 / 240;
export const MAX_DT = 0.1;
export const REST_DELTA = 0.01;
export const REST_SPEED = 0.1;
export const AREA_PRESERVE_FACTOR = 0.58;

const EPS = 1e-9;

/** Body rotation & anchor pivot (50% 92% in 120x120 grid). */
export const BODY_PIVOT = Object.freeze({ ...FRIDAY_PIVOT_BODY });

/** Ground contact squash pivot (50% 97% in 120x120 grid). */
export const SQUASH_PIVOT = Object.freeze({ ...FRIDAY_PIVOT_SQUASH });

export interface SpringConfig {
  /** Stiffness (k): spring restoring force coefficient. */
  stiffness: number;
  /** Damping (c): viscous velocity friction coefficient. */
  damping: number;
  /** Mass (m): inertial resistance, defaults to 1.0. */
  mass?: number;
}

export interface SpringChannelState {
  current: number;
  target: number;
  velocity: number;
}

/**
 * State-specific spring dynamics configurations.
 * Tuned to convey emotional weight and Apple-grade kinetic character.
 */
export const STATE_SPRING_CONFIGS: Record<MascotState, Readonly<SpringConfig>> = {
  /** Calm organic breathing: gentle smooth settling (zeta ~0.82). */
  idle: Object.freeze<SpringConfig>({ stiffness: 120, damping: 18, mass: 1.0 }),
  /** Floating wobble: underdamped float and contemplative drift (zeta ~0.63). */
  thinking: Object.freeze<SpringConfig>({ stiffness: 90, damping: 12, mass: 1.0 }),
  /** Energetic typing bounce: crisp responsive tapping (zeta ~0.65). */
  tool_execution: Object.freeze<SpringConfig>({ stiffness: 240, damping: 20, mass: 1.0 }),
  /** Celebratory high-bounce: loose bouncy joy (zeta ~0.41). */
  success: Object.freeze<SpringConfig>({ stiffness: 180, damping: 11, mass: 1.0 }),
  /** Rapid lateral jitter (Phase 1): high stiffness 12 Hz alert response. */
  error: Object.freeze<SpringConfig>({ stiffness: 450, damping: 16, mass: 1.0 }),
  /** Damped deep slow breathing: heavy soft overdamped ease (zeta ~1.15). */
  sleep: Object.freeze<SpringConfig>({ stiffness: 40, damping: 16, mass: 1.2 }),
};

/** Overdamped droop settle configuration for error phase 2 (zeta ~1.23). */
export const ERROR_DROOP_CONFIG: Readonly<SpringConfig> = Object.freeze<SpringConfig>({
  stiffness: 80,
  damping: 22,
  mass: 1.0,
});

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Calculates area-preserving horizontal scale sx given vertical scale sy:
 *   sx = 1.0 + (1.0 - sy) * preserveFactor
 *
 * Prevents visual melting or unnatural volume distortion while maintaining
 * tactile cartoon elasticity. Body pivot at (60, 110).
 */
export function computeAreaPreservingScaleX(scaleY: number, preserveFactor: number = AREA_PRESERVE_FACTOR): number {
  if (!Number.isFinite(scaleY)) return 1.0;
  return 1.0 + (1.0 - scaleY) * preserveFactor;
}

/**
 * Computes paired (scaleX, scaleY) squash and stretch maintaining mass.
 */
export function computeSquashStretch(
  scaleY: number,
  preserveFactor: number = AREA_PRESERVE_FACTOR,
): { scaleX: number; scaleY: number } {
  const sy = finite(scaleY, 1.0);
  const sx = computeAreaPreservingScaleX(sy, preserveFactor);
  return { scaleX: sx, scaleY: sy };
}

/**
 * Continuous 1D damped harmonic spring solver implementing Hooke's Law:
 *   F = -k·(x - target) - c·v
 * with fixed 1/240 s sub-stepping and fractional remainder carry across frames.
 */
export class HookeSpring {
  current: number;
  target: number;
  velocity = 0;
  #carry = 0;
  #config: SpringConfig;

  constructor(initial = 0, config: Readonly<SpringConfig> = STATE_SPRING_CONFIGS.idle) {
    this.current = finite(initial, 0);
    this.target = this.current;
    this.#config = {
      stiffness: finite(config.stiffness, 120),
      damping: finite(config.damping, 18),
      mass: finite(config.mass ?? 1.0, 1.0),
    };
  }

  get config(): Readonly<SpringConfig> {
    return this.#config;
  }

  get moving(): boolean {
    return this.current !== this.target || this.velocity !== 0;
  }

  get settled(): boolean {
    return !this.moving;
  }

  setConfig(config: Partial<SpringConfig>): void {
    if (config.stiffness !== undefined && Number.isFinite(config.stiffness)) {
      this.#config.stiffness = config.stiffness;
    }
    if (config.damping !== undefined && Number.isFinite(config.damping)) {
      this.#config.damping = config.damping;
    }
    if (config.mass !== undefined && Number.isFinite(config.mass) && config.mass > 0) {
      this.#config.mass = config.mass;
    }
  }

  setTarget(target: number): void {
    if (Number.isFinite(target)) {
      this.target = target;
    }
  }

  jump(target: number = this.target): void {
    if (Number.isFinite(target)) {
      this.target = target;
    }
    this.current = this.target;
    this.velocity = 0;
    this.#carry = 0;
  }

  reset(initial = 0): void {
    this.current = finite(initial, 0);
    this.target = this.current;
    this.velocity = 0;
    this.#carry = 0;
  }

  applyImpulse(force: number): void {
    if (Number.isFinite(force)) {
      const mass = this.#config.mass ?? 1.0;
      this.velocity += force / mass;
    }
  }

  step(dt: number): boolean {
    if (!this.moving) return false;
    if (!Number.isFinite(dt) || dt <= 0) return true;

    const k = this.#config.stiffness;
    const c = this.#config.damping;
    const m = this.#config.mass ?? 1.0;

    let time = Math.min(dt, MAX_DT) + this.#carry;

    while (time >= SUBSTEP - EPS) {
      time -= SUBSTEP;
      const force = -k * (this.current - this.target) - c * this.velocity;
      const accel = force / m;
      this.velocity += accel * SUBSTEP;
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
 * 11 Degree-of-Freedom Mascot Rigging Solver.
 *
 * Coordinates multi-channel spring physics for:
 * 1. bodyY: vertical elevation (px)
 * 2. bodyX: lateral peek / recoil (px)
 * 3. scaleY: vertical squash & stretch ratio
 * 4. scaleX: area-preserving companion scale ratio
 * 5. tilt: body & head expressive rotation (degrees)
 * 6. gazeYaw: eye horizontal tracking [-1..1]
 * 7. gazePitch: eye vertical tracking [-1..1]
 * 8. eyeLid: eyelid aperture [0..1]
 * 9. pawY: chubby paw vertical bob (px)
 * 10. pawAngle: chubby paw rotation (degrees)
 * 11. shadowScale: ground contact shadow scale ratio
 */
export class MascotRigSolver {
  readonly bodyY: HookeSpring;
  readonly bodyX: HookeSpring;
  readonly scaleY: HookeSpring;
  readonly scaleX: HookeSpring;
  readonly tilt: HookeSpring;
  readonly gazeYaw: HookeSpring;
  readonly gazePitch: HookeSpring;
  readonly eyeLid: HookeSpring;
  readonly pawY: HookeSpring;
  readonly pawAngle: HookeSpring;
  readonly shadowScale: HookeSpring;

  autoAreaPreserve = true;
  autoShadowTrack = true;

  constructor(initialPose: FridayPose = {}, config: Readonly<SpringConfig> = STATE_SPRING_CONFIGS.idle) {
    this.bodyY = new HookeSpring(initialPose.bodyY ?? 0, config);
    this.bodyX = new HookeSpring(initialPose.bodyX ?? 0, config);
    this.scaleY = new HookeSpring(initialPose.scaleY ?? 1.0, config);
    this.scaleX = new HookeSpring(initialPose.scaleX ?? computeAreaPreservingScaleX(initialPose.scaleY ?? 1.0), config);
    this.tilt = new HookeSpring(initialPose.tilt ?? 0, config);
    this.gazeYaw = new HookeSpring(initialPose.gazeYaw ?? 0, config);
    this.gazePitch = new HookeSpring(initialPose.gazePitch ?? 0, config);
    this.eyeLid = new HookeSpring(initialPose.eyeLid ?? 1.0, config);
    this.pawY = new HookeSpring(initialPose.pawY ?? 0, config);
    this.pawAngle = new HookeSpring(initialPose.pawAngle ?? 0, config);
    this.shadowScale = new HookeSpring(initialPose.shadowScale ?? 1.0, config);
  }

  get moving(): boolean {
    return (
      this.bodyY.moving ||
      this.bodyX.moving ||
      this.scaleY.moving ||
      this.scaleX.moving ||
      this.tilt.moving ||
      this.gazeYaw.moving ||
      this.gazePitch.moving ||
      this.eyeLid.moving ||
      this.pawY.moving ||
      this.pawAngle.moving ||
      this.shadowScale.moving
    );
  }

  get settled(): boolean {
    return !this.moving;
  }

  setSpringConfig(config: Readonly<SpringConfig>): void {
    this.bodyY.setConfig(config);
    this.bodyX.setConfig(config);
    this.scaleY.setConfig(config);
    this.scaleX.setConfig(config);
    this.tilt.setConfig(config);
    this.gazeYaw.setConfig(config);
    this.gazePitch.setConfig(config);
    this.eyeLid.setConfig(config);
    this.pawY.setConfig(config);
    this.pawAngle.setConfig(config);
    this.shadowScale.setConfig(config);
  }

  setChannelConfig(channel: keyof FridayPose, config: Partial<SpringConfig>): void {
    const spring = this.#getSpring(channel);
    if (spring) spring.setConfig(config);
  }

  setTargets(pose: Partial<FridayPose>): void {
    if (pose.bodyY !== undefined) this.bodyY.setTarget(pose.bodyY);
    if (pose.bodyX !== undefined) this.bodyX.setTarget(pose.bodyX);
    if (pose.scaleY !== undefined) {
      this.scaleY.setTarget(pose.scaleY);
      if (this.autoAreaPreserve && pose.scaleX === undefined) {
        this.scaleX.setTarget(computeAreaPreservingScaleX(pose.scaleY));
      }
    }
    if (pose.scaleX !== undefined) {
      this.scaleX.setTarget(pose.scaleX);
      this.autoAreaPreserve = false;
    }
    if (pose.tilt !== undefined) this.tilt.setTarget(pose.tilt);
    if (pose.gazeYaw !== undefined) this.gazeYaw.setTarget(pose.gazeYaw);
    if (pose.gazePitch !== undefined) this.gazePitch.setTarget(pose.gazePitch);
    if (pose.eyeLid !== undefined) this.eyeLid.setTarget(pose.eyeLid);
    if (pose.pawY !== undefined) this.pawY.setTarget(pose.pawY);
    if (pose.pawAngle !== undefined) this.pawAngle.setTarget(pose.pawAngle);
    if (pose.shadowScale !== undefined) {
      this.shadowScale.setTarget(pose.shadowScale);
      this.autoShadowTrack = false;
    }
  }

  jump(pose?: Partial<FridayPose>): void {
    if (pose) {
      this.setTargets(pose);
    }
    this.bodyY.jump();
    this.bodyX.jump();
    this.scaleY.jump();
    this.scaleX.jump();
    this.tilt.jump();
    this.gazeYaw.jump();
    this.gazePitch.jump();
    this.eyeLid.jump();
    this.pawY.jump();
    this.pawAngle.jump();
    this.shadowScale.jump();
  }

  applyImpulse(channel: keyof FridayPose, force: number): void {
    const spring = this.#getSpring(channel);
    if (spring) spring.applyImpulse(force);
  }

  step(dt: number): boolean {
    if (this.autoShadowTrack) {
      // In SVG coordinates, bodyY < 0 indicates lifting off the ground
      const lift = Math.max(0, -this.bodyY.current);
      const groundShadow = Math.max(0.35, Math.min(1.15, 1.0 - lift / 45));
      this.shadowScale.setTarget(groundShadow);
    }

    if (this.autoAreaPreserve && this.scaleY.moving) {
      this.scaleX.setTarget(computeAreaPreservingScaleX(this.scaleY.current));
    }

    const y = this.bodyY.step(dt);
    const x = this.bodyX.step(dt);
    const sy = this.scaleY.step(dt);
    const sx = this.scaleX.step(dt);
    const t = this.tilt.step(dt);
    const gy = this.gazeYaw.step(dt);
    const gp = this.gazePitch.step(dt);
    const el = this.eyeLid.step(dt);
    const py = this.pawY.step(dt);
    const pa = this.pawAngle.step(dt);
    const ss = this.shadowScale.step(dt);

    return y || x || sy || sx || t || gy || gp || el || py || pa || ss;
  }

  getPose(): FridayPose {
    return {
      bodyX: this.bodyX.current,
      bodyY: this.bodyY.current,
      scaleX: this.scaleX.current,
      scaleY: this.scaleY.current,
      tilt: this.tilt.current,
      gazeYaw: this.gazeYaw.current,
      gazePitch: this.gazePitch.current,
      eyeLid: this.eyeLid.current,
      pawY: this.pawY.current,
      pawAngle: this.pawAngle.current,
      shadowScale: this.shadowScale.current,
    };
  }

  getVelocities(): Record<string, number> {
    return {
      bodyX: this.bodyX.velocity,
      bodyY: this.bodyY.velocity,
      scaleX: this.scaleX.velocity,
      scaleY: this.scaleY.velocity,
      tilt: this.tilt.velocity,
      gazeYaw: this.gazeYaw.velocity,
      gazePitch: this.gazePitch.velocity,
      eyeLid: this.eyeLid.velocity,
      pawY: this.pawY.velocity,
      pawAngle: this.pawAngle.velocity,
      shadowScale: this.shadowScale.velocity,
    };
  }

  #getSpring(channel: keyof FridayPose): HookeSpring | undefined {
    switch (channel) {
      case 'bodyX':
        return this.bodyX;
      case 'bodyY':
        return this.bodyY;
      case 'scaleX':
        return this.scaleX;
      case 'scaleY':
        return this.scaleY;
      case 'tilt':
        return this.tilt;
      case 'gazeYaw':
        return this.gazeYaw;
      case 'gazePitch':
        return this.gazePitch;
      case 'eyeLid':
        return this.eyeLid;
      case 'pawY':
        return this.pawY;
      case 'pawAngle':
        return this.pawAngle;
      case 'shadowScale':
        return this.shadowScale;
      default:
        return undefined;
    }
  }
}
