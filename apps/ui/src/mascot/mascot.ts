/**
 * The mascot component (plan §7.9): a canvas of `size × size` CSS pixels with Blip on it. The frame
 * loop runs on demand: a frame is requested when something changes (state, reaction, pointer) and
 * frames continue only while something moves; between blinks a timer wakes it. It stops while the
 * canvas is off screen or the document is hidden, and on `destroy`.
 */
import { visible } from '../model/text.js';
import type { AppContext, Component } from '../shell/context.js';
import { truncate } from '../ui/format.js';
import { type Ctx2D, drawBlip, MASCOT_NAME, readPalette } from './character.js';
import { MascotController } from './controller.js';
import { MascotEngine, type Random } from './engine.js';
import { isOutfit } from './outfits.js';
import { describe, firstPendingApproval, type MascotState } from './states.js';

export interface MascotOptions {
  /** Width and height in CSS pixels. */
  size: number;
  /** Clicking (or Enter / Space) makes Blip wink and blush. */
  interactive?: boolean;
}

/** What the component needs from the page (a fake in tests). */
export interface MascotEnv {
  doc: Document;
  raf(cb: () => void): number;
  caf(id: number): void;
  /** Milliseconds of a monotonic clock. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  devicePixelRatio(): number;
  context(canvas: HTMLCanvasElement): Ctx2D | null;
  matchMedia: ((query: string) => MediaQueryList | null) | null;
  IntersectionObserver: typeof IntersectionObserver | null;
  random?: Random;
}

export function defaultMascotEnv(): MascotEnv {
  const w = typeof window !== 'undefined' ? window : null;
  return {
    doc: document,
    raf: (cb) =>
      w?.requestAnimationFrame ? w.requestAnimationFrame(() => cb()) : (setTimeout(cb, 16) as unknown as number),
    caf: (id) => (w?.cancelAnimationFrame ? w.cancelAnimationFrame(id) : clearTimeout(id)),
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    devicePixelRatio: () => (w && Number.isFinite(w.devicePixelRatio) ? w.devicePixelRatio : 1),
    context: (canvas) => {
      try {
        return canvas.getContext('2d') as Ctx2D | null;
      } catch {
        return null;
      }
    },
    matchMedia: w && typeof w.matchMedia === 'function' ? (q) => w.matchMedia(q) : null,
    IntersectionObserver: typeof IntersectionObserver === 'function' ? IntersectionObserver : null,
  };
}

// ---------------------------------------------------------------------------------------------
// The pointer, shared by every mascot on the page

type Cursor = { x: number; y: number } | null;

let cursor: Cursor = null;
const watchers = new Set<() => void>();
let listeningOn: Document | null = null;

function notify(): void {
  for (const w of [...watchers]) w();
}

function onPointerMove(e: PointerEvent): void {
  cursor = { x: e.clientX, y: e.clientY };
  notify();
}

function onPointerOut(e: PointerEvent): void {
  // Leaving the window (no element to go to): the eyes come back to the middle.
  if (e.relatedTarget) return;
  cursor = null;
  notify();
}

function watchPointer(doc: Document, fn: () => void): () => void {
  watchers.add(fn);
  if (!listeningOn) {
    listeningOn = doc;
    doc.addEventListener('pointermove', onPointerMove, { passive: true });
    doc.addEventListener('pointerout', onPointerOut, { passive: true });
  }
  return () => {
    watchers.delete(fn);
    if (watchers.size === 0 && listeningOn) {
      listeningOn.removeEventListener('pointermove', onPointerMove);
      listeningOn.removeEventListener('pointerout', onPointerOut);
      listeningOn = null;
    }
  };
}

/**
 * The cursor anywhere on screen, in this window's CSS pixels (the desktop shell sends it, plan
 * §7.8); null when it is unknown. Every mascot's eyes follow it.
 */
export function setCursor(x: number | null, y?: number): void {
  cursor = x === null || y === undefined || !Number.isFinite(x) || !Number.isFinite(y) ? null : { x, y };
  notify();
}

// ---------------------------------------------------------------------------------------------

export interface MascotHandle extends Component {
  readonly el: HTMLCanvasElement;
  readonly engine: MascotEngine;
  /** The state Blip shows. */
  readonly state: MascotState;
  /** True while a frame or a wake-up timer is pending. */
  readonly running: boolean;
}

const MIN_SIZE = 8;
const MAX_SIZE = 512;

export function createMascot(ctx: AppContext, opts: MascotOptions): MascotHandle {
  return createMascotWith(ctx, opts, defaultMascotEnv());
}

export function createMascotWith(
  ctx: Pick<AppContext, 'store' | 'now'>,
  opts: MascotOptions,
  env: MascotEnv,
): MascotHandle {
  const size = Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, Number.isFinite(opts.size) ? opts.size : 24)));
  const interactive = Boolean(opts.interactive);
  const canvas = env.doc.createElement('canvas');
  canvas.className = interactive ? 'ms-canvas ms-interactive' : 'ms-canvas';
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.dataset.mascot = MASCOT_NAME.toLowerCase();
  if (interactive) {
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'button');
  } else {
    canvas.setAttribute('role', 'img');
  }

  const palette = readPalette(env.doc.documentElement);
  const engine = new MascotEngine({
    ...(env.random ? { random: env.random } : {}),
    colors: {
      confetti: [palette.emerald, palette.cyan, palette.amber, palette.violet, palette.neonBlue],
      spark: palette.emerald,
      sweat: palette.neonBlue,
      z: palette.slate400,
      heart: palette.blush,
    },
  });

  let g: Ctx2D | null = env.context(canvas);
  let ratio = 0;
  let raf: number | null = null;
  let timer: unknown = null;
  let lastFrame: number | null = null;
  let onScreen = true;
  let destroyed = false;

  const pageVisible = () => !env.doc.hidden;
  const live = () => !destroyed && onScreen && pageVisible();

  function resize(): void {
    const dpr = env.devicePixelRatio();
    const next = Math.min(2, dpr > 0 && Number.isFinite(dpr) ? dpr : 1);
    if (next === ratio) return;
    ratio = next;
    canvas.width = Math.max(1, Math.round(size * ratio));
    canvas.height = Math.max(1, Math.round(size * ratio));
  }

  function aim(): void {
    if (!cursor) {
      engine.setPointer(null);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    engine.setPointer({ dx: cursor.x - (rect.left + rect.width / 2), dy: cursor.y - (rect.top + rect.height / 2) });
  }

  function draw(): void {
    resize();
    if (!g) g = env.context(canvas);
    if (!g) return;
    const outfit = ctx.store.select('prefs').outfit;
    drawBlip(g, engine.pose(), { size, dpr: ratio, outfit: isOutfit(outfit) ? outfit : 'none', palette });
  }

  function clearTimer(): void {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
  }

  function stop(): void {
    if (raf !== null) env.caf(raf);
    raf = null;
    clearTimer();
  }

  function frame(): void {
    raf = null;
    if (!live()) return;
    const now = env.now();
    aim();
    engine.tick(lastFrame === null ? 0 : (now - lastFrame) / 1000);
    lastFrame = now;
    draw();
    if (engine.busy) raf = env.raf(frame);
    else rest();
  }

  /** Holds still; a timer wakes Blip for the next blink. */
  function rest(): void {
    clearTimer();
    const wait = engine.nextWakeIn();
    if (wait === null) return;
    timer = env.setTimeout(
      () => {
        timer = null;
        wake();
      },
      Math.max(16, wait * 1000),
    );
  }

  function wake(): void {
    if (!live() || raf !== null) return;
    clearTimer();
    const now = env.now();
    if (lastFrame !== null) engine.resume((now - lastFrame) / 1000);
    lastFrame = now;
    raf = env.raf(frame);
  }

  let label = '';
  function relabel(): void {
    const state = controller.state;
    let text = `${MASCOT_NAME}: ${describe(state, ctx.store.getState())}`;
    if (state === 'approval') {
      const first = firstPendingApproval(ctx.store.select('board'), ctx.now());
      if (first) text += ` (${visible(truncate(first.capability, 80))})`;
    }
    if (interactive) text += '. Press to say hello';
    if (text !== label) {
      label = text;
      canvas.setAttribute('aria-label', text);
      canvas.title = text;
    }
  }

  const controller = new MascotController(
    ctx,
    engine,
    palette,
    () => {
      if (destroyed) return;
      relabel();
      wake();
    },
    {
      setTimeout: env.setTimeout,
      clearTimeout: env.clearTimeout,
      matchMedia: env.matchMedia,
    },
  );

  const unwatch = watchPointer(env.doc, () => wake());

  const onVisibility = () => {
    if (pageVisible()) wake();
    else stop();
  };
  env.doc.addEventListener('visibilitychange', onVisibility);

  let observer: IntersectionObserver | null = null;
  if (env.IntersectionObserver) {
    try {
      observer = new env.IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        onScreen = entry.isIntersecting;
        if (onScreen) wake();
        else stop();
      });
      observer.observe(canvas);
    } catch {
      observer = null;
    }
  }

  const onClick = () => controller.click();
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    controller.click();
  };
  if (interactive) {
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('keydown', onKey);
  }

  resize();
  engine.stimulate();
  controller.start();
  relabel();
  // The first picture appears at once, even before a frame runs.
  draw();
  wake();

  return {
    el: canvas,
    engine,
    get state() {
      return controller.state;
    },
    get running() {
      return raf !== null || timer !== null;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      controller.destroy();
      unwatch();
      env.doc.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
      observer = null;
      if (interactive) {
        canvas.removeEventListener('click', onClick);
        canvas.removeEventListener('keydown', onKey);
      }
      canvas.remove();
    },
  };
}
