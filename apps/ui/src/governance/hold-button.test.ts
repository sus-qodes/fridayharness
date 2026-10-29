import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_MS, holdButton } from './hold-button.js';

function pointer(el: Element, type: string): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 }));
}

function key(el: Element, type: 'keydown' | 'keyup', k: string, repeat = false): KeyboardEvent {
  const e = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, repeat });
  el.dispatchEvent(e);
  return e;
}

describe('hold to authorize (plan FD-15)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  function make(canStart?: () => boolean) {
    const onComplete = vi.fn();
    const b = holdButton({ label: 'Hold to allow', onComplete, frames: null, ...(canStart ? { canStart } : {}) });
    document.body.appendChild(b.el);
    return { b, onComplete };
  }

  it('completes after the button was held for 1.2 s', () => {
    const { b, onComplete } = make();
    expect(b.el.getAttribute('type')).toBe('button');
    pointer(b.el, 'pointerdown');
    expect(b.holding()).toBe(true);
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(onComplete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(b.progress()).toBe(1);
    expect(b.el.classList.contains('gv-held')).toBe(true);
    b.destroy();
  });

  it('releasing before 1.2 s resets it to zero', () => {
    const { b, onComplete } = make();
    pointer(b.el, 'pointerdown');
    vi.advanceTimersByTime(800);
    expect(b.progress()).toBeCloseTo(800 / HOLD_MS);
    pointer(b.el, 'pointerup');
    expect(b.holding()).toBe(false);
    expect(b.progress()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(onComplete).not.toHaveBeenCalled();
    // Leaving the button counts as releasing it.
    pointer(b.el, 'pointerdown');
    vi.advanceTimersByTime(600);
    pointer(b.el, 'pointerleave');
    vi.advanceTimersByTime(2000);
    expect(onComplete).not.toHaveBeenCalled();
    b.destroy();
  });

  it('Space held on the focused button works the same; releasing Space early resets', () => {
    const { b, onComplete } = make();
    b.el.focus();
    const down = key(b.el, 'keydown', ' ');
    expect(down.defaultPrevented).toBe(true);
    key(b.el, 'keydown', ' ', true);
    vi.advanceTimersByTime(500);
    key(b.el, 'keyup', ' ');
    vi.advanceTimersByTime(2000);
    expect(onComplete).not.toHaveBeenCalled();
    key(b.el, 'keydown', ' ');
    vi.advanceTimersByTime(HOLD_MS);
    expect(onComplete).toHaveBeenCalledOnce();
    b.destroy();
  });

  it('Enter and a click do nothing', () => {
    const { b, onComplete } = make();
    b.el.focus();
    const enter = key(b.el, 'keydown', 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    b.el.click();
    vi.advanceTimersByTime(5000);
    expect(onComplete).not.toHaveBeenCalled();
    expect(b.holding()).toBe(false);
    b.destroy();
  });

  it('a pointer release does not end a keyboard hold', () => {
    const { b, onComplete } = make();
    b.el.focus();
    key(b.el, 'keydown', ' ');
    pointer(b.el, 'pointerleave');
    vi.advanceTimersByTime(HOLD_MS);
    expect(onComplete).toHaveBeenCalledOnce();
    b.destroy();
  });

  it('does not start while its card is not armed', () => {
    let armed = false;
    const { b, onComplete } = make(() => armed);
    pointer(b.el, 'pointerdown');
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onComplete).not.toHaveBeenCalled();
    pointer(b.el, 'pointerup');
    armed = true;
    pointer(b.el, 'pointerdown');
    vi.advanceTimersByTime(HOLD_MS);
    expect(onComplete).toHaveBeenCalledOnce();
    b.destroy();
  });

  it('losing focus mid-hold resets it, and destroy clears its timers', () => {
    const { b, onComplete } = make();
    b.el.focus();
    key(b.el, 'keydown', ' ');
    b.el.blur();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onComplete).not.toHaveBeenCalled();
    pointer(b.el, 'pointerdown');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    b.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('draws its ring from frames when motion is allowed', () => {
    const frames: ((t: number) => void)[] = [];
    const onComplete = vi.fn();
    const b = holdButton({
      label: 'Hold',
      onComplete,
      frames: { request: (fn) => frames.push(fn), cancel: () => undefined },
    });
    document.body.appendChild(b.el);
    pointer(b.el, 'pointerdown');
    vi.advanceTimersByTime(600);
    frames.shift()?.(0);
    expect(b.el.style.getPropertyValue('--gv-hold')).toBe('0.500');
    b.destroy();
  });
});
