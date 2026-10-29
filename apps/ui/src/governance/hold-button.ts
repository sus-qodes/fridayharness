/**
 * Hold to authorize (plan FD-15, handoff Part 06 §4.2): a high-risk or whole-task grant needs the
 * button held for 1.2 s, with a ring that fills; releasing early resets it. `Space` held while the
 * button has focus is the keyboard form. A click or `Enter` does nothing, so neither a misclick
 * nor a stray key grants anything.
 */
import type { Component } from '../shell/context.js';
import { h } from '../ui/dom.js';
import { s } from '../ui/svg.js';
import type { Clock } from './arming.js';
import { systemClock } from './arming.js';

export const HOLD_MS = 1200;

const RING_R = 9;
const RING_LENGTH = 2 * Math.PI * RING_R;

export interface HoldButtonOptions {
  label: string;
  /** Shown while holding. */
  holdingLabel?: string;
  onComplete: () => void;
  /** Whether a hold may start now (the card's arming). */
  canStart?: () => boolean;
  clock?: Clock;
  /** Frames for the ring; without them (reduced motion) the ring jumps to "holding". */
  frames?: { request(fn: (t: number) => void): unknown; cancel(handle: unknown): void } | null;
  durationMs?: number;
  /** Extra classes, e.g. `btn-danger`. */
  className?: string;
}

export interface HoldButton extends Component {
  readonly el: HTMLButtonElement;
  /** 0 to 1. */
  progress(): number;
  holding(): boolean;
  reset(): void;
}

function defaultFrames(): HoldButtonOptions['frames'] {
  if (typeof requestAnimationFrame !== 'function') return null;
  return { request: (fn) => requestAnimationFrame(fn), cancel: (h) => cancelAnimationFrame(h as number) };
}

export function holdButton(opts: HoldButtonOptions): HoldButton {
  const clock = opts.clock ?? systemClock;
  const total = opts.durationMs ?? HOLD_MS;
  const frames = opts.frames === undefined ? defaultFrames() : opts.frames;
  let startedAt: number | null = null;
  let done = false;
  let timer: unknown = null;
  let frame: unknown = null;
  let stepTimer: unknown = null;
  let via: 'pointer' | 'key' | null = null;

  const bar = s('circle', {
    cx: 12,
    cy: 12,
    r: RING_R,
    class: 'gv-hold-ring-bar',
    'stroke-dasharray': RING_LENGTH.toFixed(2),
    'stroke-dashoffset': RING_LENGTH.toFixed(2),
  });
  const ring = s(
    'svg',
    { viewBox: '0 0 24 24', width: 20, height: 20, class: 'gv-hold-ring', 'aria-hidden': 'true' },
    s('circle', { cx: 12, cy: 12, r: RING_R, class: 'gv-hold-ring-track' }),
    bar,
  );
  const text = h('span', { class: 'gv-hold-label' }, opts.label);
  const status = h('span', { class: 'visually-hidden', aria: { live: 'polite' } });
  const el = h(
    'button',
    {
      type: 'button',
      class: ['btn', 'gv-hold', opts.className],
      title: 'Hold to authorize (or hold Space)',
    },
    ring,
    text,
    status,
  );
  el.setAttribute('aria-roledescription', 'hold button');

  const draw = (p: number): void => {
    bar.setAttribute('stroke-dashoffset', (RING_LENGTH * (1 - p)).toFixed(2));
    el.style.setProperty('--gv-hold', p.toFixed(3));
  };

  const progress = (): number => {
    if (done) return 1;
    if (startedAt === null) return 0;
    return Math.min(1, (clock.now() - startedAt) / total);
  };

  const tick = (): void => {
    frame = null;
    if (startedAt === null || done) return;
    draw(progress());
    if (frames) frame = frames.request(tick);
  };

  const stopTimers = (): void => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (frame !== null && frames) frames.cancel(frame);
    frame = null;
    if (stepTimer !== null) clock.clearTimeout(stepTimer);
    stepTimer = null;
  };

  const reset = (): void => {
    stopTimers();
    startedAt = null;
    via = null;
    done = false;
    el.classList.remove('gv-holding', 'gv-held');
    text.textContent = opts.label;
    draw(0);
  };

  const complete = (): void => {
    timer = null;
    if (startedAt === null || done) return;
    stopTimers();
    done = true;
    startedAt = null;
    via = null;
    el.classList.remove('gv-holding');
    el.classList.add('gv-held');
    draw(1);
    status.textContent = 'Authorized';
    opts.onComplete();
  };

  const start = (how: 'pointer' | 'key'): void => {
    if (done || startedAt !== null) return;
    if (opts.canStart && !opts.canStart()) return;
    startedAt = clock.now();
    via = how;
    el.classList.add('gv-holding');
    text.textContent = opts.holdingLabel ?? 'Keep holding…';
    status.textContent = 'Holding';
    timer = clock.setTimeout(complete, total);
    if (frames) frame = frames.request(tick);
    else step();
  };

  /** Reduced motion: the ring fills in four still steps instead of moving. */
  const step = (): void => {
    stepTimer = null;
    if (startedAt === null || done) return;
    draw(Math.floor(progress() * 4) / 4);
    stepTimer = clock.setTimeout(step, total / 4);
  };

  const release = (how: 'pointer' | 'key'): void => {
    if (startedAt === null || done || via !== how) return;
    status.textContent = 'Released before it was authorized';
    reset();
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    el.focus();
    start('pointer');
  };
  const onPointerUp = (): void => release('pointer');
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (!e.repeat) start('key');
    } else if (e.key === 'Enter') {
      // Enter never authorizes.
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      release('key');
    }
  };
  const onBlur = (): void => {
    if (startedAt !== null && !done) reset();
  };
  const onClick = (e: MouseEvent): void => {
    // The hold is the gesture; a click alone does nothing.
    e.preventDefault();
  };

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointerleave', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
  el.addEventListener('keydown', onKeyDown);
  el.addEventListener('keyup', onKeyUp);
  el.addEventListener('blur', onBlur);
  el.addEventListener('click', onClick);
  draw(0);

  return {
    el,
    progress,
    holding: () => startedAt !== null && !done,
    reset,
    destroy(): void {
      stopTimers();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointerleave', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('keyup', onKeyUp);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('click', onClick);
      el.remove();
    },
  };
}
