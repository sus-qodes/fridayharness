/**
 * Friday Native DOM Mascot Component.
 * Canonical character name: "Friday". Strictly zero emojis.
 *
 * Implements Friday's Component interface ({ readonly el: HTMLElement; destroy(): void }).
 * Implements FridayMascotHandle.
 *
 * Provides:
 * - Pure vector SVG rendering without innerHTML / outerHTML
 * - Hooke's Law physics integration via MascotMotionController (11-DOF rig solver)
 * - requestAnimationFrame loop driving SVG transforms
 * - Interactive pointer/click impulses and keyboard triggers
 * - Reactive ObservableStore state and motion preferences synchronization
 * - prefers-reduced-motion accessibility support
 */

import type { AppContext, Component } from '../shell/context.js';
import { MascotMotionController } from './motion.js';
import { selectState } from './states.js';
import { renderFridaySvg } from './svg.js';
import {
  type FridayMascotHandle as BaseFridayMascotHandle,
  type FridayMascotOptions as BaseFridayMascotOptions,
  type MascotAccessory,
  type MascotState,
  toCanonicalState,
} from './types.js';

export interface FridayMascotOptions extends BaseFridayMascotOptions {
  idPrefix?: string;
}

export interface FridayMascotEngineBridge {
  readonly reduced: boolean;
  express(mood: string, duration?: number): void;
  gesture(kind: string): void;
}

export interface FridayMascotHandle extends BaseFridayMascotHandle {
  readonly engine: FridayMascotEngineBridge;
}

const DEFAULT_SIZE = 36;
const CLICK_IMPULSE_Y = -18;

/**
 * Every component mascot gets its own id namespace: the SVG's gradients and clip paths are
 * referenced by id (`url(#<prefix>body-grad)`), and several mascots live on one page (the stage,
 * the notch pill, the hub). A shared prefix would make every duck resolve the first-in-document
 * defs — which sit inside a hidden view whenever another view is active, and Chromium refuses
 * paint servers in a `display: none` subtree: the mascot then loses its body.
 */
let instanceCounter = 0;

/**
 * Creates and mounts an interactive Friday mascot DOM component.
 *
 * Conforms to Friday's native Component interface ({ el, destroy })
 * and exposes public control methods on FridayMascotHandle.
 */
export function createFridayMascot(
  ctxOrOptions?: AppContext | FridayMascotOptions,
  maybeOptions?: FridayMascotOptions,
): FridayMascotHandle & Component {
  let ctx: AppContext | undefined;
  let options: FridayMascotOptions | undefined;

  if (ctxOrOptions && ('store' in ctxOrOptions || 'platform' in ctxOrOptions || 'api' in ctxOrOptions)) {
    ctx = ctxOrOptions as AppContext;
    options = maybeOptions;
  } else if (ctxOrOptions) {
    ctx = undefined;
    options = ctxOrOptions as FridayMascotOptions;
  } else {
    ctx = undefined;
    options = maybeOptions;
  }

  let currentSize =
    options?.size !== undefined && Number.isFinite(options.size) && options.size > 0 ? options.size : DEFAULT_SIZE;
  let currentState: MascotState = toCanonicalState(options?.state ?? 'idle');
  let currentAccessories: MascotAccessory[] = options?.accessories ? [...options.accessories] : [];
  let currentTint: string | undefined = options?.tint;
  const prefix = options?.idPrefix ?? `friday-${(instanceCounter += 1)}-`;
  const interactive = options?.interactive !== false;
  let destroyed = false;

  // Root container element
  const host = document.createElement('div');
  const classNames = ['friday-mascot-host', 'ms-mascot'];
  if (options?.className) {
    classNames.push(options.className);
  }
  host.className = classNames.join(' ');
  host.dataset.mascot = 'friday';
  host.dataset.state = currentState;
  host.style.width = `${currentSize}px`;
  host.style.height = `${currentSize}px`;
  host.style.display = 'inline-flex';
  host.style.alignItems = 'center';
  host.style.justifyContent = 'center';
  host.style.position = 'relative';
  host.style.overflow = 'visible';
  host.style.userSelect = 'none';

  if (interactive) {
    host.tabIndex = 0;
    host.setAttribute('role', 'button');
    host.setAttribute('aria-label', `Friday Mascot (${currentState})`);
    host.style.cursor = 'pointer';
  } else {
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', `Friday Mascot (${currentState})`);
  }

  // Motion physics controller
  const motion = new MascotMotionController({ initialState: currentState });

  // Reduced-motion accessibility listener
  let mediaQuery: MediaQueryList | null = null;
  const onMediaChange = (evt: MediaQueryListEvent | MediaQueryList): void => {
    if (destroyed) return;
    motion.setReducedMotion(Boolean(evt.matches));
  };

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      motion.setReducedMotion(mediaQuery.matches);
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', onMediaChange);
      } else if (typeof (mediaQuery as { addListener?: (fn: unknown) => void }).addListener === 'function') {
        (mediaQuery as { addListener: (fn: unknown) => void }).addListener(onMediaChange);
      }
    } catch {
      // Degrade gracefully if matchMedia is unavailable
    }
  }

  // Pure SVG rendering & transform binding
  let detachMotion: (() => void) | null = null;
  let currentSvgEl: SVGSVGElement | null = null;

  function renderCurrentSvg(): void {
    if (destroyed) return;
    if (detachMotion) {
      detachMotion();
      detachMotion = null;
    }

    const svg = renderFridaySvg({
      state: currentState,
      accessories: currentAccessories,
      tint: currentTint,
      size: currentSize,
      idPrefix: prefix,
    });
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';
    svg.style.overflow = 'visible';

    host.replaceChildren(svg);
    currentSvgEl = svg;
    detachMotion = motion.attach(svg, prefix);
  }

  function setState(state: MascotState): void {
    if (destroyed) return;
    userOverrodeState = true;
    const canonical = toCanonicalState(state);
    if (canonical === currentState) return;
    currentState = canonical;
    host.dataset.state = currentState;
    if (interactive) {
      host.setAttribute('aria-label', `Friday Mascot (${currentState})`);
    }
    motion.setState(currentState);
    renderCurrentSvg();
  }

  function triggerImpulse(forceX: number, forceY: number): void {
    if (destroyed) return;
    motion.triggerImpulse(forceX, forceY);
  }

  // Initial render
  renderCurrentSvg();

  // ObservableStore reactive binding (Feature 15)
  const storeUnsubs: (() => void)[] = [];
  let userOverrodeState = options?.state !== undefined;

  if (ctx && 'store' in ctx && ctx.store) {
    const store = ctx.store;

    // Check store motion preference
    const initialPrefs = store.getState().prefs;
    if (initialPrefs?.motion === 'reduce') {
      motion.setReducedMotion(true);
    } else if (initialPrefs?.motion === 'full') {
      motion.setReducedMotion(false);
    }

    // Sync initial state if not overridden in options
    if (!userOverrodeState) {
      const derived = toCanonicalState(selectState(store.getState(), ctx.now ? ctx.now() : Date.now()));
      if (derived !== currentState) {
        currentState = derived;
        host.dataset.state = currentState;
        motion.setState(currentState, true);
        renderCurrentSvg();
      }
    }

    const syncStateFromStore = (): void => {
      if (destroyed || userOverrodeState) return;
      const derived = toCanonicalState(selectState(store.getState(), ctx.now ? ctx.now() : Date.now()));
      if (derived !== currentState) {
        currentState = derived;
        host.dataset.state = currentState;
        if (interactive) {
          host.setAttribute('aria-label', `Friday Mascot (${currentState})`);
        }
        motion.setState(currentState);
        renderCurrentSvg();
      }
    };

    storeUnsubs.push(
      store.subscribe('board', syncStateFromStore),
      store.subscribe('activity', syncStateFromStore),
      store.subscribe('system', syncStateFromStore),
      store.subscribe('ui', syncStateFromStore),
      store.subscribe('prefs', (nextPrefs) => {
        if (destroyed) return;
        if (nextPrefs?.motion === 'reduce') {
          motion.setReducedMotion(true);
        } else if (nextPrefs?.motion === 'full') {
          motion.setReducedMotion(false);
        } else if (mediaQuery) {
          motion.setReducedMotion(mediaQuery.matches);
        }
      }),
    );
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;

    if (detachMotion) {
      detachMotion();
      detachMotion = null;
    }
    motion.destroy();

    if (mediaQuery) {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', onMediaChange);
      } else if (typeof (mediaQuery as { removeListener?: (fn: unknown) => void }).removeListener === 'function') {
        (mediaQuery as { removeListener: (fn: unknown) => void }).removeListener(onMediaChange);
      }
      mediaQuery = null;
    }

    for (const unsub of storeUnsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    storeUnsubs.length = 0;

    host.removeEventListener('click', onClick);
    host.removeEventListener('keydown', onKeyDown);
    currentSvgEl = null;
    host.replaceChildren();
    host.remove();
  }

  const handle: FridayMascotHandle & Component = {
    get el(): HTMLElement {
      return host;
    },
    get idPrefix(): string {
      return prefix;
    },
    getState(): MascotState {
      return currentState;
    },
    setState,
    getAccessories(): MascotAccessory[] {
      return [...currentAccessories];
    },
    setAccessories(accessories: MascotAccessory[]): void {
      if (destroyed) return;
      currentAccessories = [...accessories];
      renderCurrentSvg();
    },
    setSize(size: number): void {
      if (destroyed || !Number.isFinite(size) || size <= 0) return;
      currentSize = size;
      host.style.width = `${size}px`;
      host.style.height = `${size}px`;
      if (currentSvgEl) {
        currentSvgEl.setAttribute('width', `${size}`);
        currentSvgEl.setAttribute('height', `${size}`);
      }
    },
    setTint(tint: string | undefined): void {
      if (destroyed) return;
      currentTint = tint;
      renderCurrentSvg();
    },
    triggerImpulse(forceX: number, forceY: number): void {
      if (destroyed) return;
      triggerImpulse(forceX, forceY);
    },
    get engine(): FridayMascotEngineBridge {
      return {
        get reduced(): boolean {
          return motion.reducedMotion;
        },
        express(mood: string, _duration?: number): void {
          if (destroyed) return;
          if (mood === 'wide' || mood === 'alert') {
            setState('thinking');
          } else {
            setState('idle');
          }
        },
        gesture(kind: string): void {
          if (destroyed) return;
          if (kind === 'celebrate' || kind === 'jump') {
            setState('success');
            handle.triggerImpulse(0, -22);
          } else if (kind === 'droop' || kind === 'sweat') {
            setState('error');
          } else if (kind === 'hop' || kind === 'bounce') {
            handle.triggerImpulse(0, -18);
          }
        },
      };
    },
    destroy,
  };

  // Interactive click & keyboard impulse handling
  const onClick = (e: MouseEvent): void => {
    if (destroyed || !interactive) return;
    handle.triggerImpulse(0, CLICK_IMPULSE_Y);
    options?.onClick?.(e);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (destroyed || !interactive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handle.triggerImpulse(0, CLICK_IMPULSE_Y);
      const clickEvt = new MouseEvent('click', { bubbles: true, cancelable: true });
      host.dispatchEvent(clickEvt);
    }
  };

  host.addEventListener('click', onClick);
  host.addEventListener('keydown', onKeyDown);

  return handle;
}
