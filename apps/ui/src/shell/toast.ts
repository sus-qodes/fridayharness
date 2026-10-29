/**
 * Toasts (plan §7.1): short messages for command results and errors, stacked at the bottom right,
 * never blocking. They dismiss themselves (5 s by default, errors 8 s, `timeoutMs: 0` keeps one
 * until dismissed), pause while the pointer or focus is on them, and are announced politely.
 */
import { button, h } from '../ui/dom.js';
import { cleanText, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import type { Component, Toast, ToastKind } from './context.js';

export const TOAST_DEFAULT_MS = 5000;
export const TOAST_ERROR_MS = 8000;
/** After the pointer leaves, a paused toast stays at least this long. */
export const TOAST_RESUME_MS = 2000;
/** The most toasts shown at once; older ones leave first. */
export const TOAST_MAX = 5;
const TEXT_MAX = 300;
const DETAIL_MAX = 600;

export interface ToastHost extends Component {
  show(t: Toast): void;
  /** Removes every toast. */
  clear(): void;
  /** The toasts shown now, oldest first (tests). */
  count(): number;
}

interface Shown {
  el: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  ms: number;
  key?: string;
}

const ICON: Record<ToastKind, 'check' | 'bell' | 'cross' | 'question'> = {
  info: 'bell',
  success: 'check',
  warn: 'question',
  error: 'cross',
};

export function defaultTimeout(t: Toast): number {
  if (t.timeoutMs !== undefined && Number.isFinite(t.timeoutMs) && t.timeoutMs >= 0) return t.timeoutMs;
  return t.kind === 'error' ? TOAST_ERROR_MS : TOAST_DEFAULT_MS;
}

export function createToastHost(): ToastHost {
  const el = h('div', {
    class: 'sh-toasts',
    role: 'status',
    aria: { live: 'polite', relevant: 'additions', label: 'Messages' },
  });
  const shown: Shown[] = [];

  function remove(s: Shown): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const i = shown.indexOf(s);
    if (i >= 0) shown.splice(i, 1);
    s.el.remove();
  }

  function arm(s: Shown, ms: number): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = ms > 0 ? setTimeout(() => remove(s), ms) : null;
  }

  function show(t: Toast): void {
    const ms = defaultTimeout(t);
    const text = truncate(cleanText(String(t.text ?? '')), TEXT_MAX);
    const detail = t.detail ? truncate(cleanText(String(t.detail)), DETAIL_MAX) : '';
    const item = h(
      'div',
      { class: ['sh-toast', `sh-toast-${t.kind}`], role: t.kind === 'error' ? 'alert' : undefined },
      h('span', { class: 'sh-toast-icon' }, icon(ICON[t.kind] ?? 'bell', 15)),
      h(
        'div',
        { class: 'sh-toast-body' },
        h('div', { class: 'sh-toast-text' }, text),
        detail ? h('div', { class: 'sh-toast-detail mono' }, detail) : null,
      ),
    );
    const s: Shown = { el: item, timer: null, ms, ...(t.key ? { key: t.key } : {}) };
    // What it replaces is out of date: Friday cannot be paused and running again at once.
    if (t.key) for (const old of shown.filter((x) => x.key === t.key)) remove(old);
    const close = button(icon('close', 14), () => remove(s), {
      class: 'btn btn-ghost btn-icon sh-toast-close',
      ariaLabel: 'Dismiss this message',
    });
    item.append(close);
    // Reading or reaching for a toast keeps it; it leaves a moment after the pointer and focus do.
    const hold = () => {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
    };
    let pointerInside = false;
    const release = () => {
      if (!shown.includes(s) || s.ms === 0 || pointerInside || item.contains(document.activeElement)) return;
      arm(s, TOAST_RESUME_MS);
    };
    item.addEventListener('pointerenter', () => {
      pointerInside = true;
      hold();
    });
    item.addEventListener('pointerleave', () => {
      pointerInside = false;
      release();
    });
    item.addEventListener('focusin', hold);
    // `relatedTarget` is where focus goes; leaving the toast entirely lets it go.
    item.addEventListener('focusout', (e: FocusEvent) => {
      if (e.relatedTarget instanceof Node && item.contains(e.relatedTarget)) return;
      if (pointerInside || !shown.includes(s) || s.ms === 0) return;
      arm(s, TOAST_RESUME_MS);
    });
    shown.push(s);
    el.append(item);
    while (shown.length > TOAST_MAX) {
      const oldest = shown[0];
      if (oldest) remove(oldest);
    }
    arm(s, ms);
  }

  function clear(): void {
    for (const s of [...shown]) remove(s);
  }

  return {
    el,
    show,
    clear,
    count: () => shown.length,
    destroy() {
      clear();
      el.remove();
    },
  };
}
