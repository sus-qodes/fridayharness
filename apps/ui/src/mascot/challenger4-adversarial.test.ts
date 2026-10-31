/**
 * Adversarial Challenger 4 Verification Suite:
 * - Multi-Size Scaling (24px, 30px, 32px, 36px, 56px, 72px, 80px, boundary sizes)
 * - ObservableStore Reactivity (unattached store, unrecognized strings, unmounted state emissions)
 * - Reduced-Motion Accessibility (suppression of continuous RAF oscillation, pose update retention)
 * - Zero emojis & Friday naming strictly upheld
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { createFridayMascot, type FridayMascotHandle } from './component.js';
import { MascotMotionController, STATE_BASE_POSES } from './motion.js';
import { FRIDAY_VIEWBOX, type MascotAccessory, type MascotState } from './types.js';

describe('m3_challenger_4: Adversarial Integration & Kinetic Verification', () => {
  let ctx: TestContext;
  let mascot: FridayMascotHandle | null = null;

  beforeEach(() => {
    ctx = makeContext();
  });

  afterEach(() => {
    mascot?.destroy();
    mascot = null;
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Multi-Size Scaling & Vector Integrity
  // ==========================================================================
  describe('1. Multi-Size Scaling & Vector Integrity', () => {
    const CONTRACT_SIZES = [24, 30, 32, 36, 56, 72, 80] as const;
    const BOUNDARY_SIZES = [12, 16, 120, 256, 512] as const;

    it('renders cleanly across all 7 Milestone 3 contract sizes with correct viewBox and 1:1 aspect ratio', () => {
      for (const size of CONTRACT_SIZES) {
        const m = createFridayMascot(undefined, { size });
        const host = m.el;

        // Host container geometry
        expect(host.style.width).toBe(`${size}px`);
        expect(host.style.height).toBe(`${size}px`);
        expect(host.style.overflow).toBe('visible');

        // Embedded SVG geometry
        const svg = host.querySelector('svg');
        expect(svg).not.toBeNull();
        if (svg) {
          expect(svg.getAttribute('viewBox')).toBe(FRIDAY_VIEWBOX);
          expect(svg.getAttribute('viewBox')).toBe('0 0 120 120');
          expect(svg.getAttribute('width')).toBe(`${size}`);
          expect(svg.getAttribute('height')).toBe(`${size}`);
          expect(svg.style.overflow).toBe('visible');
        }

        m.destroy();
      }
    });

    it('renders cleanly across extreme boundary sizes without distortion or coordinate degradation', () => {
      for (const size of BOUNDARY_SIZES) {
        const m = createFridayMascot(undefined, { size });
        expect(m.el.style.width).toBe(`${size}px`);
        expect(m.el.style.height).toBe(`${size}px`);

        const svg = m.el.querySelector('svg');
        expect(svg).not.toBeNull();
        if (svg) {
          expect(svg.getAttribute('viewBox')).toBe('0 0 120 120');
          expect(svg.getAttribute('width')).toBe(`${size}`);
          expect(svg.getAttribute('height')).toBe(`${size}`);
        }

        m.destroy();
      }
    });

    it('handles dynamic setSize updates and rejects non-finite, negative, or zero dimensions', () => {
      mascot = createFridayMascot(undefined, { size: 36 });
      expect(mascot.el.style.width).toBe('36px');

      // Valid dynamic resize
      mascot.setSize(72);
      expect(mascot.el.style.width).toBe('72px');
      expect(mascot.el.style.height).toBe('72px');

      // Boundary / invalid values: must be safely rejected without mutating current dimensions
      mascot.setSize(0);
      expect(mascot.el.style.width).toBe('72px');

      mascot.setSize(-24);
      expect(mascot.el.style.width).toBe('72px');

      mascot.setSize(Number.NaN);
      expect(mascot.el.style.width).toBe('72px');

      mascot.setSize(Number.POSITIVE_INFINITY);
      expect(mascot.el.style.width).toBe('72px');
    });

    it('falls back to default size (36px) when size is omitted or non-numeric in options', () => {
      const m1 = createFridayMascot();
      expect(m1.el.style.width).toBe('36px');
      expect(m1.el.style.height).toBe('36px');
      m1.destroy();

      const m2 = createFridayMascot(undefined, { size: 0 });
      expect(m2.el.style.width).toBe('36px');
      m2.destroy();

      const m3 = createFridayMascot(undefined, { size: -50 });
      expect(m3.el.style.width).toBe('36px');
      m3.destroy();
    });
  });

  // ==========================================================================
  // 2. ObservableStore Reactivity & Edge Cases
  // ==========================================================================
  describe('2. ObservableStore Reactivity & Edge Cases', () => {
    it('operates safely when AppContext or store is completely unattached', () => {
      // 1. Completely unattached (no arguments)
      expect(() => {
        const m = createFridayMascot();
        expect(m.getState()).toBe('idle');
        m.setState('thinking');
        expect(m.getState()).toBe('thinking');
        m.destroy();
      }).not.toThrow();

      // 2. Empty context object
      expect(() => {
        const m = createFridayMascot({} as unknown as TestContext);
        expect(m.getState()).toBe('idle');
        m.destroy();
      }).not.toThrow();

      // 3. Null store property
      expect(() => {
        const m = createFridayMascot({ store: null } as unknown as TestContext);
        expect(m.getState()).toBe('idle');
        m.destroy();
      }).not.toThrow();
    });

    it('safely handles unrecognized state strings by normalizing to canonical idle fallback', () => {
      mascot = createFridayMascot(ctx);

      // Pass unrecognizable string
      mascot.setState('UNRECOGNIZED_STATE_99' as unknown as MascotState);
      expect(mascot.getState()).toBe('idle');

      // Pass undefined or null as state
      mascot.setState(undefined as unknown as MascotState);
      expect(mascot.getState()).toBe('idle');

      mascot.setState(null as unknown as MascotState);
      expect(mascot.getState()).toBe('idle');
    });

    it('normalizes legacy state names to correct canonical states', () => {
      mascot = createFridayMascot(ctx);

      mascot.setState('working' as unknown as MascotState);
      expect(mascot.getState()).toBe('tool_execution');

      mascot.setState('finished' as unknown as MascotState);
      expect(mascot.getState()).toBe('success');

      mascot.setState('sleeping' as unknown as MascotState);
      expect(mascot.getState()).toBe('sleep');

      mascot.setState('paused' as unknown as MascotState);
      expect(mascot.getState()).toBe('sleep');

      mascot.setState('halted' as unknown as MascotState);
      expect(mascot.getState()).toBe('sleep');

      mascot.setState('question' as unknown as MascotState);
      expect(mascot.getState()).toBe('thinking');

      mascot.setState('approval' as unknown as MascotState);
      expect(mascot.getState()).toBe('success');

      mascot.setState('searching' as unknown as MascotState);
      expect(mascot.getState()).toBe('tool_execution');
    });

    it('handles store updates cleanly when mascot is unmounted or destroyed', () => {
      mascot = createFridayMascot(ctx);
      expect(mascot.getState()).toBe('idle');

      // Destroy the mascot (unmounting and unsubscribing from store)
      mascot.destroy();

      // Dispatch store state transitions post-destroy
      const now = ctx.now();
      expect(() => {
        ctx.store.patch('activity', {
          reactions: [{ id: 999, kind: 'failed', at: now }],
        });
        ctx.store.patch('system', { connection: 'stopped' });
        ctx.store.patch('prefs', { motion: 'reduce' });
      }).not.toThrow();

      // State on destroyed handle remains at last held state without throws
      expect(mascot.getState()).toBe('idle');
    });

    it('preserves user manual state override against subsequent background store events', () => {
      mascot = createFridayMascot(ctx);
      expect(mascot.getState()).toBe('idle');

      // User manually overrides mascot state
      mascot.setState('sleep');
      expect(mascot.getState()).toBe('sleep');

      // Store fires an active tool command event that would otherwise map to tool_execution
      const now = ctx.now();
      ctx.store.patch('activity', {
        agents: {
          a1: {
            current: { at: now, tool: 'Terminal', kind: 'command', target: 'run', decision: 'allow', taskId: null },
            log: [],
            usage: null,
            model: null,
          },
        },
      });

      // Mascot remains in user-overridden state
      expect(mascot.getState()).toBe('sleep');
      expect(mascot.el.dataset.state).toBe('sleep');
    });
  });

  // ==========================================================================
  // 3. Reduced-Motion Accessibility
  // ==========================================================================
  describe('3. Reduced-Motion Accessibility', () => {
    it('detects prefers-reduced-motion: reduce and suppresses continuous RAF oscillation', () => {
      const originalMatchMedia = window.matchMedia;
      try {
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
          matches: query === '(prefers-reduced-motion: reduce)',
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }));

        mascot = createFridayMascot();
        expect(mascot.engine.reduced).toBe(true);

        // Motion controller verification
        const controller = new MascotMotionController({ initialState: 'idle', reducedMotion: true });
        expect(controller.reducedMotion).toBe(true);

        // Simulate 60 ticks (1 full second at 60Hz)
        const poses = [];
        for (let i = 0; i < 60; i++) {
          poses.push(controller.tick(0.016));
        }

        // Under reduced motion, pose coordinates must remain static at base pose
        const firstPose = poses[0];
        expect(firstPose).toBeDefined();
        if (firstPose) {
          expect(firstPose.bodyY).toBe(STATE_BASE_POSES.idle.bodyY);
          expect(firstPose.scaleY).toBe(STATE_BASE_POSES.idle.scaleY);
          expect(firstPose.tilt).toBe(STATE_BASE_POSES.idle.tilt);

          for (const p of poses) {
            expect(p.bodyY).toBe(firstPose.bodyY);
            expect(p.scaleY).toBe(firstPose.scaleY);
            expect(p.tilt).toBe(firstPose.tilt);
          }
        }

        controller.destroy();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it('maintains state pose updates under reduced motion when state changes', () => {
      const controller = new MascotMotionController({ initialState: 'idle', reducedMotion: true });

      // Initial idle pose
      expect(controller.getPose().bodyY).toBe(STATE_BASE_POSES.idle.bodyY);
      expect(controller.getPose().tilt).toBe(STATE_BASE_POSES.idle.tilt);

      // Switch to thinking: pose must jump immediately to thinking rest pose
      controller.setState('thinking');
      expect(controller.getState()).toBe('thinking');
      expect(controller.getPose().bodyY).toBe(STATE_BASE_POSES.thinking.bodyY);
      expect(controller.getPose().tilt).toBe(STATE_BASE_POSES.thinking.tilt);

      // Switch to error: pose must jump immediately to error rest pose
      controller.setState('error');
      expect(controller.getState()).toBe('error');
      expect(controller.getPose().bodyY).toBe(STATE_BASE_POSES.error.bodyY);
      expect(controller.getPose().scaleY).toBe(STATE_BASE_POSES.error.scaleY);

      // Switch to sleep: pose must jump immediately to sleep rest pose
      controller.setState('sleep');
      expect(controller.getState()).toBe('sleep');
      expect(controller.getPose().bodyY).toBe(STATE_BASE_POSES.sleep.bodyY);
      expect(controller.getPose().eyeLid).toBe(STATE_BASE_POSES.sleep.eyeLid);

      controller.destroy();
    });

    it('suppresses triggerImpulse when reduced motion is enabled', () => {
      const controller = new MascotMotionController({ initialState: 'idle', reducedMotion: true });
      const initialPose = { ...controller.getPose() };

      // Trigger high impulse
      controller.triggerImpulse(0, -50);
      const afterImpulsePose = controller.getPose();

      // Pose remains completely unchanged
      expect(afterImpulsePose.bodyY).toBe(initialPose.bodyY);
      expect(afterImpulsePose.scaleY).toBe(initialPose.scaleY);

      controller.destroy();
    });

    it('synchronizes reduced-motion dynamically with store prefs.motion changes', () => {
      mascot = createFridayMascot(ctx);
      expect(mascot.engine.reduced).toBe(false);

      ctx.store.patch('prefs', { motion: 'reduce' });
      expect(mascot.engine.reduced).toBe(true);

      ctx.store.patch('prefs', { motion: 'full' });
      expect(mascot.engine.reduced).toBe(false);
    });
  });

  // ==========================================================================
  // 4. Zero Emojis & Friday Naming Strict Invariants
  // ==========================================================================
  describe('4. Zero Emojis & Friday Naming Strict Invariants', () => {
    const ALL_STATES: MascotState[] = ['idle', 'thinking', 'tool_execution', 'success', 'error', 'sleep'];
    const ALL_ACCESSORIES: MascotAccessory[] = ['hands', 'laptop', 'sunglasses', 'hat', 'headphones', 'cloud_thoughts'];

    it('guarantees strictly zero Unicode emojis across all states and accessories', () => {
      const emojiRegex = /\p{Extended_Pictographic}/u;

      for (const state of ALL_STATES) {
        mascot = createFridayMascot(undefined, { state, accessories: ALL_ACCESSORIES });
        const markup = mascot.el.innerHTML;

        const match = markup.match(emojiRegex);
        expect(match, `Forbidden emoji detected in state ${state}: ${match?.[0]}`).toBeNull();
        mascot.destroy();
      }
    });

    it('guarantees character name is strictly Friday with zero occurrences of legacy Blip or Flip', () => {
      const legacyRegex = /\b(blip|flip)\b/i;

      for (const state of ALL_STATES) {
        mascot = createFridayMascot(undefined, { state, accessories: ALL_ACCESSORIES });
        const hostMarkup = mascot.el.outerHTML;

        expect(hostMarkup).not.toMatch(legacyRegex);
        expect(mascot.el.dataset.mascot).toBe('friday');
        expect(mascot.el.getAttribute('aria-label')).toContain('Friday');
        mascot.destroy();
      }
    });
  });
});
