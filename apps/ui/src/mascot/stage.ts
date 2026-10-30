/**
 * The walking mascot stage (plan §7.10 onboarding): the mascot and its thought bubble on one
 * fixed overlay that springs between target rectangles — Friday walks to whatever the tour
 * highlights, hops on the way, and speaks above itself. Pointer-transparent: it never blocks
 * the page. Hidden until `show()`; the tour drives it.
 */

import type { AppContext } from '../shell/context.js';
import { h } from '../ui/dom.js';
import {
  type BubbleAction,
  type BubbleEnv,
  type BubbleHandle,
  type BubbleMessage,
  createBubble,
  defaultBubbleEnv,
} from './bubble.js';
import { Spring } from './engine.js';
import { createMascotWith, defaultMascotEnv, type MascotHandle, type MascotOptions } from './mascot.js';

/** A rectangle to walk to, in this window's CSS pixels (the caller measures it). */
export interface StageTarget {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StageEnv {
  doc: Document;
  raf(cb: (now: number) => void): number;
  caf(id: number): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  /** The window's inner size, for keeping the bubble on screen. */
  viewport(): { width: number; height: number };
  bubble: BubbleEnv;
  mascot: (ctx: Pick<AppContext, 'store' | 'now'>, opts: MascotOptions) => MascotHandle;
}

export function defaultStageEnv(): StageEnv {
  const w = typeof window !== 'undefined' ? window : null;
  return {
    doc: document,
    raf: (cb) =>
      w?.requestAnimationFrame
        ? w.requestAnimationFrame(() => cb(performance.now()))
        : (setTimeout(() => cb(performance.now()), 16) as unknown as number),
    caf: (id) => (w?.cancelAnimationFrame ? w.cancelAnimationFrame(id) : clearTimeout(id)),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    viewport: () => ({ width: w?.innerWidth ?? 1280, height: w?.innerHeight ?? 720 }),
    bubble: defaultBubbleEnv(),
    mascot: (ctx, opts) => createMascotWith(ctx, opts, defaultMascotEnv()),
  };
}

export interface MascotStageOptions {
  /** The mascot's size in CSS px (default 72). */
  size?: number;
  interactive?: boolean;
}

export interface MascotStageHandle {
  readonly el: HTMLElement;
  readonly mascot: MascotHandle;
  readonly bubble: BubbleHandle;
  /** Shows the overlay. */
  show(): void;
  /** Hides it and clears the bubble. */
  hide(): void;
  readonly visible: boolean;
  /** Walks to stand beside `target` (or back to the middle when null). */
  moveTo(target: StageTarget | null): void;
  /** Says something above the mascot (null clears the bubble). */
  say(message: BubbleMessage | null): void;
  /** Every bubble action click, until the next `say`. */
  onAction(listener: (action: BubbleAction) => void): () => void;
  /** True while the mascot is travelling or the bubble is typing. */
  readonly busy: boolean;
  destroy(): void;
}

const DEFAULT_SIZE = 72;
/** Stand-off from the target's edge, in design-ish CSS px. */
const STAND_OFF = 14;
/** Where the mascot's feet sit relative to the target's bottom. */
const FEET_DROP = 26;
/** Travel slower than the highlight, so the walk reads as walking. */
const TRAVEL_SPRING = { stiffness: 120, damping: 15 };

export function createMascotStage(
  ctx: Pick<AppContext, 'store' | 'now'>,
  opts: MascotStageOptions = {},
): MascotStageHandle {
  return createMascotStageWith(ctx, opts, defaultStageEnv());
}

export function createMascotStageWith(
  ctx: Pick<AppContext, 'store' | 'now'>,
  opts: MascotStageOptions,
  env: StageEnv,
): MascotStageHandle {
  const size = Math.max(32, Math.min(160, Math.round(opts.size ?? DEFAULT_SIZE)));
  const doc = env.doc;

  const el = doc.createElement('div');
  el.className = 'ms-stage';
  el.hidden = true;
  const mascotHost = h('div', { class: 'ms-stage-mascot' });
  el.append(mascotHost);

  const mascot = env.mascot(ctx, { size, interactive: opts.interactive === true });
  mascotHost.append(mascot.el);
  const bubble = createBubble(env.bubble);
  el.append(bubble.el);

  const sx = new Spring(0, TRAVEL_SPRING);
  const sy = new Spring(0, TRAVEL_SPRING);
  let tx = 0;
  let ty = 0;
  let facing = 1;
  let raf: number | null = null;
  let last: number | null = null;
  let visible = false;
  let destroyed = false;

  function place(): { x: number; y: number } {
    return { x: sx.x, y: sy.x };
  }

  function viewport(): { width: number; height: number } {
    return env.viewport();
  }

  /** The bubble's on-screen rectangle this frame, for keeping it inside the window. */
  function layoutBubble(): void {
    if (!bubble.visible) return;
    const vp = viewport();
    const bw = bubble.el.offsetWidth;
    const bh = bubble.el.offsetHeight;
    if (bw <= 0) return;
    // Centre the bubble above the mascot, clamped to the window.
    const p = place();
    let left = size / 2 - bw / 2;
    const screenX = p.x + left;
    if (screenX < 8) left += 8 - screenX;
    if (screenX + bw > vp.width - 8) left -= screenX + bw - (vp.width - 8);
    let top = -bh - 12;
    if (p.y + top < 8) top = size + 12;
    bubble.el.style.left = `${Math.round(left)}px`;
    bubble.el.style.top = `${Math.round(top)}px`;
  }

  function standPointFor(target: StageTarget | null): { x: number; y: number; face: number } {
    const vp = viewport();
    if (!target) return { x: vp.width / 2 - size / 2, y: vp.height / 2 - size / 2, face: 1 };
    // Stand to the left of the target, facing right; fall back to the right side.
    const left = target.x - size - STAND_OFF;
    const x = left >= 8 ? left : Math.min(vp.width - size - 8, target.x + target.width + STAND_OFF);
    const face = x < target.x ? 1 : -1;
    const y = Math.max(8, target.y + target.height - size + FEET_DROP);
    return { x, y: Math.min(y, vp.height - size - 8), face };
  }

  function frame(now: number): void {
    raf = null;
    if (destroyed || !visible) return;
    const dt = last === null ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    if (dt > 0) {
      sx.step(dt);
      sy.step(dt);
    }
    const p = place();
    const remaining = Math.hypot(tx - p.x, ty - p.y);
    // Walk while travelling: a hop whose height falls off as Friday arrives.
    const hopT = Math.min(1, remaining / 90);
    const hop = hopT > 0.02 ? Math.abs(Math.sin((now / 1000) * 9)) * 10 * hopT : 0;
    el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y - hop)}px, 0)`;
    if (facing !== 0) mascot.el.style.transform = facing < 0 ? 'scaleX(-1)' : '';
    layoutBubble();
    const settled = sx.settled && sy.settled && hopT <= 0.02 && !bubble.typing;
    if (settled) {
      last = null;
      return;
    }
    raf = env.raf(frame);
  }

  function wake(): void {
    if (destroyed || !visible || raf !== null) return;
    last = null;
    raf = env.raf(frame);
  }

  function setTarget(target: StageTarget | null): void {
    const spot = standPointFor(target);
    const prevX = tx;
    tx = spot.x;
    ty = spot.y;
    if (Math.abs(spot.x - prevX) > 2) facing = spot.face;
    sx.target = spot.x;
    sy.target = spot.y;
    if (mascot.engine.reduced) {
      // Reduced motion: no walk, no hop — Friday is simply there.
      sx.snap();
      sy.snap();
      el.style.transform = `translate3d(${Math.round(tx)}px, ${Math.round(ty)}px, 0)`;
      layoutBubble();
      return;
    }
    wake();
  }

  return {
    el,
    mascot,
    bubble,
    get visible() {
      return visible;
    },
    get busy() {
      return !sx.settled || !sy.settled || bubble.typing;
    },
    show(): void {
      if (destroyed || visible) return;
      visible = true;
      el.hidden = false;
      const vp = viewport();
      sx.x = vp.width / 2 - size / 2;
      sy.x = vp.height / 2 - size / 2;
      sx.target = sx.x;
      sy.target = sy.x;
      tx = sx.x;
      ty = sy.x;
      facing = 1;
      el.style.transform = `translate3d(${Math.round(sx.x)}px, ${Math.round(sy.x)}px, 0)`;
      wake();
    },
    hide(): void {
      visible = false;
      el.hidden = true;
      bubble.clear();
      if (raf !== null) env.caf(raf);
      raf = null;
    },
    moveTo(target: StageTarget | null): void {
      if (destroyed) return;
      if (!visible) this.show();
      setTarget(target);
    },
    say(message: BubbleMessage | null): void {
      if (destroyed) return;
      if (message === null) {
        bubble.clear();
        wake();
        return;
      }
      bubble.show(message);
      wake();
    },
    onAction(listener: (action: BubbleAction) => void): () => void {
      return bubble.onAction(listener);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (raf !== null) env.caf(raf);
      raf = null;
      bubble.destroy();
      mascot.destroy();
      mascotHost.remove();
      el.remove();
    },
  };
}
