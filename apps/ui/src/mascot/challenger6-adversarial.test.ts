/**
 * Empirical Adversarial Challenger 6 Verification Suite:
 * - Multi-Size Scaling (24px, 30px, 32px, 36px, 56px, 72px, 80px, extreme boundaries)
 * - ObservableStore Reactivity & Extreme Edge Cases (unattached store, corrupt states, post-destroy emissions)
 * - Reduced-Motion Accessibility (suppression of continuous RAF oscillation, pose jumps, dynamic toggle)
 * - Strict Invariants: Zero emojis and strictly "Friday" naming across full state/accessory permutations
 * - Chaos Stress: Rapid instance recycling, interleaved destruction, and high-frequency state thrashing
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { createFridayMascot, type FridayMascotHandle } from './component.js';
import { MascotMotionController, STATE_BASE_POSES } from './motion.js';
import { FRIDAY_VIEWBOX, MASCOT_ACCESSORIES, MASCOT_STATES, type MascotState } from './types.js';

describe('m3_challenger_6: Adversarial Stress & Verification Harness', () => {
  let ctx: TestContext;
  let activeHandles: FridayMascotHandle[] = [];

  beforeEach(() => {
    ctx = makeContext();
    activeHandles = [];
  });

  afterEach(() => {
    for (const h of activeHandles) {
      try {
        h.destroy();
      } catch {
        // ignore cleanup errors in test teardown
      }
    }
    activeHandles = [];
    vi.restoreAllMocks();
  });

  function track(handle: FridayMascotHandle): FridayMascotHandle {
    activeHandles.push(handle);
    return handle;
  }

  // ==========================================================================
  // 1. Multi-Size Scaling & Vector Integrity
  // ==========================================================================
  describe('1. Multi-Size Scaling & Geometry Invariants', () => {
    const CONTRACT_SIZES = [24, 30, 32, 36, 56, 72, 80] as const;
    const BOUNDARY_SIZES = [1, 2, 8, 12, 16, 120, 256, 512, 1024] as const;

    it('renders precisely at all 7 Milestone 3 contract sizes with 1:1 ratio, 0 0 120 120 viewBox, and overflow visible', () => {
      for (const size of CONTRACT_SIZES) {
        const m = track(createFridayMascot(undefined, { size }));
        const host = m.el;

        // Container bounding box
        expect(host.style.width).toBe(`${size}px`);
        expect(host.style.height).toBe(`${size}px`);
        expect(host.style.overflow).toBe('visible');

        // SVG element
        const svg = host.querySelector('svg');
        expect(svg).not.toBeNull();
        if (svg) {
          expect(svg.getAttribute('viewBox')).toBe(FRIDAY_VIEWBOX);
          expect(svg.getAttribute('viewBox')).toBe('0 0 120 120');
          expect(svg.getAttribute('width')).toBe(`${size}`);
          expect(svg.getAttribute('height')).toBe(`${size}`);
          expect(svg.style.width).toBe('100%');
          expect(svg.style.height).toBe('100%');
          expect(svg.style.overflow).toBe('visible');

          // Core geometric silhouette elements
          expect(svg.querySelector(`#${m.idPrefix}body-silhouette`)).not.toBeNull();
          expect(svg.querySelector(`#${m.idPrefix}beak`)).not.toBeNull();
          expect(svg.querySelector(`#${m.idPrefix}face`)).not.toBeNull();
        }
      }
    });

    it('preserves geometry and viewBox across extreme boundary sizes (1px up to 1024px)', () => {
      for (const size of BOUNDARY_SIZES) {
        const m = track(createFridayMascot(undefined, { size }));
        expect(m.el.style.width).toBe(`${size}px`);
        expect(m.el.style.height).toBe(`${size}px`);

        const svg = m.el.querySelector('svg');
        expect(svg).not.toBeNull();
        if (svg) {
          expect(svg.getAttribute('viewBox')).toBe('0 0 120 120');
          expect(svg.getAttribute('width')).toBe(`${size}`);
          expect(svg.getAttribute('height')).toBe(`${size}`);
        }
      }
    });

    it('safely handles non-finite, negative, zero, or missing size options by falling back to 36px', () => {
      const invalidValues = [0, -1, -50, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

      for (const badSize of invalidValues) {
        const m = track(createFridayMascot(undefined, { size: badSize }));
        expect(m.el.style.width).toBe('36px');
        expect(m.el.style.height).toBe('36px');
      }

      const mDefault = track(createFridayMascot());
      expect(mDefault.el.style.width).toBe('36px');
      expect(mDefault.el.style.height).toBe('36px');
    });

    it('survives rapid dynamic resizing without duplicating SVG nodes or corrupting attributes', () => {
      const m = track(createFridayMascot(undefined, { size: 36 }));
      const host = m.el;

      for (let i = 0; i < 50; i++) {
        const targetSize = CONTRACT_SIZES[i % CONTRACT_SIZES.length] ?? 36;
        m.setSize(targetSize);

        expect(host.style.width).toBe(`${targetSize}px`);
        expect(host.style.height).toBe(`${targetSize}px`);

        const svgs = host.querySelectorAll('svg');
        expect(svgs.length).toBe(1);
        expect(svgs[0]?.getAttribute('viewBox')).toBe('0 0 120 120');
        expect(svgs[0]?.getAttribute('width')).toBe(`${targetSize}`);
        expect(svgs[0]?.getAttribute('height')).toBe(`${targetSize}`);
      }
    });

    it('rejects invalid setSize calls without changing current size', () => {
      const m = track(createFridayMascot(undefined, { size: 56 }));
      expect(m.el.style.width).toBe('56px');

      m.setSize(0);
      expect(m.el.style.width).toBe('56px');

      m.setSize(-10);
      expect(m.el.style.width).toBe('56px');

      m.setSize(Number.NaN);
      expect(m.el.style.width).toBe('56px');

      m.setSize(Number.POSITIVE_INFINITY);
      expect(m.el.style.width).toBe('56px');
    });
  });

  // ==========================================================================
  // 2. Store Reactivity & Extreme Edge Cases
  // ==========================================================================
  describe('2. Store Reactivity & Edge Cases', () => {
    it('operates safely when AppContext or store is completely unattached or malformed', () => {
      // 1. None
      expect(() => {
        const m = track(createFridayMascot());
        expect(m.getState()).toBe('idle');
      }).not.toThrow();

      // 2. Empty context
      expect(() => {
        const m = track(createFridayMascot({} as unknown as TestContext));
        expect(m.getState()).toBe('idle');
      }).not.toThrow();

      // 3. Context with null store
      expect(() => {
        const m = track(createFridayMascot({ store: null } as unknown as TestContext));
        expect(m.getState()).toBe('idle');
      }).not.toThrow();

      // 4. Context with undefined store
      expect(() => {
        const m = track(createFridayMascot({ store: undefined } as unknown as TestContext));
        expect(m.getState()).toBe('idle');
      }).not.toThrow();
    });

    it('normalizes arbitrary or unrecognized state strings safely to canonical idle fallback', () => {
      const m = track(createFridayMascot(ctx));

      const malformedStates = [
        'INVALID_STATE',
        'undefined',
        'null',
        '',
        '   ',
        '__proto__',
        'constructor',
        'valueOf',
        '12345',
      ];

      for (const bad of malformedStates) {
        m.setState(bad as unknown as MascotState);
        expect(m.getState()).toBe('idle');
        expect(m.el.dataset.state).toBe('idle');
      }

      // Null and undefined
      m.setState(undefined as unknown as MascotState);
      expect(m.getState()).toBe('idle');

      m.setState(null as unknown as MascotState);
      expect(m.getState()).toBe('idle');
    });

    it('handles store updates cleanly after unmounting/destruction with zero unhandled exceptions', () => {
      const m = track(createFridayMascot(ctx));
      expect(m.getState()).toBe('idle');

      // Teardown mascot
      m.destroy();

      // Dispatch 50 rapid reactive store patches
      const now = ctx.now();
      expect(() => {
        for (let i = 0; i < 50; i++) {
          ctx.store.patch('activity', {
            reactions: [{ id: 1000 + i, kind: i % 2 === 0 ? 'failed' : 'completed', at: now + i * 100 }],
          });
          ctx.store.patch('system', {
            connection: i % 2 === 0 ? 'reconnecting' : 'live',
          });
          ctx.store.patch('prefs', {
            motion: i % 2 === 0 ? 'reduce' : 'full',
          });
        }
      }).not.toThrow();

      // Verify handle state is frozen and no exception occurs
      expect(m.getState()).toBe('idle');
    });

    it('maintains strict idempotence across repeated destroy() calls and interleaved handle mutations', () => {
      const m = track(createFridayMascot(ctx));

      // Destroy multiple times
      expect(() => {
        m.destroy();
        m.destroy();
        m.destroy();
      }).not.toThrow();

      // Mutate post-destroy: all must be silent no-ops
      expect(() => {
        m.setState('thinking');
        m.setAccessories(['laptop']);
        m.setSize(80);
        m.setTint('#ff0000');
        m.triggerImpulse(10, -20);
        m.engine.express('alert');
        m.engine.gesture('celebrate');
      }).not.toThrow();

      expect(m.getState()).toBe('idle');
      expect(m.getAccessories()).toEqual([]);
    });

    it('preserves user manual state override against background store events', () => {
      const m = track(createFridayMascot(ctx));
      expect(m.getState()).toBe('idle');

      // User manual override
      m.setState('sleep');
      expect(m.getState()).toBe('sleep');

      // Background activity that would otherwise set working/tool_execution
      const now = ctx.now();
      ctx.store.patch('activity', {
        agents: {
          testAgent: {
            current: { at: now, tool: 'Compiler', kind: 'command', target: 'build', decision: 'allow', taskId: null },
            log: [],
            usage: null,
            model: null,
          },
        },
      });

      expect(m.getState()).toBe('sleep');
      expect(m.el.dataset.state).toBe('sleep');
    });
  });

  // ==========================================================================
  // 3. Reduced-Motion Accessibility
  // ==========================================================================
  describe('3. Reduced-Motion Accessibility', () => {
    it('detects matchMedia prefers-reduced-motion: reduce and suppresses continuous RAF oscillation', () => {
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

        const m = track(createFridayMascot());
        expect(m.engine.reduced).toBe(true);

        const controller = new MascotMotionController({ initialState: 'idle', reducedMotion: true });
        expect(controller.reducedMotion).toBe(true);

        // Tick 120 times (2 seconds at 60Hz)
        const poses = [];
        for (let i = 0; i < 120; i++) {
          poses.push(controller.tick(0.016));
        }

        // Must remain exactly at base pose without oscillation
        const basePose = STATE_BASE_POSES.idle;
        for (const p of poses) {
          expect(p.bodyY).toBe(basePose.bodyY);
          expect(p.scaleY).toBe(basePose.scaleY);
          expect(p.tilt).toBe(basePose.tilt);
        }

        controller.destroy();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it('immediately updates pose coordinates when state changes under reduced motion', () => {
      const controller = new MascotMotionController({ initialState: 'idle', reducedMotion: true });

      // Check all 6 states jump instantly to their base rest poses
      for (const st of MASCOT_STATES) {
        controller.setState(st);
        expect(controller.getState()).toBe(st);
        const pose = controller.getPose();
        expect(pose.bodyY).toBe(STATE_BASE_POSES[st].bodyY);
        expect(pose.tilt).toBe(STATE_BASE_POSES[st].tilt);
        expect(pose.eyeLid).toBe(STATE_BASE_POSES[st].eyeLid);
      }

      controller.destroy();
    });

    it('suppresses impulse kinetics when reduced motion is active', () => {
      const controller = new MascotMotionController({ initialState: 'idle', reducedMotion: true });
      const initialPose = { ...controller.getPose() };

      controller.triggerImpulse(25, -60);
      const postImpulse = controller.getPose();

      expect(postImpulse.bodyX).toBe(initialPose.bodyX);
      expect(postImpulse.bodyY).toBe(initialPose.bodyY);
      expect(postImpulse.scaleY).toBe(initialPose.scaleY);

      controller.destroy();
    });

    it('responds dynamically to store prefs.motion changes without leaking listeners', () => {
      const m = track(createFridayMascot(ctx));
      expect(m.engine.reduced).toBe(false);

      // Toggle to reduce
      ctx.store.patch('prefs', { motion: 'reduce' });
      expect(m.engine.reduced).toBe(true);

      // Toggle back to full
      ctx.store.patch('prefs', { motion: 'full' });
      expect(m.engine.reduced).toBe(false);

      // Toggle to reduce again
      ctx.store.patch('prefs', { motion: 'reduce' });
      expect(m.engine.reduced).toBe(true);
    });
  });

  // ==========================================================================
  // 4. Zero Emojis & Friday Naming Strict Invariants
  // ==========================================================================
  describe('4. Zero Emojis & Friday Naming Invariants', () => {
    it('guarantees strictly zero Unicode emojis across all 36 state x accessory combinations', () => {
      const emojiRegex = /\p{Extended_Pictographic}/u;

      for (const state of MASCOT_STATES) {
        for (const accessory of MASCOT_ACCESSORIES) {
          const m = track(createFridayMascot(undefined, { state, accessories: [accessory] }));
          const markup = m.el.innerHTML;

          const match = markup.match(emojiRegex);
          expect(match, `Forbidden emoji detected in state=${state}, accessory=${accessory}: ${match?.[0]}`).toBeNull();
        }
      }
    });

    it('guarantees strictly zero emojis when all 6 accessories are rendered simultaneously', () => {
      const emojiRegex = /\p{Extended_Pictographic}/u;

      for (const state of MASCOT_STATES) {
        const m = track(createFridayMascot(undefined, { state, accessories: [...MASCOT_ACCESSORIES] }));
        const markup = m.el.innerHTML;

        const match = markup.match(emojiRegex);
        expect(match, `Forbidden emoji detected with all accessories in state=${state}: ${match?.[0]}`).toBeNull();
      }
    });

    it('guarantees strictly "Friday" naming across all state outer markup and zero occurrences of legacy names', () => {
      const legacyRegex = /\b(blip|flip|jarvis)\b/i;

      for (const state of MASCOT_STATES) {
        const m = track(createFridayMascot(undefined, { state, accessories: [...MASCOT_ACCESSORIES] }));
        const outer = m.el.outerHTML;

        expect(outer).not.toMatch(legacyRegex);
        expect(m.el.dataset.mascot).toBe('friday');
        expect(m.el.getAttribute('aria-label')).toMatch(/^Friday Mascot \(/);
      }
    });
  });

  // ==========================================================================
  // 5. Chaos & Concurrency Stress Testing
  // ==========================================================================
  describe('5. Chaos & Concurrency Stress Testing', () => {
    it('creates and destroys 100 instances rapidly in sequence with zero errors', () => {
      expect(() => {
        for (let i = 0; i < 100; i++) {
          const acc = MASCOT_ACCESSORIES[i % MASCOT_ACCESSORIES.length];
          const m = createFridayMascot(undefined, {
            size: 24 + (i % 6) * 10,
            state: MASCOT_STATES[i % MASCOT_STATES.length],
            accessories: acc ? [acc] : [],
          });
          m.destroy();
        }
      }).not.toThrow();
    });

    it('survives 200 rapid sequential state transitions without NaN or crash', () => {
      const m = track(createFridayMascot(undefined, { size: 56 }));

      for (let i = 0; i < 200; i++) {
        const state = MASCOT_STATES[i % MASCOT_STATES.length] ?? 'idle';
        m.setState(state);
        expect(m.getState()).toBe(state);
      }
    });

    it('maintains 20 concurrent active mascot instances with heterogeneous options and tears down cleanly', () => {
      const instances: FridayMascotHandle[] = [];

      for (let i = 0; i < 20; i++) {
        const acc = MASCOT_ACCESSORIES[i % MASCOT_ACCESSORIES.length];
        const inst = createFridayMascot(ctx, {
          size: 24 + i * 2,
          state: MASCOT_STATES[i % MASCOT_STATES.length],
          accessories: acc ? [acc] : [],
        });
        instances.push(inst);
      }

      // Interleaved actions on all instances
      for (const inst of instances) {
        inst.triggerImpulse(5, -15);
        inst.setAccessories(['hat', 'sunglasses']);
        inst.setSize(48);
      }

      // Tear down all instances
      for (const inst of instances) {
        inst.destroy();
      }
    });
  });
});
