import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, h } from '../ui/dom.js';
import {
  ARM_DELAY_MS,
  ARMING_TEXT,
  type ArmState,
  armDecisions,
  armReduce,
  armsIn,
  initialArm,
  isArmed,
} from './arming.js';

function move(el: Element, x = 10, y = 10, movementX = 1): void {
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, movementX }));
}

describe('the arming rule (pure)', () => {
  const visible = (s: ArmState, now: number) => armReduce(s, { type: 'visible', visible: true, now });

  it('arms 700 ms after the card is visible and still, once the pointer moved onto it', () => {
    let s = visible(initialArm('k', 0), 0);
    expect(isArmed(s, 5000)).toBe(false);
    expect(armsIn(s, 0)).toBeNull();
    s = armReduce(s, { type: 'pointer', now: 100 });
    expect(isArmed(s, 699)).toBe(false);
    expect(armsIn(s, 300)).toBe(400);
    expect(isArmed(s, ARM_DELAY_MS)).toBe(true);
    expect(armsIn(s, 900)).toBe(0);
  });

  it('counts the wait from when the card became visible', () => {
    let s = armReduce(initialArm('k', 0), { type: 'pointer', now: 0 });
    expect(isArmed(s, 5000)).toBe(false);
    s = visible(s, 1000);
    expect(isArmed(s, 1699)).toBe(false);
    expect(isArmed(s, 1700)).toBe(true);
  });

  it('a content change waits again and needs the pointer again', () => {
    let s = armReduce(visible(initialArm('a', 0), 0), { type: 'pointer', now: 0 });
    expect(isArmed(s, 800)).toBe(true);
    s = armReduce(s, { type: 'content', key: 'b', now: 800 });
    expect(isArmed(s, 5000)).toBe(false);
    s = armReduce(s, { type: 'pointer', now: 900 });
    expect(isArmed(s, 1499)).toBe(false);
    expect(isArmed(s, 1500)).toBe(true);
    expect(armReduce(s, { type: 'content', key: 'b', now: 2000 })).toBe(s);
  });

  it('the first position is where it appeared; a later move waits again', () => {
    let s = armReduce(visible(initialArm('a', 0), 0), { type: 'pointer', now: 0 });
    s = armReduce(s, { type: 'position', position: '0,0', now: 0 });
    expect(isArmed(s, 700)).toBe(true);
    s = armReduce(s, { type: 'position', position: '0,40', now: 1000 });
    expect(s.pointer).toBe(false);
    s = armReduce(s, { type: 'pointer', now: 1000 });
    expect(isArmed(s, 1600)).toBe(false);
    expect(isArmed(s, 1700)).toBe(true);
  });

  it('a shift of a few pixels is layout settling and keeps the arm; more waits again', () => {
    let s = armReduce(visible(initialArm('a', 0), 0), { type: 'pointer', now: 0 });
    s = armReduce(s, { type: 'position', position: '100,200', now: 0 });
    s = armReduce(s, { type: 'position', position: '100,201', now: 800 });
    s = armReduce(s, { type: 'position', position: '96,204', now: 900 });
    expect(isArmed(s, 900)).toBe(true);
    s = armReduce(s, { type: 'position', position: '100,210', now: 1000 });
    expect(s.pointer).toBe(false);
    expect(isArmed(s, 1000)).toBe(false);
  });

  it('focus counts only when the user moved it, and ends when it leaves', () => {
    let s = visible(initialArm('a', 0), 0);
    s = armReduce(s, { type: 'focus', inside: true, byUser: false, now: 0 });
    expect(isArmed(s, 1000)).toBe(false);
    s = armReduce(s, { type: 'focus', inside: true, byUser: true, now: 0 });
    expect(isArmed(s, 1000)).toBe(true);
    s = armReduce(s, { type: 'focus', inside: false, byUser: false, now: 1000 });
    expect(isArmed(s, 2000)).toBe(false);
  });

  it('hiding the card disarms it; showing it again waits again', () => {
    let s = armReduce(visible(initialArm('a', 0), 0), { type: 'pointer', now: 0 });
    s = armReduce(s, { type: 'visible', visible: false, now: 1000 });
    expect(isArmed(s, 1000)).toBe(false);
    s = armReduce(visible(s, 2000), { type: 'pointer', now: 2000 });
    expect(isArmed(s, 2699)).toBe(false);
    expect(isArmed(s, 2700)).toBe(true);
  });
});

describe('armDecisions (DOM, fake timers)', () => {
  let root: HTMLElement;
  let decide: ReturnType<typeof vi.fn<(event: Event) => void>>;
  let btn: HTMLButtonElement;
  let hint: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    decide = vi.fn<(event: Event) => void>();
    hint = h('div');
    btn = button('Allow once', () => undefined, { title: 'Allow it' });
    root = h('section', null, btn, hint);
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
    vi.useRealTimers();
  });

  function arm() {
    const c = armDecisions(root, { key: 'a', hint });
    c.register(btn);
    btn.addEventListener('click', c.guard(decide));
    vi.advanceTimersByTime(0);
    return c;
  }

  it('starts unarmed: aria-disabled, "Ready in a moment"', () => {
    const c = arm();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.title).toBe(ARMING_TEXT);
    expect(hint.textContent).toBe(ARMING_TEXT);
    expect(btn.classList.contains('gv-unarmed')).toBe(true);
    c.destroy();
  });

  it('a click within 700 ms does nothing; after 700 ms with the pointer on it, it decides', () => {
    const c = arm();
    move(root);
    btn.click();
    vi.advanceTimersByTime(699);
    btn.click();
    expect(decide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(btn.getAttribute('aria-disabled')).toBe('false');
    expect(btn.title).toBe('Allow it');
    expect(hint.textContent).toBe('');
    btn.click();
    expect(decide).toHaveBeenCalledOnce();
    c.destroy();
  });

  it('never arms while the pointer has not moved onto the card', () => {
    const c = arm();
    vi.advanceTimersByTime(5000);
    btn.click();
    expect(decide).not.toHaveBeenCalled();
    expect(c.isArmed()).toBe(false);
    c.destroy();
  });

  it('a pointer event without movement (a card under a resting cursor) does not count', () => {
    const c = arm();
    move(root, 10, 10, 0);
    move(root, 10, 10, 0);
    vi.advanceTimersByTime(1000);
    expect(c.isArmed()).toBe(false);
    move(root, 11, 10, 0);
    vi.advanceTimersByTime(700);
    expect(c.isArmed()).toBe(true);
    c.destroy();
  });

  it('a content change re-arms: the next click does nothing until it waited again', () => {
    const c = arm();
    move(root);
    vi.advanceTimersByTime(700);
    expect(c.isArmed()).toBe(true);
    c.changed('b');
    btn.click();
    expect(decide).not.toHaveBeenCalled();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    move(root, 20, 20);
    vi.advanceTimersByTime(699);
    btn.click();
    expect(decide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    btn.click();
    expect(decide).toHaveBeenCalledOnce();
    c.destroy();
  });

  it('a position change re-arms, and the click that found it is refused', () => {
    let top = 0;
    root.getBoundingClientRect = () =>
      ({ left: 0, top, right: 100, bottom: top + 50, width: 100, height: 50, x: 0, y: top }) as DOMRect;
    const c = arm();
    move(root);
    vi.advanceTimersByTime(700);
    expect(c.isArmed()).toBe(true);
    top = 60;
    btn.click();
    expect(decide).not.toHaveBeenCalled();
    move(root, 30, 30);
    vi.advanceTimersByTime(700);
    btn.click();
    expect(decide).toHaveBeenCalledOnce();
    c.destroy();
  });

  it('focus moved in by the user (Tab) counts; focus moved by code does not', () => {
    const c = arm();
    btn.focus();
    vi.advanceTimersByTime(1000);
    expect(c.isArmed()).toBe(false);
    btn.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    btn.focus();
    vi.advanceTimersByTime(700);
    expect(c.isArmed()).toBe(true);
    c.destroy();
  });

  it('a mouse press without moving (a card that opened under a resting cursor) does not arm it', () => {
    const c = arm();
    vi.advanceTimersByTime(1000);
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    btn.focus();
    btn.click();
    expect(decide).not.toHaveBeenCalled();
    expect(c.isArmed()).toBe(false);
    c.destroy();
  });

  it('a touch on the card counts as pointing at it, still after the wait', () => {
    const c = arm();
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    btn.click();
    expect(decide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(700);
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    btn.click();
    expect(decide).toHaveBeenCalledOnce();
    c.destroy();
  });

  it('a hidden card is not armed', () => {
    const c = arm();
    move(root);
    vi.advanceTimersByTime(700);
    expect(c.isArmed()).toBe(true);
    root.hidden = true;
    expect(c.isArmed()).toBe(false);
    c.destroy();
  });

  it('destroy clears its timers and listeners', () => {
    const c = arm();
    move(root);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    c.destroy();
    expect(vi.getTimerCount()).toBe(0);
    move(root, 40, 40);
    expect(vi.getTimerCount()).toBe(0);
  });
});
