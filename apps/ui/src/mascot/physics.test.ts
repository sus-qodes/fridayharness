import { describe, expect, it } from 'vitest';
import {
  applyPoseToSvg,
  computeStateHarmonics,
  isPrefersReducedMotion,
  MascotMotionController,
  STATE_BASE_POSES,
} from './motion.js';
import {
  AREA_PRESERVE_FACTOR,
  BODY_PIVOT,
  computeAreaPreservingScaleX,
  computeSquashStretch,
  ERROR_DROOP_CONFIG,
  HookeSpring,
  MAX_DT,
  MascotRigSolver,
  REST_DELTA,
  REST_SPEED,
  SQUASH_PIVOT,
  STATE_SPRING_CONFIGS,
  SUBSTEP,
} from './physics.js';
import { renderFridaySvg } from './svg.js';
import { type FridayPose, MASCOT_STATES } from './types.js';

describe("Feature 7: Hooke's Law Spring Physics Solver", () => {
  it('initializes with default value and target at equilibrium', () => {
    const spring = new HookeSpring(10);
    expect(spring.current).toBe(10);
    expect(spring.target).toBe(10);
    expect(spring.velocity).toBe(0);
    expect(spring.moving).toBe(false);
    expect(spring.settled).toBe(true);
  });

  it("updates target and moves toward equilibrium according to Hooke's Law: F = -k*(x - target) - c*v", () => {
    const spring = new HookeSpring(0, { stiffness: 120, damping: 18, mass: 1.0 });
    spring.setTarget(100);

    expect(spring.moving).toBe(true);
    expect(spring.settled).toBe(false);

    // Initial step
    const stepped = spring.step(1 / 60);
    expect(stepped).toBe(true);
    // Force = -120 * (0 - 100) = +12000, velocity and position should increase
    expect(spring.velocity).toBeGreaterThan(0);
    expect(spring.current).toBeGreaterThan(0);
  });

  it('settles precisely within REST_DELTA (0.01) and REST_SPEED (0.1)', () => {
    const spring = new HookeSpring(0, STATE_SPRING_CONFIGS.idle);
    spring.setTarget(50);

    // Step for 3 seconds to ensure convergence
    for (let i = 0; i < 180; i++) {
      spring.step(1 / 60);
    }

    expect(spring.settled).toBe(true);
    expect(spring.moving).toBe(false);
    expect(spring.current).toBe(50);
    expect(spring.velocity).toBe(0);
  });

  it('underdamped spring oscillates with overshoot whereas overdamped arrives monotonically', () => {
    // Underdamped (success: k=180, c=11, zeta ~ 0.41)
    const bouncy = new HookeSpring(0, STATE_SPRING_CONFIGS.success);
    bouncy.setTarget(100);

    let maxOvershoot = 0;
    for (let i = 0; i < 120; i++) {
      bouncy.step(1 / 60);
      if (bouncy.current > maxOvershoot) maxOvershoot = bouncy.current;
    }
    expect(maxOvershoot).toBeGreaterThan(100); // Overshoots target

    // Overdamped (droop: k=80, c=22, zeta ~ 1.23)
    const overdamped = new HookeSpring(0, ERROR_DROOP_CONFIG);
    overdamped.setTarget(100);

    let overdampedMax = 0;
    for (let i = 0; i < 180; i++) {
      overdamped.step(1 / 60);
      if (overdamped.current > overdampedMax) overdampedMax = overdamped.current;
    }
    expect(overdampedMax).toBeLessThanOrEqual(100.001); // No overshoot
  });

  it('guarantees frame-rate independence across 30, 60, 120, and 144 Hz displays via 1/240 s sub-stepping', () => {
    const duration = 0.6; // 600 ms

    function runSimulation(hz: number): number {
      const spring = new HookeSpring(0, STATE_SPRING_CONFIGS.idle);
      spring.setTarget(100);
      const dt = 1 / hz;
      const steps = Math.round(duration * hz);

      for (let i = 0; i < steps; i++) {
        spring.step(dt);
      }
      return spring.current;
    }

    const pos30 = runSimulation(30);
    const pos60 = runSimulation(60);
    const pos120 = runSimulation(120);
    const pos144 = runSimulation(144);

    // Trajectories at 30, 60, 120, 144 Hz must be virtually identical thanks to fixed 1/240s substepping
    expect(Math.abs(pos30 - pos60)).toBeLessThan(0.08);
    expect(Math.abs(pos60 - pos120)).toBeLessThan(0.05);
    expect(Math.abs(pos120 - pos144)).toBeLessThan(0.05);
  });

  it('clamps large timesteps to MAX_DT (0.1) preventing numerical instability', () => {
    const spring = new HookeSpring(0, STATE_SPRING_CONFIGS.idle);
    spring.setTarget(50);

    // Pass an extreme timestep (e.g. 2.0 seconds after waking from background sleep)
    expect(() => spring.step(2.0)).not.toThrow();
    expect(Number.isFinite(spring.current)).toBe(true);
    expect(Number.isFinite(spring.velocity)).toBe(true);
  });

  it('applies physical impulse and imparts velocity inversely proportional to mass', () => {
    const s1 = new HookeSpring(0, { stiffness: 100, damping: 10, mass: 1.0 });
    const s2 = new HookeSpring(0, { stiffness: 100, damping: 10, mass: 2.0 });

    s1.applyImpulse(50);
    s2.applyImpulse(50);

    expect(s1.velocity).toBe(50);
    expect(s2.velocity).toBe(25); // Twice the mass = half the imparted velocity
  });

  it('jump() snaps value and target immediately clearing velocity and carry', () => {
    const spring = new HookeSpring(0, STATE_SPRING_CONFIGS.idle);
    spring.setTarget(100);
    spring.step(1 / 60);

    expect(spring.velocity).toBeGreaterThan(0);

    spring.jump(80);
    expect(spring.current).toBe(80);
    expect(spring.target).toBe(80);
    expect(spring.velocity).toBe(0);
    expect(spring.settled).toBe(true);
  });

  it('handles non-finite input gracefully without NaN pollution', () => {
    const spring = new HookeSpring(Number.NaN);
    expect(spring.current).toBe(0);

    spring.setTarget(Number.POSITIVE_INFINITY);
    expect(spring.target).toBe(0);

    spring.jump(Number.NaN);
    expect(spring.current).toBe(0);
  });
});

describe('Feature 8: 11 Degree-of-Freedom Mascot Rigging Solver', () => {
  it('initializes all 11 DOF channels with standard resting values', () => {
    const rig = new MascotRigSolver();
    const pose = rig.getPose();

    expect(pose.bodyX).toBe(0);
    expect(pose.bodyY).toBe(0);
    expect(pose.scaleX).toBe(1.0);
    expect(pose.scaleY).toBe(1.0);
    expect(pose.tilt).toBe(0);
    expect(pose.gazeYaw).toBe(0);
    expect(pose.gazePitch).toBe(0);
    expect(pose.eyeLid).toBe(1.0);
    expect(pose.pawY).toBe(0);
    expect(pose.pawAngle).toBe(0);
    expect(pose.shadowScale).toBe(1.0);
    expect(rig.settled).toBe(true);
  });

  it('sets targets across multiple channels without resetting velocities', () => {
    const rig = new MascotRigSolver();
    rig.bodyY.velocity = -45;

    rig.setTargets({
      bodyY: -15,
      tilt: 6.5,
      gazeYaw: 0.4,
    });

    expect(rig.bodyY.target).toBe(-15);
    expect(rig.bodyY.velocity).toBe(-45); // Velocity preserved!
    expect(rig.tilt.target).toBe(6.5);
    expect(rig.gazeYaw.target).toBe(0.4);
  });

  it('steps all channels concurrently and reports movement and velocities', () => {
    const rig = new MascotRigSolver();
    rig.setTargets({
      bodyY: -20,
      tilt: 5,
      pawY: -4,
    });

    expect(rig.moving).toBe(true);
    const stepped = rig.step(1 / 60);
    expect(stepped).toBe(true);

    const vels = rig.getVelocities();
    expect(vels.bodyY).not.toBe(0);
    expect(vels.tilt).not.toBe(0);
    expect(vels.pawY).not.toBe(0);
  });

  it('jump() snaps all 11 DOF channels instantaneously', () => {
    const rig = new MascotRigSolver();
    const targetPose: FridayPose = {
      bodyX: 12,
      bodyY: -18,
      scaleX: 1.087,
      scaleY: 0.85,
      tilt: 5.5,
      gazeYaw: 0.5,
      gazePitch: -0.25,
      eyeLid: 0.75,
      pawY: -6,
      pawAngle: 15,
      shadowScale: 0.85,
    };

    rig.jump(targetPose);

    const pose = rig.getPose();
    expect(pose.bodyX).toBe(12);
    expect(pose.bodyY).toBe(-18);
    expect(pose.scaleX).toBe(1.087);
    expect(pose.scaleY).toBe(0.85);
    expect(pose.tilt).toBe(5.5);
    expect(pose.gazeYaw).toBe(0.5);
    expect(pose.gazePitch).toBe(-0.25);
    expect(pose.eyeLid).toBe(0.75);
    expect(pose.pawY).toBe(-6);
    expect(pose.pawAngle).toBe(15);
    expect(pose.shadowScale).toBe(0.85);
    expect(rig.settled).toBe(true);
  });

  it('automatically tracks shadow scale from body vertical elevation (bodyY)', () => {
    const rig = new MascotRigSolver();

    // Resting on ground
    rig.jump({ bodyY: 0 });
    rig.step(1 / 60);
    expect(rig.shadowScale.target).toBeCloseTo(1.0, 2);

    // High jump (bodyY = -25px)
    rig.bodyY.current = -25;
    rig.step(1 / 60);
    // Shadow shrinks as mascot ascends: 1.0 - 25/45 = ~0.444
    expect(rig.shadowScale.target).toBeLessThan(0.55);
  });

  it('applies impulse to specific channel', () => {
    const rig = new MascotRigSolver();
    rig.applyImpulse('bodyY', -120);
    expect(rig.bodyY.velocity).toBe(-120);
  });

  it('applyPoseToSvg applies 11-DOF transforms to contracted SVG groups in DOM', () => {
    const svg = renderFridaySvg({ state: 'idle' });

    const pose: FridayPose = {
      bodyX: 4.25,
      bodyY: -14.5,
      scaleX: 1.087,
      scaleY: 0.85,
      tilt: 7.2,
      gazeYaw: 0.45,
      gazePitch: -0.25,
      pawX: 1.5,
      pawY: -3.0,
      pawAngle: 12.0,
      shadowScale: 0.75,
    };

    applyPoseToSvg(svg, pose);

    // 1. Position group
    const pos = svg.querySelector('#friday-pos');
    expect(pos?.getAttribute('transform')).toBe('translate(4.25, -14.50)');

    // 2. Rotation group around body pivot (60, 110)
    const rot = svg.querySelector('#friday-rot');
    expect(rot?.getAttribute('transform')).toBe(`rotate(7.20 ${BODY_PIVOT.x} ${BODY_PIVOT.y})`);

    // 3. Squash group around ground pivot (64, 116)
    const squash = svg.querySelector('#friday-squash');
    expect(squash?.getAttribute('transform')).toContain(`scale(1.087, 0.850)`);
    expect(squash?.getAttribute('transform')).toContain(`${SQUASH_PIVOT.x}, ${SQUASH_PIVOT.y}`);

    // 4. Face gaze tracking
    const face = svg.querySelector('#friday-face');
    expect(face?.getAttribute('transform')).toBe(`translate(${(0.45 * 4).toFixed(2)}, ${(-0.25 * 4).toFixed(2)})`);

    // 5. Left paw
    const paw = svg.querySelector('#friday-paw-left');
    expect(paw?.getAttribute('transform')).toBe('translate(1.50, -3.00) rotate(12.00 19 98)');

    // 6. Shadow
    const shadow = svg.querySelector('#friday-shadow');
    expect(shadow?.getAttribute('rx')).toBe((42 * 0.75).toFixed(1));
    expect(shadow?.getAttribute('ry')).toBe((4.5 * 0.75).toFixed(1));
    expect(shadow?.getAttribute('opacity')).toBe((0.25 * 0.75).toFixed(2));
  });

  it('applyPoseToSvg safely handles null or missing elements without throwing', () => {
    const emptyDiv = document.createElement('div');
    expect(() => applyPoseToSvg(emptyDiv, { bodyY: 10 })).not.toThrow();
  });
});

describe('Feature 9: Area-Preserving Squash and Stretch', () => {
  it('implements coupled scaling formulation: sx = 1.0 + (1.0 - sy) * 0.58', () => {
    // Rest
    expect(computeAreaPreservingScaleX(1.0)).toBe(1.0);

    // Anticipation crouch / contact squash (sy = 0.80) -> sx = 1.116
    const sxSquash = computeAreaPreservingScaleX(0.8);
    expect(sxSquash).toBeCloseTo(1.116, 4);

    // Apex launch stretch (sy = 1.20) -> sx = 0.884
    const sxStretch = computeAreaPreservingScaleX(1.2);
    expect(sxStretch).toBeCloseTo(0.884, 4);

    // Slight breath (sy = 1.02) -> sx = 0.9884
    expect(computeAreaPreservingScaleX(1.02)).toBeCloseTo(0.9884, 4);
  });

  it('computeSquashStretch returns paired dimensions', () => {
    const pair = computeSquashStretch(0.84);
    expect(pair.scaleY).toBe(0.84);
    expect(pair.scaleX).toBeCloseTo(1.0 + (1.0 - 0.84) * 0.58, 4);
  });

  it('couples scaleX automatically in MascotRigSolver when scaleY changes', () => {
    const rig = new MascotRigSolver();
    rig.setTargets({ scaleY: 0.85 });

    // scaleX target should have updated to computeAreaPreservingScaleX(0.85) = 1.087
    expect(rig.scaleX.target).toBeCloseTo(1.087, 3);

    // Step solver to let scaleY and scaleX move
    for (let i = 0; i < 60; i++) {
      rig.step(1 / 60);
    }
    expect(rig.scaleY.current).toBeCloseTo(0.85, 2);
    expect(rig.scaleX.current).toBeCloseTo(1.087, 2);
  });
});

describe('Feature 10: State-Specific Spring Dynamics & Harmonics', () => {
  it('defines valid tuned spring configurations for all 6 canonical states', () => {
    for (const state of MASCOT_STATES) {
      const config = STATE_SPRING_CONFIGS[state];
      expect(config).toBeDefined();
      expect(config.stiffness).toBeGreaterThan(0);
      expect(config.damping).toBeGreaterThan(0);
      expect(config.mass ?? 1.0).toBeGreaterThan(0);
    }
  });

  it('idle: generates gentle organic breathing at 0.35 Hz', () => {
    const pose0 = computeStateHarmonics('idle', 0, 0);
    const poseHalfPeriod = computeStateHarmonics('idle', 1 / (2 * 0.35), 1 / (2 * 0.35));

    expect(pose0.scaleY).toBeCloseTo(1.0, 3);
    expect(poseHalfPeriod.scaleY).toBeCloseTo(1.0, 3);

    // Quarter period (peak of breath)
    const poseQuarter = computeStateHarmonics('idle', 1 / (4 * 0.35), 1 / (4 * 0.35));
    expect((poseQuarter.scaleY ?? 1.0) > 1.0).toBe(true);
    expect((poseQuarter.bodyY ?? 0) < 0).toBe(true); // Chest lifts slightly
  });

  it('thinking: generates floating wobble at 0.5 Hz with eye scanning at 0.8 Hz', () => {
    const pose1 = computeStateHarmonics('thinking', 0.25, 0.25);
    const pose2 = computeStateHarmonics('thinking', 0.75, 0.75);

    // Inquisitive tilt exists
    expect(pose1.tilt).toBeGreaterThan(0);
    expect(pose2.tilt).toBeGreaterThan(0);
    // Eye scan coordinates oscillate
    expect(pose1.gazeYaw).toBeDefined();
    expect(pose2.gazeYaw).toBeDefined();
  });

  it('tool_execution: generates rapid typing bob at 2.8 Hz and paw tapping at 4.2 Hz', () => {
    const pose = computeStateHarmonics('tool_execution', 0.1, 0.1);
    expect(pose.gazePitch).toBe(0.4); // Focused downward at keyboard
    expect(pose.tilt).toBe(-2.0); // Leaning in
    expect(pose.pawY).toBeDefined();
    expect(pose.pawAngle).toBeDefined();
  });

  it('success: celebratory apex jump sequence reaches apex (+26px lift = -26px bodyY)', () => {
    // Anticipation crouch (t = 0.06s)
    const crouch = computeStateHarmonics('success', 0.06, 0.06);
    expect((crouch.bodyY ?? 0) > 0).toBe(true); // crouched down
    expect((crouch.scaleY ?? 1) < 1.0).toBe(true);

    // Jump apex (t = 0.32s, middle of launch phase)
    const apex = computeStateHarmonics('success', 0.32, 0.32);
    expect(apex.bodyY).toBeCloseTo(-26.0, 1); // Apex lift of +26px
    expect((apex.scaleY ?? 1) > 1.0).toBe(true); // Stretch during flight
    expect(apex.pawY).toBeCloseTo(-8.0, 1); // Raised paws cheer
  });

  it('error: stage 1 lateral jitter (12 Hz shake) settles into stage 2 droop (+5px)', () => {
    // Stage 1 (t = 0.05s): High frequency lateral shake
    const jitter = computeStateHarmonics('error', 0.05, 0.05);
    expect(jitter.bodyX).not.toBe(0);

    // Stage 2 (t = 0.5s): Settled into droop
    const droop = computeStateHarmonics('error', 0.5, 0.5);
    expect(droop.bodyX).toBe(0);
    expect(droop.bodyY).toBe(5.0); // Droop down 5px
    expect(droop.scaleY).toBe(0.91); // Slumped squash
    expect(droop.tilt).toBe(-3.0);
  });

  it('sleep: gentle 0.20 Hz slow breathing with completely closed eyes (eyeLid = 0)', () => {
    const sleepPose = computeStateHarmonics('sleep', 1.0, 1.0);
    expect(sleepPose.eyeLid).toBe(0.0); // Eyes shut
    expect(sleepPose.bodyY).toBeGreaterThan(0); // Rest position settled down
    expect(sleepPose.scaleY).toBeDefined();
  });
});

describe('Feature 11: State Transition Kinetics & C¹ Velocity Continuity', () => {
  it('guarantees C¹ velocity continuity across state changes without position snapping', () => {
    const controller = new MascotMotionController({ initialState: 'tool_execution' });

    // Tick for a few frames while typing bob is actively moving
    for (let i = 0; i < 15; i++) {
      controller.tick(1 / 60);
    }

    const prePose = controller.getPose();
    const preVel = controller.solver.bodyY.velocity;

    // Switch state from tool_execution to thinking
    controller.setState('thinking');

    const postPose = controller.getPose();
    const postVel = controller.solver.bodyY.velocity;

    // Coordinates and velocities must be continuous across the switch!
    expect(postPose.bodyY).toBe(prePose.bodyY);
    expect(postPose.bodyX).toBe(prePose.bodyX);
    expect(postVel).toBe(preVel);

    // Next step naturally carries momentum into the new state
    controller.tick(1 / 60);
    expect(Number.isFinite(controller.getPose().bodyY)).toBe(true);
  });

  it('maintains stability under rapid state thrashing through all 6 states', () => {
    const controller = new MascotMotionController({ initialState: 'idle' });

    for (let i = 0; i < 60; i++) {
      const state = MASCOT_STATES[i % MASCOT_STATES.length] ?? 'idle';
      controller.setState(state);
      controller.tick(1 / 60);

      const pose = controller.getPose();
      for (const val of Object.values(pose)) {
        if (typeof val === 'number') {
          expect(Number.isFinite(val)).toBe(true);
          expect(Number.isNaN(val)).toBe(false);
        }
      }
    }
  });

  it('reduced motion fallback snaps immediately to base pose with zero oscillation', () => {
    const controller = new MascotMotionController({
      initialState: 'idle',
      reducedMotion: true,
    });

    expect(controller.reducedMotion).toBe(true);

    // Initial pose is exactly idle rest pose
    expect(controller.getPose().bodyY).toBe(STATE_BASE_POSES.idle.bodyY);

    // Switch to error
    controller.setState('error');

    // Snapped immediately to error rest pose
    const errorPose = controller.getPose();
    expect(errorPose.bodyY).toBe(STATE_BASE_POSES.error.bodyY);
    expect(errorPose.scaleY).toBe(STATE_BASE_POSES.error.scaleY);
    expect(controller.solver.bodyY.velocity).toBe(0);

    // Ticking under reduced motion does not wobble or oscillate
    for (let i = 0; i < 30; i++) {
      controller.tick(1 / 60);
    }
    expect(controller.getPose().bodyY).toBe(STATE_BASE_POSES.error.bodyY);
  });

  it('triggerImpulse imparts momentum when reduced motion is disabled, but ignores it when enabled', () => {
    const normal = new MascotMotionController({ reducedMotion: false });
    normal.triggerImpulse(0, -100);
    expect(normal.solver.bodyY.velocity).toBe(-100);

    const reduced = new MascotMotionController({ reducedMotion: true });
    reduced.triggerImpulse(0, -100);
    expect(reduced.solver.bodyY.velocity).toBe(0);
  });

  it('attaches to SVG element and drives transforms smoothly via subscriber updates', () => {
    const controller = new MascotMotionController({ initialState: 'idle' });
    const svg = renderFridaySvg({ state: 'idle' });

    const detach = controller.attach(svg);

    // Tick controller manually
    controller.tick(1 / 60);

    const pos = svg.querySelector('#friday-pos');
    expect(pos?.getAttribute('transform')).toContain('translate(');

    detach();
    controller.destroy();
  });

  it('verifies Hooke solver and area preservation constants', () => {
    expect(SUBSTEP).toBeCloseTo(1 / 240, 6);
    expect(MAX_DT).toBe(0.1);
    expect(REST_DELTA).toBe(0.01);
    expect(REST_SPEED).toBe(0.1);
    expect(AREA_PRESERVE_FACTOR).toBe(0.58);
    expect(typeof isPrefersReducedMotion()).toBe('boolean');
  });
});
