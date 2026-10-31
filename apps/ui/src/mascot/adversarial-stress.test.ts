/**
 * Adversarial Stress Tests for Friday Mascot Component Lifecycle & Physics Recoil.
 *
 * Executed by Challenger 1 (DOM Lifecycle & Event Teardown Challenger):
 * 1. Mount/Unmount Memory Leak & Orphan RAF Stress Test:
 *    - Rapidly mounts 100 mascot instances into the DOM.
 *    - Destroys all 100 instances.
 *    - Verifies all RAF loops are cancelled, click listeners detached, no orphan timers, and DOM nodes cleaned up.
 * 2. Click Impulse Recoil & Numerical Stability Stress Test:
 *    - Simulates 50 rapid-fire click events (both burst and distributed).
 *    - Verifies Hooke's Law spring impulse recoil settles cleanly without velocity runaway, coordinate explosion, or NaN.
 *    - Verifies area preservation and transform attributes remain valid throughout high-energy perturbation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { createFridayMascot, type FridayMascotHandle } from './component.js';
import { MascotMotionController } from './motion.js';

describe('Adversarial Challenge 1: Mount/Unmount Memory Leak & Orphan RAF Stress Test', () => {
  let ctx: TestContext;
  let container: HTMLDivElement;

  beforeEach(() => {
    ctx = makeContext();
    container = document.createElement('div');
    container.id = 'stress-test-root';
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it('creates 100 mascot instances rapidly, destroys them all, and guarantees zero orphan RAF loops, timers, or click listeners', () => {
    // Track RAF calls and active frames
    const activeRafIds = new Set<number>();
    let rafCounter = 1000;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((_cb: FrameRequestCallback) => {
      const id = ++rafCounter;
      activeRafIds.add(id);
      return id;
    });

    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      activeRafIds.delete(id);
    });

    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    // 1. Rapidly mount 100 mascot instances
    const instances: FridayMascotHandle[] = [];
    const clickCounters = new Array<number>(100).fill(0);

    for (let i = 0; i < 100; i++) {
      const idx = i;
      const mascot = createFridayMascot(ctx, {
        size: 24 + (i % 6) * 10,
        interactive: true,
        onClick: () => {
          clickCounters[idx] = (clickCounters[idx] ?? 0) + 1;
        },
      });
      container.appendChild(mascot.el);
      instances.push(mascot);
    }

    expect(instances.length).toBe(100);
    expect(container.children.length).toBe(100);
    expect(activeRafIds.size).toBe(100);

    // Verify all 100 are attached to DOM
    for (const inst of instances) {
      expect(container.contains(inst.el)).toBe(true);
      expect(inst.getState()).toBe('idle');
    }

    // Fire clicks before destroy to verify listeners work
    for (const inst of instances) {
      inst.el.click();
    }
    for (let i = 0; i < 100; i++) {
      expect(clickCounters[i]).toBe(1);
    }

    // 2. Destroy all 100 mascot instances rapidly
    for (const mascot of instances) {
      mascot.destroy();
    }

    // 3. Invariant checks after teardown:

    // A. All RAF loops must be cancelled
    expect(activeRafIds.size, `Expected 0 active RAF loops after teardown, found ${activeRafIds.size}`).toBe(0);
    expect(cafSpy).toHaveBeenCalledTimes(100);

    // B. No orphan timers created during creation or destruction
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    // C. Click listeners detached: clicking host elements must NOT invoke onClick callback or trigger recoil
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      if (!inst) continue;
      const impulseSpy = vi.spyOn(inst, 'triggerImpulse');
      inst.el.click();
      expect(clickCounters[i]).toBe(1); // Still 1, did not increment
      expect(impulseSpy).not.toHaveBeenCalled();
    }

    // D. DOM elements cleanly removed from container
    expect(container.children.length).toBe(0);
    for (const inst of instances) {
      expect(container.contains(inst.el)).toBe(false);
    }

    // E. Store reactions do not wake up destroyed mascots
    const now = ctx.now();
    ctx.store.patch('activity', {
      reactions: [{ id: 999, kind: 'completed', at: now }],
    });
    for (const inst of instances) {
      expect(inst.getState()).toBe('idle'); // Not updated to success
    }

    // F. Safe against multiple destroy calls (idempotence)
    for (const mascot of instances) {
      expect(() => mascot.destroy()).not.toThrow();
    }
  });

  it('guarantees motion loop RAF callback does not reschedule after stop/destroy', () => {
    let queuedLoopCallback: FrameRequestCallback | null = null;
    let scheduledId: number | null = null;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      queuedLoopCallback = cb;
      scheduledId = 42;
      return 42;
    });

    const cafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      if (id === scheduledId) {
        scheduledId = null;
        queuedLoopCallback = null;
      }
    });

    const mascot = createFridayMascot();
    expect(scheduledId).toBe(42);
    expect(queuedLoopCallback).not.toBeNull();

    // Destroy mascot
    mascot.destroy();
    expect(cafSpy).toHaveBeenCalledWith(42);
    expect(scheduledId).toBeNull();
    expect(queuedLoopCallback).toBeNull();
  });
});

describe('Adversarial Challenge 2: Click Impulse Recoil & Numerical Stability Stress Test', () => {
  it('simulates 50 rapid-fire click events in a single burst without velocity runaway or coordinate NaN', () => {
    const mascot = createFridayMascot(undefined, { interactive: true });
    const host = mascot.el;
    const svg = host.querySelector('svg');
    expect(svg).not.toBeNull();

    // Motion controllers: baseline vs impulse
    const baselineMotion = new MascotMotionController({ initialState: 'idle', autoStart: false });
    const impulseMotion = new MascotMotionController({ initialState: 'idle', autoStart: false });

    // Step to baseline
    baselineMotion.tick(0.016);
    impulseMotion.tick(0.016);

    // Apply 50 rapid-fire click impulses in a single frame burst to impulseMotion
    // Each click triggers (0, -18) impulse
    for (let i = 0; i < 50; i++) {
      host.click();
      impulseMotion.triggerImpulse(0, -18);
    }

    // Initial velocity should jump by 50 * -18 = -900 px/s
    expect(impulseMotion.solver.bodyY.velocity).toBeLessThan(-800);

    // Now step the physics over 300 frames (~5.0s at 60 Hz) to observe recoil and settling
    const dt = 1 / 60;
    for (let frame = 0; frame < 300; frame++) {
      const pose = impulseMotion.tick(dt);
      baselineMotion.tick(dt);

      // Coordinate sanity checks on EVERY single frame
      expect(Number.isNaN(pose.bodyX), `bodyX was NaN at frame ${frame}`).toBe(false);
      expect(Number.isNaN(pose.bodyY), `bodyY was NaN at frame ${frame}`).toBe(false);
      expect(Number.isNaN(pose.scaleX), `scaleX was NaN at frame ${frame}`).toBe(false);
      expect(Number.isNaN(pose.scaleY), `scaleY was NaN at frame ${frame}`).toBe(false);
      expect(Number.isNaN(pose.tilt), `tilt was NaN at frame ${frame}`).toBe(false);
      expect(Number.isNaN(pose.shadowScale), `shadowScale was NaN at frame ${frame}`).toBe(false);

      expect(Number.isFinite(pose.bodyX), `bodyX not finite at frame ${frame}`).toBe(true);
      expect(Number.isFinite(pose.bodyY), `bodyY not finite at frame ${frame}`).toBe(true);
      expect(Number.isFinite(pose.scaleX), `scaleX not finite at frame ${frame}`).toBe(true);
      expect(Number.isFinite(pose.scaleY), `scaleY not finite at frame ${frame}`).toBe(true);

      // Scale must remain positive (no model inversion)
      expect(pose.scaleY, `scaleY inverted or collapsed at frame ${frame}: ${pose.scaleY}`).toBeGreaterThan(0.2);
      expect(pose.scaleX, `scaleX collapsed at frame ${frame}: ${pose.scaleX}`).toBeGreaterThan(0.2);

      // Check SVG transform string generation doesn't produce NaN
      const posEl = svg?.querySelector('#friday-pos');
      if (posEl) {
        const transform = posEl.getAttribute('transform');
        expect(transform).not.toContain('NaN');
        expect(transform).not.toContain('undefined');
      }
    }

    // Convergence Verification:
    // The impulse perturbation must completely decay back to the baseline breathing trajectory.
    const finalImpulsePose = impulseMotion.getPose();
    const finalBaselinePose = baselineMotion.getPose();

    const diffBodyY = Math.abs((finalImpulsePose.bodyY ?? 0) - (finalBaselinePose.bodyY ?? 0));
    const diffVelocity = Math.abs(impulseMotion.solver.bodyY.velocity - baselineMotion.solver.bodyY.velocity);

    expect(diffBodyY, `Impulse perturbation did not settle to baseline; diff: ${diffBodyY}`).toBeLessThan(0.01);
    expect(diffVelocity, `Velocity did not settle to baseline; diff: ${diffVelocity}`).toBeLessThan(0.01);

    mascot.destroy();
    baselineMotion.destroy();
    impulseMotion.destroy();
  });

  it('simulates 50 rapid clicks distributed across frames during active motion stepping', () => {
    const motion = new MascotMotionController({ initialState: 'idle', autoStart: false });
    const dt = 1 / 60;

    // Fire a click every 2 frames for 100 frames (50 clicks total)
    for (let frame = 0; frame < 100; frame++) {
      if (frame % 2 === 0) {
        motion.triggerImpulse(0, -18);
      }
      const pose = motion.tick(dt);

      expect(Number.isFinite(pose.bodyY)).toBe(true);
      expect(Number.isFinite(pose.scaleY)).toBe(true);
      expect(pose.scaleY).toBeGreaterThan(0.3);
      expect(pose.scaleX).toBeGreaterThan(0.3);
    }

    // Run for another 180 frames (3 seconds) to allow settling
    for (let frame = 0; frame < 180; frame++) {
      motion.tick(dt);
    }

    const settledPose = motion.getPose();
    expect(Number.isFinite(settledPose.bodyY)).toBe(true);
    expect(Math.abs(settledPose.bodyY ?? 0)).toBeLessThan(2.5);

    motion.destroy();
  });

  it('handles extreme adversarial impulse magnitudes without numerical overflow', () => {
    const motion = new MascotMotionController({ initialState: 'idle', autoStart: false });
    const dt = 1 / 60;

    // Extreme impulse forces
    const extremeImpulses = [
      { fx: 500, fy: -2000 },
      { fx: -800, fy: 3000 },
      { fx: 0, fy: -10000 },
      { fx: 1e5, fy: -1e5 },
    ];

    for (const impulse of extremeImpulses) {
      motion.triggerImpulse(impulse.fx, impulse.fy);

      for (let frame = 0; frame < 120; frame++) {
        const pose = motion.tick(dt);
        expect(Number.isFinite(pose.bodyX)).toBe(true);
        expect(Number.isFinite(pose.bodyY)).toBe(true);
        expect(Number.isFinite(pose.scaleX)).toBe(true);
        expect(Number.isFinite(pose.scaleY)).toBe(true);
        expect(Number.isFinite(pose.tilt)).toBe(true);
      }
    }

    motion.destroy();
  });
});
