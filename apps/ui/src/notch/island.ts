/**
 * The island element (plan §7.8, handoff Part 01 §2 and §4): a surface whose width, height and
 * corner radius follow three springs, written as CSS custom properties (`--nt-w`, `--nt-h`,
 * `--nt-r`). One animation frame loop runs only while a spring moves; reduced motion jumps
 * straight to the target. The visible rectangle is reported whenever it changes, so the desktop
 * shell can let clicks outside it through to the editor underneath (FD-17).
 */
import { h, setVar } from '../ui/dom.js';
import type { IslandState } from './island-fsm.js';
import { type Geometry, GeometrySprings } from './spring.js';

/** Part 01 §3.1 sizes. The expanded height follows its content. */
export const SIZES = {
  hidden: { width: 120, height: 4, radius: 2 },
  compact: { width: 200, height: 32, radius: 16 },
  greeting: { width: 320, height: 96, radius: 24 },
  expanded: { width: 400, radius: 24 },
} as const;

export const EXPANDED_MIN_HEIGHT = 120;
/** The island's bottom border (its top edge has none): added to the card's content height. */
export const ISLAND_BORDER = 1;
/**
 * The notch window is 460×300 logical pixels (ERRATA F32): a 272 px card, its spring overshoot
 * (about 4 %) and the shell's 14 px hit margin stay inside it. In a browser page the island has no
 * card (review §4): the pill, the strip and the greeting are its only sizes there.
 */
export const WINDOW_MAX_HEIGHT = 272;

export interface IslandRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The target geometry of a state; `contentHeight` is the expanded card's natural height. */
export function stateGeometry(state: IslandState, contentHeight: number, maxHeight: number): Geometry {
  switch (state) {
    case 'hidden':
      return { ...SIZES.hidden };
    case 'compact':
      return { ...SIZES.compact };
    case 'greeting':
      return { ...SIZES.greeting };
    case 'expanded': {
      const max = Number.isFinite(maxHeight) && maxHeight > EXPANDED_MIN_HEIGHT ? maxHeight : EXPANDED_MIN_HEIGHT;
      const natural = Number.isFinite(contentHeight) ? Math.ceil(contentHeight) : 0;
      return {
        width: SIZES.expanded.width,
        height: Math.min(max, Math.max(EXPANDED_MIN_HEIGHT, natural)),
        radius: SIZES.expanded.radius,
      };
    }
  }
}

/** The island's rectangle in its container, rounded outwards to whole pixels. */
export function islandRect(g: Geometry, containerWidth: number): IslandRect {
  const width = Math.max(0, g.width);
  const left = (containerWidth - width) / 2;
  const x = Math.floor(left);
  const right = Math.ceil(left + width);
  return { x, y: 0, width: right - x, height: Math.ceil(Math.max(0, g.height)) };
}

export interface AnimationEnv {
  raf(cb: (t: number) => void): number;
  caf(handle: number): void;
  /** True when the motion preference (or the system) asks for no motion. */
  reducedMotion(): boolean;
  /** The container's width in CSS pixels (to report the rectangle). */
  containerWidth(): number;
}

export interface IslandOptions {
  mode: 'in-page' | 'window';
  env: AnimationEnv;
  initial?: Geometry;
  onRect?: (r: IslandRect) => void;
}

function px(v: number): string {
  return `${Math.round(v * 100) / 100}px`;
}

export class Island {
  readonly el: HTMLDivElement;
  readonly #springs: GeometrySprings;
  readonly #env: AnimationEnv;
  readonly #onRect: ((r: IslandRect) => void) | undefined;
  #frame: number | null = null;
  #lastT: number | null = null;
  #rectKey = '';
  #destroyed = false;
  /** Frames drawn (for tests: the loop stops when nothing moves). */
  frames = 0;

  constructor(opts: IslandOptions) {
    this.#env = opts.env;
    this.#onRect = opts.onRect;
    const initial = opts.initial ?? { ...SIZES.compact };
    this.#springs = new GeometrySprings(initial);
    this.el = h('div', {
      class: ['nt-island', opts.mode === 'window' ? 'nt-island-window' : 'nt-island-page'],
      dataset: { mode: opts.mode },
    });
    this.#apply();
  }

  get geometry(): Geometry {
    return this.#springs.value;
  }

  get target(): Geometry {
    return this.#springs.target;
  }

  /** True while the frame loop runs. */
  get animating(): boolean {
    return this.#frame !== null;
  }

  setTarget(g: Geometry): void {
    if (this.#destroyed) return;
    const instant = this.#env.reducedMotion();
    this.#springs.setTarget(g, instant);
    if (instant || !this.#springs.moving) {
      this.#stop();
      this.#apply();
      return;
    }
    this.#start();
  }

  /** Reports the rectangle again (the container was resized); `force` reports even when unchanged. */
  reportRect(force = false): void {
    if (!this.#onRect || this.#destroyed) return;
    const r = islandRect(this.#springs.value, this.#env.containerWidth());
    const key = `${r.x},${r.y},${r.width},${r.height}`;
    if (!force && key === this.#rectKey) return;
    this.#rectKey = key;
    this.#onRect(r);
  }

  destroy(): void {
    this.#stop();
    this.#destroyed = true;
    this.el.remove();
  }

  #start(): void {
    if (this.#frame !== null) return;
    this.#lastT = null;
    this.#frame = this.#env.raf(this.#tick);
  }

  #stop(): void {
    if (this.#frame !== null) this.#env.caf(this.#frame);
    this.#frame = null;
    this.#lastT = null;
  }

  readonly #tick = (t: number): void => {
    this.#frame = null;
    if (this.#destroyed) return;
    const dt = this.#lastT === null || !Number.isFinite(t) ? 1 / 60 : (t - this.#lastT) / 1000;
    this.#lastT = Number.isFinite(t) ? t : null;
    const moving = this.#springs.step(dt);
    this.frames += 1;
    this.#apply();
    if (moving) this.#frame = this.#env.raf(this.#tick);
    else this.#lastT = null;
  };

  #apply(): void {
    const g = this.#springs.value;
    setVar(this.el, '--nt-w', px(g.width));
    setVar(this.el, '--nt-h', px(g.height));
    setVar(this.el, '--nt-r', px(g.radius));
    this.reportRect();
  }
}
