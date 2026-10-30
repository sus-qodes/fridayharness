/**
 * The spotlight (plan §7.10 onboarding): a dim overlay with one hole and a ring around whatever
 * the tour highlights. Clicks outside the hole are blocked; the hole itself is click-through so
 * the user can actually use the highlighted control. Pure DOM; the caller measures the target.
 */

import type { StageTarget } from '../mascot/stage.js';
import { h } from '../ui/dom.js';

export interface SpotlightEnv {
  doc: Document;
  viewport(): { width: number; height: number };
}

export function defaultSpotlightEnv(): SpotlightEnv {
  const w = typeof window !== 'undefined' ? window : null;
  return {
    doc: document,
    viewport: () => ({ width: w?.innerWidth ?? 1280, height: w?.innerHeight ?? 720 }),
  };
}

export interface SpotlightHandle {
  readonly el: HTMLElement;
  /** Highlights `target`; null dims everything with no hole. */
  highlight(target: StageTarget | null): void;
  /** Hides the overlay. */
  clear(): void;
  readonly visible: boolean;
  destroy(): void;
}

/** How far the ring sits outside the target's rect. */
export const RING_PAD = 7;
/** The dim over the page outside the hole. */
export const SHADE = 'rgba(4, 5, 7, 0.62)';

export function createSpotlight(env: SpotlightEnv = defaultSpotlightEnv()): SpotlightHandle {
  const doc = env.doc;
  const el = doc.createElement('div');
  el.className = 'tour-spotlight';
  el.hidden = true;
  const shades: HTMLElement[] = [];
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const s = h('div', { class: `tour-shade tour-shade-${side}` });
    el.append(s);
    shades.push(s);
  }
  const ring = h('div', { class: 'tour-ring' });
  el.append(ring);
  const top = shades[0] as HTMLElement;
  const bottom = shades[1] as HTMLElement;
  const left = shades[2] as HTMLElement;
  const right = shades[3] as HTMLElement;

  let visible = false;

  function coverAll(): void {
    const vp = env.viewport();
    for (const s of shades) {
      s.style.top = '0px';
      s.style.left = '0px';
      s.style.width = `${vp.width}px`;
      s.style.height = `${vp.height}px`;
    }
    ring.style.display = 'none';
  }

  function hole(target: StageTarget): void {
    const vp = env.viewport();
    const t = Math.max(0, target.y - RING_PAD);
    const b = Math.min(vp.height, target.y + target.height + RING_PAD);
    const l = Math.max(0, target.x - RING_PAD);
    const r = Math.min(vp.width, target.x + target.width + RING_PAD);
    top.style.top = '0px';
    top.style.left = '0px';
    top.style.width = `${vp.width}px`;
    top.style.height = `${t}px`;
    bottom.style.top = `${b}px`;
    bottom.style.left = '0px';
    bottom.style.width = `${vp.width}px`;
    bottom.style.height = `${Math.max(0, vp.height - b)}px`;
    left.style.top = `${t}px`;
    left.style.left = '0px';
    left.style.width = `${l}px`;
    left.style.height = `${b - t}px`;
    right.style.top = `${t}px`;
    right.style.left = `${r}px`;
    right.style.width = `${Math.max(0, vp.width - r)}px`;
    right.style.height = `${b - t}px`;
    ring.style.display = '';
    ring.style.top = `${t}px`;
    ring.style.left = `${l}px`;
    ring.style.width = `${r - l}px`;
    ring.style.height = `${b - t}px`;
  }

  return {
    el,
    get visible() {
      return visible;
    },
    highlight(target: StageTarget | null): void {
      visible = true;
      el.hidden = false;
      if (target === null) coverAll();
      else hole(target);
    },
    clear(): void {
      visible = false;
      el.hidden = true;
    },
    destroy(): void {
      visible = false;
      el.remove();
    },
  };
}
