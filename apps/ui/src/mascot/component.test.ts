/**
 * Unit & Integration Tests for Native DOM Friday Mascot Component.
 *
 * Verifies:
 * - Component creation, DOM mounting, and sizing
 * - Handle methods (getState, setState, getAccessories, setAccessories, setSize, setTint, triggerImpulse)
 * - State variations & canonical alias normalization
 * - Accessory toggling & rendering
 * - Interactive pointer clicks, keyboard events, and spring impulse recoil
 * - Teardown lifecycle and RAF loop cleanup
 * - prefers-reduced-motion accessibility integration
 * - ObservableStore reactive state bindings and motion preferences
 * - Tour & stage engine bridge compatibility
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { createFridayMascot, type FridayMascotHandle } from './component.js';
import { renderFridaySvg } from './svg.js';
import type { MascotState } from './types.js';

describe('createFridayMascot Component', () => {
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

  describe('1. Creation & DOM Mounting', () => {
    it('creates mascot DOM element with default options', () => {
      mascot = createFridayMascot();
      expect(mascot.el).toBeInstanceOf(HTMLElement);
      expect(mascot.el.dataset.mascot).toBe('friday');
      expect(mascot.el.dataset.state).toBe('idle');
      expect(mascot.el.style.width).toBe('36px');
      expect(mascot.el.style.height).toBe('36px');
      expect(mascot.getState()).toBe('idle');
      expect(mascot.getAccessories()).toEqual([]);

      // Contains SVG element with 120x120 viewBox
      const svg = mascot.el.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('viewBox')).toBe('0 0 120 120');
      expect(svg?.getAttribute('role')).toBe('img');
    });

    it('sets interactive attributes on button host by default', () => {
      mascot = createFridayMascot(undefined, { interactive: true });
      expect(mascot.el.tabIndex).toBe(0);
      expect(mascot.el.getAttribute('role')).toBe('button');
      expect(mascot.el.style.cursor).toBe('pointer');
      expect(mascot.el.getAttribute('aria-label')).toBe('Friday Mascot (idle)');
    });

    it('configures non-interactive host as image role without tabindex', () => {
      mascot = createFridayMascot(undefined, { interactive: false });
      expect(mascot.el.getAttribute('role')).toBe('img');
      expect(mascot.el.tabIndex).toBe(-1);
      expect(mascot.el.style.cursor).not.toBe('pointer');
      expect(mascot.el.getAttribute('aria-label')).toBe('Friday Mascot (idle)');
    });

    it('accepts custom className and combines with default classes', () => {
      mascot = createFridayMascot(undefined, { className: 'custom-preview-mascot' });
      expect(mascot.el.classList.contains('friday-mascot-host')).toBe(true);
      expect(mascot.el.classList.contains('ms-mascot')).toBe(true);
      expect(mascot.el.classList.contains('custom-preview-mascot')).toBe(true);
    });

    it('scales cleanly across all standard design sizes (24px, 36px, 56px, 72px, 80px)', () => {
      const sizes = [24, 30, 32, 36, 56, 72, 80];
      for (const size of sizes) {
        const m = createFridayMascot(undefined, { size });
        expect(m.el.style.width).toBe(`${size}px`);
        expect(m.el.style.height).toBe(`${size}px`);
        const svg = m.el.querySelector('svg');
        expect(svg).not.toBeNull();
        expect(svg?.getAttribute('width')).toBe(`${size}`);
        expect(svg?.getAttribute('height')).toBe(`${size}`);
        m.destroy();
      }
    });
  });

  describe('2. Handle State & Accessory Methods', () => {
    it('switches state dynamically and updates DOM dataset and SVG markup', () => {
      mascot = createFridayMascot(undefined, { state: 'idle' });
      expect(mascot.getState()).toBe('idle');

      mascot.setState('thinking');
      expect(mascot.getState()).toBe('thinking');
      expect(mascot.el.dataset.state).toBe('thinking');
      expect(mascot.el.querySelector('#friday-face')).not.toBeNull();

      mascot.setState('tool_execution');
      expect(mascot.getState()).toBe('tool_execution');
      expect(mascot.el.dataset.state).toBe('tool_execution');

      mascot.setState('success');
      expect(mascot.getState()).toBe('success');
      expect(mascot.el.dataset.state).toBe('success');

      mascot.setState('error');
      expect(mascot.getState()).toBe('error');
      expect(mascot.el.dataset.state).toBe('error');

      mascot.setState('sleep');
      expect(mascot.getState()).toBe('sleep');
      expect(mascot.el.dataset.state).toBe('sleep');
    });

    it('normalizes legacy and alias states to canonical states', () => {
      mascot = createFridayMascot();

      mascot.setState('working' as unknown as MascotState);
      expect(mascot.getState()).toBe('tool_execution');

      mascot.setState('finished' as unknown as MascotState);
      expect(mascot.getState()).toBe('success');

      mascot.setState('sleeping' as unknown as MascotState);
      expect(mascot.getState()).toBe('sleep');

      mascot.setState('paused' as unknown as MascotState);
      expect(mascot.getState()).toBe('sleep');

      mascot.setState('question' as unknown as MascotState);
      expect(mascot.getState()).toBe('thinking');
    });

    it('toggles modular accessories dynamically', () => {
      mascot = createFridayMascot();
      expect(mascot.getAccessories()).toEqual([]);

      // Set laptop and hands
      mascot.setAccessories(['laptop', 'hands']);
      expect(mascot.getAccessories()).toEqual(['laptop', 'hands']);
      expect(mascot.el.querySelector('#friday-accessory-laptop')).not.toBeNull();

      // Set sunglasses
      mascot.setAccessories(['sunglasses']);
      expect(mascot.getAccessories()).toEqual(['sunglasses']);
      expect(mascot.el.querySelector('#friday-accessory-sunglasses')).not.toBeNull();
      expect(mascot.el.querySelector('#friday-accessory-laptop')).toBeNull();

      // Set headphones
      mascot.setAccessories(['headphones']);
      expect(mascot.getAccessories()).toEqual(['headphones']);
      expect(mascot.el.querySelector('#friday-headphones-rear')).not.toBeNull();

      // Set cloud thoughts
      mascot.setAccessories(['cloud_thoughts']);
      expect(mascot.getAccessories()).toEqual(['cloud_thoughts']);
      expect(mascot.el.querySelector('#friday-accessory-cloud-thoughts')).not.toBeNull();

      // Clear accessories
      mascot.setAccessories([]);
      expect(mascot.getAccessories()).toEqual([]);
      expect(mascot.el.querySelector('#friday-accessory-cloud-thoughts')).toBeNull();
    });

    it('updates size dynamically via setSize', () => {
      mascot = createFridayMascot(undefined, { size: 36 });
      expect(mascot.el.style.width).toBe('36px');

      mascot.setSize(72);
      expect(mascot.el.style.width).toBe('72px');
      expect(mascot.el.style.height).toBe('72px');
      const svg = mascot.el.querySelector('svg');
      expect(svg?.getAttribute('width')).toBe('72');
      expect(svg?.getAttribute('height')).toBe('72');

      // Ignores invalid size
      mascot.setSize(0);
      expect(mascot.el.style.width).toBe('72px');
      mascot.setSize(-10);
      expect(mascot.el.style.width).toBe('72px');
    });

    it('updates custom status tint via setTint', () => {
      mascot = createFridayMascot();
      mascot.setTint('#FF0055');
      const svg = mascot.el.querySelector('svg');
      expect(svg?.getAttribute('style')).toContain('--friday-status-tint: #FF0055');
    });

    it('applies impulse forces via triggerImpulse', () => {
      mascot = createFridayMascot();
      expect(() => mascot?.triggerImpulse(5, -20)).not.toThrow();
    });
  });

  describe('3. Interactive Clicks & Recoil Events', () => {
    it('triggers spring impulse recoil and invokes onClick callback when clicked', () => {
      const clickSpy = vi.fn();
      mascot = createFridayMascot(undefined, { interactive: true, onClick: clickSpy });
      const impulseSpy = vi.spyOn(mascot, 'triggerImpulse');

      mascot.el.click();

      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(impulseSpy).toHaveBeenCalledWith(0, -18);
    });

    it('triggers recoil and click event on Enter or Space keydown', () => {
      const clickSpy = vi.fn();
      mascot = createFridayMascot(undefined, { interactive: true, onClick: clickSpy });
      const impulseSpy = vi.spyOn(mascot, 'triggerImpulse');

      mascot.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(impulseSpy).toHaveBeenCalledWith(0, -18);

      mascot.el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      expect(clickSpy).toHaveBeenCalledTimes(2);
      expect(impulseSpy).toHaveBeenCalledWith(0, -18);
    });

    it('ignores clicks when interactive is false', () => {
      const clickSpy = vi.fn();
      mascot = createFridayMascot(undefined, { interactive: false, onClick: clickSpy });
      const impulseSpy = vi.spyOn(mascot, 'triggerImpulse');

      mascot.el.click();

      expect(clickSpy).not.toHaveBeenCalled();
      expect(impulseSpy).not.toHaveBeenCalled();
    });
  });

  describe('4. Lifecycle Management & Teardown', () => {
    it('removes elements from DOM and tears down motion loop on destroy', () => {
      mascot = createFridayMascot();
      const parent = document.createElement('div');
      parent.appendChild(mascot.el);
      expect(parent.contains(mascot.el)).toBe(true);

      mascot.destroy();

      expect(parent.contains(mascot.el)).toBe(false);
    });

    it('is safe against multiple destroy calls', () => {
      mascot = createFridayMascot();
      expect(() => {
        mascot?.destroy();
        mascot?.destroy();
        mascot?.destroy();
      }).not.toThrow();
    });

    it('guards against post-destroy setState calls and prevents motion resurrection', () => {
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
      mascot = createFridayMascot(undefined, { state: 'idle' });
      expect(mascot.getState()).toBe('idle');

      // Destroy the component
      mascot.destroy();
      const rafCountAtDestroy = rafSpy.mock.calls.length;

      // Invoking setState post-destroy must be a no-op
      mascot.setState('thinking');

      // Verify state did not change
      expect(mascot.getState()).toBe('idle');
      expect(mascot.el.dataset.state).toBe('idle');

      // Verify motion was not re-attached and no new RAF was scheduled
      expect(rafSpy.mock.calls.length).toBe(rafCountAtDestroy);
      expect(mascot.el.querySelector('svg')).toBeNull();
    });

    it('guards against all handle mutations after destruction (setAccessories, setSize, setTint, triggerImpulse, engine)', () => {
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
      mascot = createFridayMascot(undefined, { state: 'idle', size: 36 });
      mascot.destroy();
      const rafCountAtDestroy = rafSpy.mock.calls.length;

      // Exercise all mutation methods
      mascot.setAccessories(['laptop']);
      expect(mascot.getAccessories()).toEqual([]);

      mascot.setSize(72);
      expect(mascot.el.style.width).toBe('36px');

      mascot.setTint('#FF0055');
      mascot.triggerImpulse(10, -20);
      mascot.engine.express('alert');
      mascot.engine.gesture('celebrate');

      expect(mascot.getState()).toBe('idle');
      expect(rafSpy.mock.calls.length).toBe(rafCountAtDestroy);
    });

    it('preserves idempotency when destroy() is interleaved with handle method calls', () => {
      mascot = createFridayMascot();
      mascot.destroy();

      // Interleave mutations with successive destroy calls
      expect(() => {
        mascot?.setState('thinking');
        mascot?.destroy();
        mascot?.setAccessories(['hat', 'sunglasses']);
        mascot?.destroy();
        mascot?.setSize(80);
        mascot?.destroy();
      }).not.toThrow();

      expect(mascot.getState()).toBe('idle');
    });

    it('ignores ObservableStore reactive updates arriving after destruction', () => {
      mascot = createFridayMascot(ctx, { state: 'idle' });
      mascot.destroy();

      const now = ctx.now();
      ctx.store.patch('activity', {
        agents: {
          a1: {
            current: {
              at: now,
              tool: 'Bash',
              kind: 'command',
              target: 'build',
              decision: 'allow',
              taskId: null,
            },
            log: [],
            usage: null,
            model: null,
          },
        },
      });

      expect(mascot.getState()).toBe('idle');
    });
  });

  describe('5. Reduced-Motion Accessibility', () => {
    it('detects prefers-reduced-motion media query and sets reduced flag', () => {
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
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it('reacts dynamically to media query change events', () => {
      let changeHandler: ((e: { matches: boolean }) => void) | null = null;
      const originalMatchMedia = window.matchMedia;
      try {
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn((event: string, handler: (e: { matches: boolean }) => void) => {
            if (event === 'change') changeHandler = handler;
          }),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }));

        mascot = createFridayMascot();
        expect(mascot.engine.reduced).toBe(false);
        expect(changeHandler).not.toBeNull();

        // User toggles reduced motion in OS settings
        (changeHandler as unknown as (e: { matches: boolean }) => void)({ matches: true });
        expect(mascot.engine.reduced).toBe(true);

        (changeHandler as unknown as (e: { matches: boolean }) => void)({ matches: false });
        expect(mascot.engine.reduced).toBe(false);
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });
  });

  describe('6. ObservableStore Reactive Bindings (Feature 15)', () => {
    it('initializes state derived from active agent tool in store', () => {
      const now = ctx.now();
      ctx.store.patch('activity', {
        agents: {
          a1: {
            current: { at: now, tool: 'Edit', kind: 'write', target: 'a.ts', decision: 'allow', taskId: null },
            log: [],
            usage: null,
            model: null,
          },
        },
      });

      mascot = createFridayMascot(ctx);
      expect(mascot.getState()).toBe('tool_execution');
    });

    it('initializes state derived from active brain jobs in store', () => {
      ctx.store.patch(
        'board',
        makeSnapshot({
          brain_jobs: [{ job_id: 'j1', kind: 'plan', status: 'calling', goal_id: null }],
        }),
      );

      mascot = createFridayMascot(ctx);
      expect(mascot.getState()).toBe('thinking');
    });

    it('reacts dynamically when store activity introduces tool execution', () => {
      mascot = createFridayMascot(ctx);
      expect(mascot.getState()).toBe('idle');

      const now = ctx.now();
      ctx.store.patch('activity', {
        agents: {
          a1: {
            current: { at: now, tool: 'Bash', kind: 'command', target: 'build', decision: 'allow', taskId: null },
            log: [],
            usage: null,
            model: null,
          },
        },
      });

      expect(mascot.getState()).toBe('tool_execution');
      expect(mascot.el.dataset.state).toBe('tool_execution');
    });

    it('reacts dynamically when store records completed reaction', () => {
      mascot = createFridayMascot(ctx);
      expect(mascot.getState()).toBe('idle');

      const now = ctx.now();
      ctx.store.patch('activity', {
        reactions: [{ id: 101, kind: 'completed', at: now }],
      });

      expect(mascot.getState()).toBe('success');
      expect(mascot.el.dataset.state).toBe('success');
    });

    it('reacts dynamically when store records failure reaction', () => {
      mascot = createFridayMascot(ctx);
      expect(mascot.getState()).toBe('idle');

      const now = ctx.now();
      ctx.store.patch('activity', {
        reactions: [{ id: 102, kind: 'failed', at: now }],
      });

      expect(mascot.getState()).toBe('error');
      expect(mascot.el.dataset.state).toBe('error');
    });

    it('reacts dynamically when system connection stops', () => {
      mascot = createFridayMascot(ctx);
      expect(mascot.getState()).toBe('idle');

      ctx.store.patch('system', { connection: 'stopped' });

      expect(mascot.getState()).toBe('sleep');
      expect(mascot.el.dataset.state).toBe('sleep');
    });

    it('reacts dynamically when user changes motion preference in store', () => {
      mascot = createFridayMascot(ctx);
      expect(mascot.engine.reduced).toBe(false);

      ctx.store.patch('prefs', { motion: 'reduce' });
      expect(mascot.engine.reduced).toBe(true);

      ctx.store.patch('prefs', { motion: 'full' });
      expect(mascot.engine.reduced).toBe(false);
    });

    it('retains manual setState override against store changes', () => {
      mascot = createFridayMascot(ctx);
      expect(mascot.getState()).toBe('idle');

      mascot.setState('thinking');
      expect(mascot.getState()).toBe('thinking');

      // Subsequent store reaction does not clobber manual override
      const now = ctx.now();
      ctx.store.patch('activity', {
        reactions: [{ id: 103, kind: 'completed', at: now }],
      });

      expect(mascot.getState()).toBe('thinking');
    });
  });

  describe('7. Stage & Tour Engine Bridge Compatibility', () => {
    it('exposes engine bridge with reduced, express, and gesture methods', () => {
      mascot = createFridayMascot();
      expect(typeof mascot.engine.reduced).toBe('boolean');
      expect(typeof mascot.engine.express).toBe('function');
      expect(typeof mascot.engine.gesture).toBe('function');

      mascot.engine.express('alert');
      expect(mascot.getState()).toBe('thinking');

      mascot.engine.express('calm');
      expect(mascot.getState()).toBe('idle');

      mascot.engine.gesture('celebrate');
      expect(mascot.getState()).toBe('success');

      mascot.engine.gesture('droop');
      expect(mascot.getState()).toBe('error');
    });
  });
});

describe('under Trusted Types (the desktop app refuses strings turned into DOM)', () => {
  it('draws the mascot without DOMParser, innerHTML or insertAdjacentHTML', () => {
    const refuse = () => {
      throw new Error("This document requires 'TrustedHTML' assignment.");
    };
    const parser = vi.spyOn(globalThis, 'DOMParser').mockImplementation(refuse as never);
    const inner = vi.spyOn(Element.prototype, 'innerHTML', 'set').mockImplementation(refuse);
    const adjacent = vi.spyOn(Element.prototype, 'insertAdjacentHTML').mockImplementation(refuse);
    try {
      const svg = renderFridaySvg({ state: 'thinking', accessories: ['hat', 'laptop'], title: 'a & b <c>' });
      expect(svg.tagName.toLowerCase()).toBe('svg');
      expect(svg.getAttribute('viewBox')).toBe('0 0 120 120');
      expect(svg.querySelector('#friday-beak')).not.toBeNull();
      expect(svg.querySelector('#friday-accessory-hat')).not.toBeNull();
      expect(svg.querySelector('#friday-title')?.textContent).toBe('a & b <c>');
      expect(svg.querySelectorAll('ellipse').length).toBeGreaterThan(5);
    } finally {
      parser.mockRestore();
      inner.mockRestore();
      adjacent.mockRestore();
    }
  });
});
