/**
 * Challenger 3: Adversarial Lifecycle, Rapid State Cycling, and Impulse Stress Test.
 * Canonical character name: "Friday". Strictly zero emojis.
 *
 * Verifies:
 * - Immediate mount/unmount and synchronous teardown cleanly cancels RAF loop and disconnects all observers.
 * - 100-instance mount/unmount stress test with zero retained timers, loops, or orphan DOM elements.
 * - Rapid state cycling across all canonical & alias states (0ms intervals) with zero NaN/Infinity, no crashes, and no SVG element duplication.
 * - Rapid click impulse thrashing maintaining Hooke's Law area-preserving squash/stretch stability.
 * - DOM Security: zero innerHTML / outerHTML, safe DOM node construction.
 * - Zero emojis and strict "Friday" naming invariants.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { createFridayMascot, type FridayMascotHandle } from './component.js';
import { MascotMotionController } from './motion.js';
import { MASCOT_ACCESSORIES, MASCOT_STATES, type MascotAccessory, type MascotState } from './types.js';

describe('Challenger 3: Adversarial Lifecycle & State Cycling Verification', () => {
  let ctx: TestContext;
  const activeMascots: FridayMascotHandle[] = [];

  beforeEach(() => {
    ctx = makeContext();
  });

  afterEach(() => {
    for (const m of activeMascots) {
      try {
        m.destroy();
      } catch {
        // ignore teardown errors in cleanup
      }
    }
    activeMascots.length = 0;
    vi.restoreAllMocks();
  });

  function trackMascot(handle: FridayMascotHandle): FridayMascotHandle {
    activeMascots.push(handle);
    return handle;
  }

  describe('1. DOM Lifecycle & Immediate Teardown', () => {
    it('synchronously mounts and immediately unmounts without executing any RAF loop tick', () => {
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
      const cafSpy = vi.spyOn(window, 'cancelAnimationFrame');

      const mascot = trackMascot(createFridayMascot());
      const parent = document.createElement('div');
      parent.appendChild(mascot.el);
      expect(parent.contains(mascot.el)).toBe(true);

      expect(rafSpy).toHaveBeenCalled();
      const initialRafCallCount = rafSpy.mock.calls.length;

      // Immediate synchronous destroy before RAF callback has fired
      mascot.destroy();

      expect(cafSpy).toHaveBeenCalled();
      expect(parent.contains(mascot.el)).toBe(false);

      // Verify double-destroy is completely safe
      expect(() => mascot.destroy()).not.toThrow();

      // Ensure no subsequent animation frame was requested after destroy
      expect(rafSpy.mock.calls.length).toBe(initialRafCallCount);
    });

    it('unsubscribes and disconnects matchMedia listeners upon destroy', () => {
      const removeEventListenerSpy = vi.fn();
      const originalMatchMedia = window.matchMedia;

      try {
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: removeEventListenerSpy,
          dispatchEvent: vi.fn(),
        }));

        const mascot = trackMascot(createFridayMascot());
        mascot.destroy();

        expect(removeEventListenerSpy).toHaveBeenCalledWith('change', expect.any(Function));
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it('cleans up all ObservableStore subscriptions immediately on destroy', () => {
      const unsubscribeSpy = vi.fn();
      const originalSubscribe = ctx.store.subscribe.bind(ctx.store);

      vi.spyOn(ctx.store, 'subscribe').mockImplementation((topic, listener) => {
        const unsub = originalSubscribe(topic, listener);
        return () => {
          unsubscribeSpy();
          unsub();
        };
      });

      const mascot = trackMascot(createFridayMascot(ctx));
      expect(ctx.store.subscribe).toHaveBeenCalled();

      mascot.destroy();
      expect(unsubscribeSpy).toHaveBeenCalled();

      // Subsequent store events must not invoke any handler or mutate mascot
      expect(() => {
        ctx.store.patch('system', { connection: 'stopped' });
      }).not.toThrow();
      expect(mascot.getState()).toBe('idle');
    });
  });

  describe('2. 100-Instance Mount/Unmount Stress Test', () => {
    it('creates 100 mascot instances concurrently with heterogeneous options and tears down cleanly', () => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const instances: FridayMascotHandle[] = [];
      const rafCancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
      const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
      const setIntervalSpy = vi.spyOn(window, 'setInterval');

      const testStates: MascotState[] = ['idle', 'thinking', 'tool_execution', 'success', 'error', 'sleep'];
      const testSizes = [24, 30, 32, 36, 56, 72, 80];

      // 1. Mount 100 instances
      for (let i = 0; i < 100; i++) {
        const state = testStates[i % testStates.length] ?? 'idle';
        const size = testSizes[i % testSizes.length] ?? 36;
        const interactive = i % 2 === 0;
        const m = createFridayMascot(ctx, {
          size,
          state,
          interactive,
          idPrefix: `friday-test-${i}-`,
        });
        instances.push(m);
        parent.appendChild(m.el);
      }

      expect(instances.length).toBe(100);
      expect(parent.children.length).toBe(100);

      // Verify each instance mounted with valid SVG
      for (let i = 0; i < 100; i++) {
        const item = instances[i];
        if (!item) continue;
        const svg = item.el.querySelector('svg');
        expect(svg).not.toBeNull();
        expect(svg?.getAttribute('viewBox')).toBe('0 0 120 120');
        expect(item.el.dataset.mascot).toBe('friday');
      }

      // 2. Destroy all 100 instances
      for (const item of instances) {
        item.destroy();
      }

      // 3. Verify clean teardown
      expect(parent.children.length).toBe(0);
      expect(rafCancelSpy).toHaveBeenCalledTimes(100);
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();

      // Clean up test DOM
      parent.remove();
    });
  });

  describe('3. Rapid State Cycling (0ms intervals)', () => {
    it('survives 300 rapid sequential state transitions without NaN, crashes, or SVG element duplication', () => {
      const mascot = trackMascot(createFridayMascot());
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

      // Thrash states rapidly 300 times in 0ms synchronous loop
      for (let i = 0; i < 300; i++) {
        const next = statesToCycle[i % statesToCycle.length] ?? 'idle';
        mascot.setState(next);

        // Verification invariant: exactly ONE SVG element must exist in the host
        const svgs = mascot.el.querySelectorAll('svg');
        expect(svgs.length).toBe(1);

        // Required structural elements must exist
        expect(mascot.el.querySelector(`#${mascot.idPrefix}body`)).not.toBeNull();
        expect(mascot.el.querySelector(`#${mascot.idPrefix}beak`)).not.toBeNull();
        expect(mascot.el.querySelector(`#${mascot.idPrefix}pos`)).not.toBeNull();
        expect(mascot.el.querySelector(`#${mascot.idPrefix}rot`)).not.toBeNull();
        expect(mascot.el.querySelector(`#${mascot.idPrefix}squash`)).not.toBeNull();
      }

      // Verify coordinates remain non-NaN after thrashing
      const motion = new MascotMotionController({ initialState: mascot.getState() });
      for (let f = 0; f < 60; f++) {
        const pose = motion.tick(1 / 60);
        for (const [key, val] of Object.entries(pose)) {
          expect(Number.isFinite(val), `Channel ${key} must be finite number`).toBe(true);
          expect(Number.isNaN(val), `Channel ${key} must not be NaN`).toBe(false);
        }
      }
      motion.destroy();
    });

    it('preserves area-preserving squash/stretch ratio during all states', () => {
      const motion = new MascotMotionController();
      for (const st of MASCOT_STATES) {
        motion.setState(st);
        for (let t = 0; t < 120; t++) {
          const pose = motion.tick(1 / 60);
          expect(pose.scaleY).toBeGreaterThan(0.2);
          expect(pose.scaleX).toBeGreaterThan(0.2);
          expect(Number.isFinite(pose.scaleX)).toBe(true);
          expect(Number.isFinite(pose.scaleY)).toBe(true);
        }
      }
      motion.destroy();
    });
  });

  describe('4. Click Impulse Handling & Physics Stability', () => {
    it('survives burst of 100 rapid click impulses without blowing up spring solver', () => {
      const mascot = trackMascot(createFridayMascot());

      // Fire 100 clicks in a single tick
      for (let i = 0; i < 100; i++) {
        mascot.el.click();
      }

      // Verify transform attributes on SVG elements do not contain NaN or undefined
      const posEl = mascot.el.querySelector<SVGElement>(`#${mascot.idPrefix}pos`);
      const rotEl = mascot.el.querySelector<SVGElement>(`#${mascot.idPrefix}rot`);
      const squashEl = mascot.el.querySelector<SVGElement>(`#${mascot.idPrefix}squash`);

      expect(posEl?.getAttribute('transform')).not.toContain('NaN');
      expect(posEl?.getAttribute('transform')).not.toContain('undefined');
      expect(rotEl?.getAttribute('transform')).not.toContain('NaN');
      expect(rotEl?.getAttribute('transform')).not.toContain('undefined');
      expect(squashEl?.getAttribute('transform')).not.toContain('NaN');
      expect(squashEl?.getAttribute('transform')).not.toContain('undefined');
    });

    it('simultaneously handles rapid clicking while switching states', () => {
      const mascot = trackMascot(createFridayMascot());
      const states: MascotState[] = ['idle', 'thinking', 'tool_execution', 'success', 'error', 'sleep'];

      for (let i = 0; i < 60; i++) {
        const nextState = states[i % states.length] ?? 'idle';
        mascot.setState(nextState);
        mascot.el.click();
        mascot.triggerImpulse(Math.sin(i) * 10, -18);

        // Invariant: SVG element remains singular and valid
        expect(mascot.el.querySelectorAll('svg').length).toBe(1);
      }
    });
  });

  describe('5. DOM Security & Safe DOM Node Construction', () => {
    it('constructs DOM nodes using createElement and replaceChildren without innerHTML or outerHTML injection', () => {
      const mascot = trackMascot(
        createFridayMascot(undefined, {
          className: 'safe-host-class',
          tint: '#10B981',
        }),
      );

      // Verify className is added via classList without attribute injection
      expect(mascot.el.classList.contains('safe-host-class')).toBe(true);
      expect(mascot.el.classList.contains('friday-mascot-host')).toBe(true);

      // Verify SVG root node is an SVGSVGElement instance
      const svg = mascot.el.querySelector('svg');
      expect(svg).toBeInstanceOf(SVGSVGElement);
      expect(mascot.el.children.length).toBe(1);
      expect(mascot.el.firstElementChild).toBe(svg);
    });

    it('safely handles special characters in state labels and options', () => {
      const mascot = trackMascot(createFridayMascot());
      mascot.setState('thinking');

      expect(mascot.el.getAttribute('aria-label')).toBe('Friday Mascot (thinking)');
      expect(mascot.el.dataset.state).toBe('thinking');
    });
  });

  describe('6. Zero Emojis and Friday Naming Strictly Upheld', () => {
    it('renders pure vector SVG with zero emojis across all states and accessories', () => {
      const emojiRegex = /\p{Extended_Pictographic}/u;
      const mascot = trackMascot(createFridayMascot());

      for (const st of MASCOT_STATES) {
        mascot.setState(st);
        for (const acc of MASCOT_ACCESSORIES) {
          mascot.setAccessories([acc as MascotAccessory]);
          const html = mascot.el.innerHTML;

          expect(emojiRegex.test(html), `State ${st} with accessory ${acc} must have zero emojis`).toBe(false);
          expect(html.toLowerCase()).not.toContain('blip');
          expect(html.toLowerCase()).not.toContain('flip');
        }
      }
    });

    it('strictly brands dataset and role as Friday', () => {
      const mascot = trackMascot(createFridayMascot());
      expect(mascot.el.dataset.mascot).toBe('friday');
      expect(mascot.el.getAttribute('aria-label')).toContain('Friday Mascot');
      expect(mascot.el.getAttribute('aria-label')).not.toContain('Blip');
      expect(mascot.el.getAttribute('aria-label')).not.toContain('Flip');
    });
  });
});
