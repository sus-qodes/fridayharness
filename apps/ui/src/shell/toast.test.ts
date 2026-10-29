import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createToastHost,
  defaultTimeout,
  TOAST_DEFAULT_MS,
  TOAST_ERROR_MS,
  TOAST_MAX,
  TOAST_RESUME_MS,
  type ToastHost,
} from './toast.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

let host: ToastHost;

beforeEach(() => {
  vi.useFakeTimers();
  host = createToastHost();
  document.body.append(host.el);
});

afterEach(() => {
  host.destroy();
  vi.useRealTimers();
});

describe('toasts (plan §7.1)', () => {
  it('is a polite live region at the bottom right', () => {
    expect(host.el.getAttribute('aria-live')).toBe('polite');
    expect(host.el.classList.contains('sh-toasts')).toBe(true);
  });

  it('dismisses itself: 5 s by default, 8 s for errors, never with 0', () => {
    host.show({ kind: 'success', text: 'Saved' });
    host.show({ kind: 'error', text: 'Approve', detail: 'COS-2002: no' });
    host.show({ kind: 'info', text: 'Sticky', timeoutMs: 0 });
    expect(host.count()).toBe(3);
    vi.advanceTimersByTime(TOAST_DEFAULT_MS);
    expect(host.count()).toBe(2);
    vi.advanceTimersByTime(TOAST_ERROR_MS - TOAST_DEFAULT_MS);
    expect(host.count()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(host.count()).toBe(1);
  });

  it('announces errors as alerts and shows the code and message', () => {
    host.show({ kind: 'error', text: 'Approve', detail: 'COS-2002: approval is already granted' });
    const t = host.el.querySelector('.sh-toast-error');
    expect(t?.getAttribute('role')).toBe('alert');
    expect(t?.querySelector('.sh-toast-detail')?.textContent).toBe('COS-2002: approval is already granted');
  });

  it('stacks at most five, the oldest leaving first', () => {
    for (let i = 0; i < TOAST_MAX + 3; i++) host.show({ kind: 'info', text: `m${i}` });
    expect(host.count()).toBe(TOAST_MAX);
    expect(host.el.querySelector('.sh-toast-text')?.textContent).toBe('m3');
  });

  it('a newer toast with the same key replaces the older one; others stay', () => {
    host.show({ kind: 'success', text: 'Friday is paused', key: 'control' });
    host.show({ kind: 'success', text: 'Allowed once' });
    host.show({ kind: 'success', text: 'Friday runs again', key: 'control' });
    const texts = [...host.el.querySelectorAll('.sh-toast-text')].map((x) => x.textContent);
    expect(texts).toEqual(['Allowed once', 'Friday runs again']);
  });

  it('closes from its button', () => {
    host.show({ kind: 'warn', text: 'Careful', timeoutMs: 0 });
    const close = host.el.querySelector<HTMLButtonElement>('.sh-toast-close');
    expect(close?.getAttribute('aria-label')).toBe('Dismiss this message');
    expect(close?.type).toBe('button');
    close?.click();
    expect(host.count()).toBe(0);
  });

  it('stays while the pointer is on it and leaves a moment after', () => {
    host.show({ kind: 'info', text: 'Read me' });
    const t = host.el.querySelector('.sh-toast') as HTMLElement;
    t.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(TOAST_DEFAULT_MS * 3);
    expect(host.count()).toBe(1);
    t.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(TOAST_RESUME_MS - 1);
    expect(host.count()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(host.count()).toBe(0);
  });

  it('shows hostile text as text, cleaned and bounded', () => {
    host.show({ kind: 'error', text: `${HOSTILE}‮​${'x'.repeat(5000)}`, detail: `${HOSTILE}${'y'.repeat(5000)}` });
    expect(host.el.querySelector('img')).toBeNull();
    const text = host.el.querySelector('.sh-toast-text')?.textContent ?? '';
    expect(text.startsWith(HOSTILE)).toBe(true);
    expect(text).not.toContain('‮');
    expect(Array.from(text).length).toBeLessThanOrEqual(300);
    expect(Array.from(host.el.querySelector('.sh-toast-detail')?.textContent ?? '').length).toBeLessThanOrEqual(600);
  });

  it('reads odd timeouts sensibly and clears everything', () => {
    expect(defaultTimeout({ kind: 'info', text: '', timeoutMs: -5 })).toBe(TOAST_DEFAULT_MS);
    expect(defaultTimeout({ kind: 'info', text: '', timeoutMs: Number.NaN })).toBe(TOAST_DEFAULT_MS);
    expect(defaultTimeout({ kind: 'error', text: '' })).toBe(TOAST_ERROR_MS);
    host.show({ kind: 'info', text: 'a', timeoutMs: 0 });
    host.show({ kind: 'info', text: 'b' });
    host.clear();
    expect(host.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
