/**
 * Mascot State Transition Kinetics & 11-DOF Motion Controller.
 * Canonical character: "Friday". Strictly zero emojis.
 *
 * Implements:
 * - State-specific spring dynamics (idle, thinking, tool_execution, success, error, sleep)
 * - C¹ velocity continuity across state transitions (zero popping or position snapping)
 * - Area-preserving squash and stretch
 * - Reduced-motion accessibility fallback
 * - Direct DOM transform application on SVG hierarchy:
 *   (#friday-shadow, #friday-pos, #friday-rot, #friday-squash, #friday-face, #friday-paw-left)
 */

import { computeAreaPreservingScaleX, ERROR_DROOP_CONFIG, MascotRigSolver, STATE_SPRING_CONFIGS } from './physics.js';
import {
  FRIDAY_PIVOT_BODY,
  FRIDAY_PIVOT_SQUASH,
  type FridayPose,
  type MascotState,
  toCanonicalState,
} from './types.js';

export interface MascotMotionOptions {
  initialState?: MascotState;
  reducedMotion?: boolean;
  autoStart?: boolean;
}

/**
 * Base rest poses for each lifecycle state.
 */
export const STATE_BASE_POSES: Record<MascotState, Readonly<FridayPose>> = {
  idle: Object.freeze<FridayPose>({
    bodyX: 0,
    bodyY: 0,
    scaleX: 1.0,
    scaleY: 1.0,
    tilt: 0,
    gazeYaw: 0,
    gazePitch: 0,
    eyeLid: 1.0,
    pawX: 0,
    pawY: 0,
    pawAngle: 0,
    shadowScale: 1.0,
  }),
  thinking: Object.freeze<FridayPose>({
    bodyX: 0,
    bodyY: -2.0,
    scaleX: 1.0,
    scaleY: 1.0,
    tilt: 4.0,
    gazeYaw: 0.35,
    gazePitch: -0.3,
    eyeLid: 1.0,
    pawX: 0,
    pawY: 0,
    pawAngle: 0,
    shadowScale: 0.95,
  }),
  tool_execution: Object.freeze<FridayPose>({
    bodyX: 0,
    bodyY: 0,
    scaleX: 1.0,
    scaleY: 1.0,
    tilt: -2.0,
    gazeYaw: 0,
    gazePitch: 0.4,
    eyeLid: 1.0,
    pawX: 0,
    pawY: 0,
    pawAngle: 0,
    shadowScale: 1.0,
  }),
  success: Object.freeze<FridayPose>({
    bodyX: 0,
    bodyY: 0,
    scaleX: 1.0,
    scaleY: 1.0,
    tilt: 0,
    gazeYaw: 0,
    gazePitch: 0,
    eyeLid: 1.0,
    pawX: 0,
    pawY: 0,
    pawAngle: 0,
    shadowScale: 1.0,
  }),
  error: Object.freeze<FridayPose>({
    bodyX: 0,
    bodyY: 5.0,
    scaleX: 1.052,
    scaleY: 0.91,
    tilt: -3.0,
    gazeYaw: 0,
    gazePitch: -0.1,
    eyeLid: 1.0,
    pawX: 0,
    pawY: 2.0,
    pawAngle: 0,
    shadowScale: 1.05,
  }),
  sleep: Object.freeze<FridayPose>({
    bodyX: 0,
    bodyY: 2.0,
    scaleX: 1.023,
    scaleY: 0.96,
    tilt: 4.0,
    gazeYaw: 0,
    gazePitch: 0,
    eyeLid: 0.0,
    pawX: 0,
    pawY: 1.0,
    pawAngle: 0,
    shadowScale: 1.02,
  }),
};

/**
 * Computes procedural continuous harmonics for each lifecycle state.
 *
 * Frequencies:
 * - idle: breathing f = 0.35 Hz
 * - thinking: wobble f = 0.5 Hz, eye scan f = 0.8 Hz
 * - tool_execution: typing bob f = 2.8 Hz, paw typing f = 4.2 Hz
 * - success: celebratory apex jump sequence (+26px) with elastic settling
 * - error: rapid lateral jitter 12 Hz settling into overdamped droop (+5px)
 * - sleep: slow gentle breathing f = 0.20 Hz
 */
export function computeStateHarmonics(
  state: MascotState,
  stateElapsed: number,
  _totalElapsed: number,
): Partial<FridayPose> {
  const t = Math.max(0, stateElapsed);

  switch (state) {
    case 'idle': {
      // Gentle organic breathing at 0.35 Hz
      const wBreath = 2 * Math.PI * 0.35;
      const breathSin = Math.sin(wBreath * t);
      const sy = 1.0 + breathSin * 0.02;
      const sx = computeAreaPreservingScaleX(sy);

      // Periodic natural blink every 4.0s for ~0.12s
      const blinkCycle = t % 4.0;
      const eyeLid = blinkCycle < 0.12 ? 0.0 : 1.0;

      return {
        bodyX: 0,
        bodyY: -breathSin * 1.5,
        scaleY: sy,
        scaleX: sx,
        tilt: 0,
        gazeYaw: 0,
        gazePitch: 0,
        eyeLid,
        pawY: 0,
        pawAngle: 0,
      };
    }

    case 'thinking': {
      // Floating wobble at 0.5 Hz with inquisitively cocked head
      const wWobble = 2 * Math.PI * 0.5;
      const wobbleSin = Math.sin(wWobble * t);
      const wobbleCos = Math.cos(wWobble * t);

      // Eye scan at 0.8 Hz
      const wScan = 2 * Math.PI * 0.8;
      const gazeYaw = 0.35 + Math.sin(wScan * t) * 0.15;
      const gazePitch = -0.3 + Math.cos(wWobble * t) * 0.08;

      return {
        bodyX: 0,
        bodyY: -2.0 + wobbleCos * 2.0,
        tilt: 4.0 + wobbleSin * 2.5,
        gazeYaw,
        gazePitch,
        eyeLid: 1.0,
        scaleY: 1.0,
        scaleX: 1.0,
      };
    }

    case 'tool_execution': {
      // Energetic typing bob at 2.8 Hz and rapid paw typing at 4.2 Hz
      const wBob = 2 * Math.PI * 2.8;
      const bobSin = Math.sin(wBob * t);
      const sy = 1.0 - Math.abs(bobSin) * 0.02;
      const sx = computeAreaPreservingScaleX(sy);

      const wPaw = 2 * Math.PI * 4.2;
      const pawSin = Math.sin(wPaw * t);
      const pawCos = Math.cos(wPaw * t);

      return {
        bodyX: 0,
        bodyY: bobSin * 1.4,
        scaleY: sy,
        scaleX: sx,
        tilt: -2.0,
        gazeYaw: 0,
        gazePitch: 0.4,
        eyeLid: 1.0,
        pawY: pawSin * 3.0,
        pawAngle: pawCos * 6.0,
      };
    }

    case 'success': {
      // Celebratory high-bounce with kinematic apex (+26px lift)
      // Phase 0 (0 <= t < 0.12s): Anticipation crouch
      if (t < 0.12) {
        const u = t / 0.12;
        const sy = 1.0 - u * 0.16;
        return {
          bodyY: u * 4.0,
          scaleY: sy,
          scaleX: computeAreaPreservingScaleX(sy),
          tilt: 0,
          pawY: u * 2.0,
          pawAngle: 0,
          eyeLid: 1.0,
        };
      }

      // Phase 1 (0.12 <= t < 0.52s): Explosive launch and apex (+26px)
      if (t < 0.52) {
        const u = (t - 0.12) / 0.4;
        // Parabolic arc reaching apex at u ~ 0.5
        const jumpH = 4 * u * (1 - u); // 0 -> 1 -> 0
        const apexY = -26.0 * jumpH;
        const stretchY = 1.0 + jumpH * 0.16;
        return {
          bodyY: apexY,
          scaleY: stretchY,
          scaleX: computeAreaPreservingScaleX(stretchY),
          tilt: Math.sin(u * Math.PI * 2) * 3.0,
          pawY: -8.0 * jumpH,
          pawAngle: 20.0 * jumpH,
          eyeLid: 1.0,
        };
      }

      // Phase 2 (t >= 0.52s): Landing squash settling to cheerful rest
      const settleT = t - 0.52;
      const wave = Math.sin(2 * Math.PI * 2.0 * settleT);
      const decay = Math.exp(-settleT * 3.5);
      const sy = 1.0 - decay * wave * 0.12;

      return {
        bodyY: 0,
        scaleY: sy,
        scaleX: computeAreaPreservingScaleX(sy),
        tilt: wave * decay * 2.5,
        pawY: 0,
        pawAngle: 0,
        eyeLid: 1.0,
      };
    }

    case 'error': {
      // Stage 1 (0 <= t < 0.35s): Rapid 12 Hz lateral jitter
      if (t < 0.35) {
        const wJitter = 2 * Math.PI * 12.0;
        const decay = Math.exp(-t * 3.0);
        const shakeX = Math.sin(wJitter * t) * 3.0 * decay;

        return {
          bodyX: shakeX,
          bodyY: 0,
          scaleY: 1.0,
          scaleX: 1.0,
          tilt: Math.sin(wJitter * t * 0.5) * 2.0 * decay,
          gazeYaw: 0,
          gazePitch: -0.1,
          eyeLid: 1.0,
          pawY: 0,
          pawAngle: 0,
        };
      }

      // Stage 2 (t >= 0.35s): Overdamped droop settle (-5px)
      return {
        bodyX: 0,
        bodyY: 5.0,
        scaleY: 0.91,
        scaleX: computeAreaPreservingScaleX(0.91),
        tilt: -3.0,
        gazeYaw: 0,
        gazePitch: -0.1,
        eyeLid: 1.0,
        pawY: 2.0,
        pawAngle: 0,
      };
    }

    case 'sleep': {
      // Damped slow gentle breathing at 0.20 Hz with eyes shut
      const wBreath = 2 * Math.PI * 0.2;
      const breathSin = Math.sin(wBreath * t);
      const sy = 0.96 + breathSin * 0.035;
      const sx = computeAreaPreservingScaleX(sy);

      return {
        bodyX: 0,
        bodyY: 2.0 - breathSin * 1.0,
        scaleY: sy,
        scaleX: sx,
        tilt: 4.0,
        gazeYaw: 0,
        gazePitch: 0,
        eyeLid: 0.0,
        pawY: 1.0,
        pawAngle: 0,
      };
    }

    default:
      return STATE_BASE_POSES.idle;
  }
}

/**
 * Checks whether user prefers reduced motion.
 */
export function isPrefersReducedMotion(): boolean {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Directly applies computed 11-DOF pose transforms to the contracted SVG hierarchy:
 * - #friday-shadow
 * - #friday-pos
 * - #friday-rot
 * - #friday-squash
 * - #friday-face
 * - #friday-paw-left
 */
export function applyPoseToSvg(svgRoot: SVGSVGElement | Element, pose: FridayPose, prefix = 'friday-'): void {
  if (!svgRoot) return;

  const bodyX = Number.isFinite(pose.bodyX) ? (pose.bodyX as number) : 0;
  const bodyY = Number.isFinite(pose.bodyY) ? (pose.bodyY as number) : 0;
  const scaleX = Number.isFinite(pose.scaleX) ? (pose.scaleX as number) : 1.0;
  const scaleY = Number.isFinite(pose.scaleY) ? (pose.scaleY as number) : 1.0;
  const tilt = Number.isFinite(pose.tilt) ? (pose.tilt as number) : 0;
  const gazeYaw = Number.isFinite(pose.gazeYaw) ? (pose.gazeYaw as number) : 0;
  const gazePitch = Number.isFinite(pose.gazePitch) ? (pose.gazePitch as number) : 0;
  const shadowScale = Number.isFinite(pose.shadowScale) ? (pose.shadowScale as number) : 1.0;
  const pawX = Number.isFinite(pose.pawX) ? (pose.pawX as number) : 0;
  const pawY = Number.isFinite(pose.pawY) ? (pose.pawY as number) : 0;
  const pawAngle = Number.isFinite(pose.pawAngle) ? (pose.pawAngle as number) : 0;

  // 1. #friday-pos: Translation group
  const posEl = svgRoot.querySelector<SVGElement>(`#${prefix}pos`);
  if (posEl) {
    posEl.setAttribute('transform', `translate(${bodyX.toFixed(2)}, ${bodyY.toFixed(2)})`);
  }

  // 2. #friday-rot: Rotation group around body pivot (60, 110)
  const rotEl = svgRoot.querySelector<SVGElement>(`#${prefix}rot`);
  if (rotEl) {
    rotEl.setAttribute('transform', `rotate(${tilt.toFixed(2)} ${FRIDAY_PIVOT_BODY.x} ${FRIDAY_PIVOT_BODY.y})`);
  }

  // 3. #friday-squash: Area-preserving scale around ground squash pivot (64, 116)
  const squashEl = svgRoot.querySelector<SVGElement>(`#${prefix}squash`);
  if (squashEl) {
    squashEl.setAttribute(
      'transform',
      `translate(${FRIDAY_PIVOT_SQUASH.x}, ${FRIDAY_PIVOT_SQUASH.y}) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)}) translate(-${FRIDAY_PIVOT_SQUASH.x}, -${FRIDAY_PIVOT_SQUASH.y})`,
    );
  }

  // 4. #friday-face: Eye and mouth gaze tracking
  const faceEl = svgRoot.querySelector<SVGElement>(`#${prefix}face`);
  if (faceEl) {
    const gazeX = (gazeYaw * 4).toFixed(2);
    const gazeY = (gazePitch * 4).toFixed(2);
    faceEl.setAttribute('transform', `translate(${gazeX}, ${gazeY})`);
  }

  // 5. #friday-paw-left: Left chubby paw motion
  const pawEl = svgRoot.querySelector<SVGElement>(`#${prefix}paw-left`);
  if (pawEl) {
    pawEl.setAttribute(
      'transform',
      `translate(${pawX.toFixed(2)}, ${pawY.toFixed(2)}) rotate(${pawAngle.toFixed(2)} 19 98)`,
    );
  }

  // 6. #friday-shadow: Contact shadow radius and opacity
  const shadowEl = svgRoot.querySelector<SVGElement>(`#${prefix}shadow`);
  if (shadowEl) {
    shadowEl.setAttribute('rx', (42 * shadowScale).toFixed(1));
    shadowEl.setAttribute('ry', (4.5 * shadowScale).toFixed(1));
    shadowEl.setAttribute('opacity', (0.25 * shadowScale).toFixed(2));
  }
}

/**
 * MascotMotionController manages:
 * - State machine & state-specific kinetics
 * - C¹ velocity continuity across state changes
 * - Reduced motion fallback
 * - Physics rig solver stepping
 * - Optional requestAnimationFrame drive loop
 */
export class MascotMotionController {
  readonly solver: MascotRigSolver;
  #state: MascotState;
  #time = 0;
  #stateTime = 0;
  #reducedMotion: boolean;
  #subscribers = new Set<(pose: FridayPose) => void>();
  #rafId: number | null = null;
  #lastTime: number | null = null;

  constructor(options: MascotMotionOptions = {}) {
    this.#state = toCanonicalState(options.initialState);
    this.#reducedMotion = options.reducedMotion ?? isPrefersReducedMotion();

    const basePose = STATE_BASE_POSES[this.#state];
    const initialConfig = STATE_SPRING_CONFIGS[this.#state];
    this.solver = new MascotRigSolver(basePose, initialConfig);

    if (this.#reducedMotion) {
      this.solver.jump(basePose);
    }

    if (options.autoStart) {
      this.start();
    }
  }

  getState(): MascotState {
    return this.#state;
  }

  get reducedMotion(): boolean {
    return this.#reducedMotion;
  }

  setReducedMotion(enabled: boolean): void {
    this.#reducedMotion = enabled;
    if (this.#reducedMotion) {
      this.solver.jump(STATE_BASE_POSES[this.#state]);
    }
  }

  /**
   * Switches to a new lifecycle state.
   *
   * Guarantees C¹ velocity continuity:
   * Current coordinates and velocities in the solver are preserved,
   * avoiding visual popping, while spring stiffness/damping and target
   * kinematics adapt seamlessly to the new state.
   */
  setState(nextState: MascotState, immediate = false): void {
    const canonical = toCanonicalState(nextState);
    const stateChanged = this.#state !== canonical;

    this.#state = canonical;
    this.#stateTime = 0;

    // Update spring dynamics preset for new state (preserving current position and velocity)
    const nextConfig = STATE_SPRING_CONFIGS[canonical];
    this.solver.setSpringConfig(nextConfig);

    if (this.#reducedMotion || immediate) {
      // Immediate placement without kinetic oscillation
      this.solver.jump(STATE_BASE_POSES[canonical]);
    } else if (stateChanged) {
      // Guide toward new base pose smoothly with velocity continuity
      this.solver.setTargets(STATE_BASE_POSES[canonical]);
    }
  }

  /**
   * Applies an external physical impulse (e.g. typing recoil, click hop).
   */
  triggerImpulse(forceX: number, forceY: number): void {
    if (this.#reducedMotion) return;
    this.solver.applyImpulse('bodyX', forceX);
    this.solver.applyImpulse('bodyY', forceY);
    this.solver.applyImpulse('scaleY', -forceY * 0.005);
    this.solver.applyImpulse('tilt', forceX * 0.15);
  }

  /**
   * Advances motion and physics by dt seconds.
   */
  tick(dt: number): FridayPose {
    if (!Number.isFinite(dt) || dt <= 0) {
      return this.solver.getPose();
    }

    this.#time += dt;
    this.#stateTime += dt;

    if (this.#reducedMotion) {
      this.solver.jump(STATE_BASE_POSES[this.#state]);
      const pose = this.solver.getPose();
      this.#notify(pose);
      return pose;
    }

    // Dynamic error phase transition (Stage 1 jitter -> Stage 2 overdamped droop)
    if (this.#state === 'error' && this.#stateTime >= 0.35) {
      this.solver.setSpringConfig(ERROR_DROOP_CONFIG);
    }

    // Compute harmonic offsets for active state
    const harmonicPose = computeStateHarmonics(this.#state, this.#stateTime, this.#time);
    this.solver.setTargets(harmonicPose);

    // Step physics solver with 1/240 s sub-stepping
    this.solver.step(dt);

    const pose = this.solver.getPose();
    this.#notify(pose);
    return pose;
  }

  getPose(): FridayPose {
    return this.solver.getPose();
  }

  subscribe(listener: (pose: FridayPose) => void): () => void {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  /**
   * Binds this motion controller directly to an SVG element,
   * driving its transforms on every frame.
   */
  attach(svg: SVGSVGElement | Element, prefix = 'friday-'): () => void {
    const unsub = this.subscribe((pose) => {
      applyPoseToSvg(svg, pose, prefix);
    });

    applyPoseToSvg(svg, this.getPose(), prefix);
    this.start();

    return () => {
      unsub();
      this.stop();
    };
  }

  start(): void {
    if (this.#rafId !== null) return;
    this.#lastTime = null;

    const loop = (now: number): void => {
      if (this.#lastTime === null) this.#lastTime = now;
      const dt = Math.min((now - this.#lastTime) / 1000, 0.1);
      this.#lastTime = now;

      this.tick(dt);
      this.#rafId = requestAnimationFrame(loop);
    };

    this.#rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
      this.#lastTime = null;
    }
  }

  destroy(): void {
    this.stop();
    this.#subscribers.clear();
  }

  #notify(pose: FridayPose): void {
    for (const listener of this.#subscribers) {
      try {
        listener(pose);
      } catch {
        // Subscriber errors should not disrupt the motion loop
      }
    }
  }
}
