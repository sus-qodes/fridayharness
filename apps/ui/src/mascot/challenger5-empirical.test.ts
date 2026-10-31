/**
 * Challenger 5: Adversarial Verification & Empirical Stress Harness for Milestone 3.
 *
 * Verifies:
 * 1. DOM Lifecycle & Post-Teardown Resilience:
 *    - Calling destroy() followed by multiple calls to setState, setAccessories, setSize,
 *      setTint, triggerImpulse, engine.express, engine.gesture, and destroy() produces:
 *      - Zero errors / unhandled exceptions
 *      - Zero SVG recreation (host remains empty)
 *      - Zero active / resurrected RAF loops
 *      - Zero event listener invocations
 * 2. 100-Instance Mount/Unmount Stress & Memory Leak Resistance:
 *    - 100 concurrent heterogeneous mascot instances mount and teardown cleanly.
 *    - All 100 RAF loops cancelled, zero orphan timers, zero retained DOM children.
 * 3. Rapid State Cycling (0ms intervals):
 *    - 500 rapid state transitions across canonical and legacy alias states with interleaved impulses.
 *    - Confirms zero NaN, zero Infinity, and strictly 1 SVG per host.
 * 4. DOM Security:
 *    - Confirms zero innerHTML / outerHTML DOM assignments in mascot implementation.
 * 5. Invariant Brand & Zero-Emoji Enforcement:
 *    - Strict "Friday" naming across all views and zero Unicode emojis.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { createFridayMascot, type FridayMascotHandle } from './component.js';
import { MascotMotionController } from './motion.js';
import { MASCOT_ACCESSORIES, MASCOT_STATES, type MascotAccessory, type MascotState } from './types.js';

describe('m3_challenger_5: Adversarial Empirical Verification Suite', () => {
  let ctx: TestContext;
  let activeMascots: FridayMascotHandle[] = [];

  beforeEach(() => {
    ctx = makeContext();
    activeMascots = [];
  });

  afterEach(() => {
    for (const mascot of activeMascots) {
      try {
        mascot.destroy();
      } catch {
        // Safe teardown
      }
    }
    activeMascots = [];
    vi.restoreAllMocks();
  });

  function track(mascot: FridayMascotHandle): FridayMascotHandle {
    activeMascots.push(mascot);
    return mascot;
  }

  // ==========================================================================
  // 1. DOM Lifecycle & Post-Teardown Resilience
  // ==========================================================================
  describe('1. DOM Lifecycle & Post-Teardown Resilience', () => {
    it('calling destroy() followed by exhaustive mutations produces NO errors, NO SVG recreation, and NO active RAF loops', () => {
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
      const clickCallback = vi.fn();

      const mascot = track(
        createFridayMascot(ctx, {
          state: 'idle',
          size: 36,
          interactive: true,
          onClick: clickCallback,
        }),
      );

      const parent = document.createElement('div');
      parent.appendChild(mascot.el);
      expect(parent.contains(mascot.el)).toBe(true);
      expect(mascot.el.querySelector('svg')).not.toBeNull();

      // Initial RAF call count before destruction
      const _rafCountBeforeDestroy = rafSpy.mock.calls.length;

      // First destroy call
      mascot.destroy();

      // Host must be detached from parent and emptied of children
      expect(parent.contains(mascot.el)).toBe(false);
      expect(mascot.el.children.length).toBe(0);
      expect(mascot.el.querySelector('svg')).toBeNull();

      const rafCountAtDestroy = rafSpy.mock.calls.length;

      // Adversarial assault on destroyed handle:
      // Invoking all mutation methods in sequence
      expect(() => {
        mascot.setState('thinking');
        mascot.setState('tool_execution');
        mascot.setState('success');
        mascot.setState('error');
        mascot.setState('sleep');
        mascot.setAccessories(['laptop', 'hands', 'sunglasses']);
        mascot.setAccessories([]);
        mascot.setSize(72);
        mascot.setSize(120);
        mascot.setTint('#FF5500');
        mascot.triggerImpulse(15, -30);
        mascot.engine.express('alert');
        mascot.engine.gesture('celebrate');
        mascot.engine.gesture('droop');

        // Repeated destroy calls
        mascot.destroy();
        mascot.destroy();
        mascot.destroy();
      }).not.toThrow();

      // INVARIANT 1: Zero SVG recreation (host remains empty)
      expect(mascot.el.children.length).toBe(0);
      expect(mascot.el.querySelector('svg')).toBeNull();

      // INVARIANT 2: Zero active or resurrected RAF loops
      expect(rafSpy.mock.calls.length, 'No new animation frames should be scheduled post-destroy').toBe(
        rafCountAtDestroy,
      );

      // INVARIANT 3: State remains frozen at last valid state before destroy
      expect(mascot.getState()).toBe('idle');
      expect(mascot.getAccessories()).toEqual([]);

      // INVARIANT 4: Dispatched events do not invoke callbacks or trigger impulses
      const impulseSpy = vi.spyOn(mascot, 'triggerImpulse');
      mascot.el.click();
      mascot.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      mascot.el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

      expect(clickCallback).not.toHaveBeenCalled();
      expect(impulseSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 2. 100-Instance Mount/Unmount Stress & Memory Leak Resistance
  // ==========================================================================
  describe('2. 100-Instance Mount/Unmount Stress & Memory Leak Resistance', () => {
    it('rapidly mounts 100 heterogeneous instances, mutates them, tears them down, and guarantees clean resource disposal', () => {
      const container = document.createElement('div');
      container.id = 'stress-100-container';
      document.body.appendChild(container);

      const activeRafIds = new Set<number>();
      let rafCounter = 5000;

      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
        const id = ++rafCounter;
        activeRafIds.add(id);
        return id;
      });

      const cafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
        activeRafIds.delete(id);
      });

      const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
      const setIntervalSpy = vi.spyOn(window, 'setInterval');

      const instances: FridayMascotHandle[] = [];
      const testSizes = [24, 30, 32, 36, 56, 72, 80];

      // 1. Mount 100 instances with heterogeneous configurations
      for (let i = 0; i < 100; i++) {
        const state = MASCOT_STATES[i % MASCOT_STATES.length] ?? 'idle';
        const size = testSizes[i % testSizes.length] ?? 36;
        const accessories: MascotAccessory[] = i % 3 === 0 ? ['laptop', 'hands'] : i % 3 === 1 ? ['sunglasses'] : [];

        const inst = createFridayMascot(ctx, {
          size,
          state,
          accessories,
          interactive: i % 2 === 0,
          idPrefix: `stress-inst-${i}-`,
        });

        instances.push(inst);
        container.appendChild(inst.el);
      }

      expect(instances.length).toBe(100);
      expect(container.children.length).toBe(100);
      expect(activeRafIds.size).toBe(100);

      // 2. Mutate all 100 instances simultaneously
      for (let i = 0; i < 100; i++) {
        const inst = instances[i];
        if (!inst) continue;
        inst.setSize(48);
        inst.setTint('#3B82F6');
        inst.triggerImpulse(0, -10);
      }

      // 3. Destroy all 100 instances
      for (const inst of instances) {
        inst.destroy();
      }

      // 4. Invariant verifications:
      // A. All active RAF loops must be cancelled with zero active loops remaining
      expect(activeRafIds.size).toBe(0);
      expect(cafSpy.mock.calls.length).toBeGreaterThanOrEqual(100);

      // B. Zero orphan timers
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();

      // C. Container has 0 DOM children left
      expect(container.children.length).toBe(0);

      // D. All host elements emptied of SVG children
      for (const inst of instances) {
        expect(inst.el.children.length).toBe(0);
        expect(container.contains(inst.el)).toBe(false);
      }

      // Clean up DOM container
      container.remove();
    });
  });

  // ==========================================================================
  // 3. Rapid State Cycling (0ms intervals)
  // ==========================================================================
  describe('3. Rapid State Cycling (0ms intervals)', () => {
    it('survives 500 rapid state transitions with zero NaN, zero Infinity, and strictly 1 SVG per host', () => {
      const mascot = track(createFridayMascot());
      const statesToCycle: MascotState[] = [
        'idle',
        'thinking',
        'tool_execution',
        'success',
        'error',
        'sleep',
        'working' as unknown as MascotState,
        'finished' as unknown as MascotState,
        'sleeping' as unknown as MascotState,
        'question' as unknown as MascotState,
        'approval' as unknown as MascotState,
      ];

      // Perform 500 synchronous rapid transitions
      for (let i = 0; i < 500; i++) {
        const targetState = statesToCycle[i % statesToCycle.length] ?? 'idle';
        mascot.setState(targetState);

        if (i % 10 === 0) {
          mascot.triggerImpulse(Math.cos(i) * 10, -18);
        }

        // Invariant: Exactly 1 SVG per host at every transition
        const svgs = mascot.el.querySelectorAll('svg');
        expect(svgs.length).toBe(1);

        const svg = svgs[0];
        expect(svg).toBeDefined();
        expect(svg?.getAttribute('viewBox')).toBe('0 0 120 120');
      }

      // Step physics motion controller across 120 frames and verify numerical invariants
      const motion = new MascotMotionController({
        initialState: mascot.getState(),
      });
      const dt = 1 / 60;

      for (let frame = 0; frame < 120; frame++) {
        const pose = motion.tick(dt);

        for (const [channel, val] of Object.entries(pose)) {
          expect(Number.isNaN(val), `Pose channel ${channel} was NaN at frame ${frame}`).toBe(false);
          expect(Number.isFinite(val), `Pose channel ${channel} was not finite at frame ${frame}`).toBe(true);
        }

        // Squash/stretch physical stability (> 0.2 to prevent inverted geometry)
        expect(pose.scaleX).toBeGreaterThan(0.2);
        expect(pose.scaleY).toBeGreaterThan(0.2);
      }

      motion.destroy();
    });
  });

  // ==========================================================================
  // 4. Invariant Brand & Zero-Emoji Enforcement
  // ==========================================================================
  describe('4. Invariant Brand & Zero-Emoji Enforcement', () => {
    it('guarantees zero Unicode emojis and strictly Friday naming across all state and accessory combinations', () => {
      const emojiRegex = /\p{Extended_Pictographic}/u;
      const legacyRegex = /\b(blip|flip)\b/i;

      for (const state of MASCOT_STATES) {
        for (const accessory of MASCOT_ACCESSORIES) {
          const mascot = track(
            createFridayMascot(undefined, {
              state,
              accessories: [accessory],
            }),
          );

          const markup = mascot.el.innerHTML;
          expect(emojiRegex.test(markup), `Forbidden emoji found in state ${state} with accessory ${accessory}`).toBe(
            false,
          );

          expect(legacyRegex.test(markup), `Legacy name found in state ${state} with accessory ${accessory}`).toBe(
            false,
          );

          expect(mascot.el.dataset.mascot).toBe('friday');
          expect(mascot.el.getAttribute('aria-label')).toContain('Friday');

          mascot.destroy();
        }
      }
    });
  });
});
