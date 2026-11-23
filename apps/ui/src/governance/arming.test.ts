import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, h } from '../ui/dom.js';
import {
  APPEAR_SETTLE_MS,
  ARM_DELAY_MS,
  ARMING_TEXT,
  type ArmState,
  armDecisions,
  armReduce,
  armsIn,
  HELD_TEXT,
  HOLD_FROM_MS,
  initialArm,
  isArmed,
  OWN_SCROLL_SETTLE_MS,
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

  it('a card that is still appearing keeps its pointer, and waits from where it comes to rest', () => {
    let s = armReduce(visible(initialArm('a', 0), 0), { type: 'position', position: '0,0', now: 0 });
    s = armReduce(s, { type: 'pointer', now: 100 });
    // Its opening animation carries it 40 px in its first moments.
    s = armReduce(s, { type: 'position', position: '0,40', now: 250 });
    expect(s.pointer).toBe(true);
    expect(isArmed(s, 250 + ARM_DELAY_MS - 1)).toBe(false);
    expect(isArmed(s, 250 + ARM_DELAY_MS)).toBe(true);
    // Once it has appeared, a move is another card under the cursor.
    s = armReduce(s, { type: 'position', position: '0,90', now: APPEAR_SETTLE_MS + 1 });
    expect(s.pointer).toBe(false);
  });

  it('a scroll by the person keeps the pointer and asks only that it has come to rest', () => {
    let s = armReduce(visible(initialArm('a', 0), 0), { type: 'position', position: '0,0', now: 0 });
    s = armReduce(s, { type: 'pointer', now: 0 });
    const credit = ARM_DELAY_MS - OWN_SCROLL_SETTLE_MS;
    s = armReduce(s, { type: 'position', position: '0,-300', now: 5000, creditMs: credit });
    expect(s.pointer).toBe(true);
    expect(isArmed(s, 5000 + OWN_SCROLL_SETTLE_MS - 1)).toBe(false);
    expect(isArmed(s, 5000 + OWN_SCROLL_SETTLE_MS)).toBe(true);
    // It never shortens a wait that began later than the credit reaches back.
    let late = armReduce(visible(initialArm('a', 4900), 4900), { type: 'position', position: '0,0', now: 4900 });
    late = armReduce(late, { type: 'pointer', now: 4900 });
    late = armReduce(late, { type: 'position', position: '0,-300', now: 5000, creditMs: credit });
    expect(isArmed(late, 4900 + ARM_DELAY_MS - 1)).toBe(false);
    expect(isArmed(late, 4900 + ARM_DELAY_MS)).toBe(true);
  });

  it('a real press on a card nobody pointed at counts as pointing, and the wait starts at it', () => {
    let s = visible(initialArm('a', 0), 0);
    s = armReduce(s, { type: 'pressed', now: 5000 });
    expect(s.pointer).toBe(true);
    expect(isArmed(s, 5000)).toBe(false);
    expect(armsIn(s, 5000)).toBe(ARM_DELAY_MS);
    expect(isArmed(s, 5000 + ARM_DELAY_MS)).toBe(true);
    // Not on a hidden card, and it changes nothing where somebody already points.
    const hidden = initialArm('a', 0);
    expect(armReduce(hidden, { type: 'pressed', now: 10 })).toBe(hidden);
    const pointed = armReduce(visible(initialArm('a', 0), 0), { type: 'pointer', now: 0 });
    expect(armReduce(pointed, { type: 'pressed', now: 900 })).toBe(pointed);
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

  it('a click right after the card appeared does nothing; after 700 ms with the pointer on it, it decides', () => {
    const c = arm();
    move(root);
    btn.click();
    vi.advanceTimersByTime(HOLD_FROM_MS - 1);
    btn.click();
    vi.advanceTimersByTime(ARM_DELAY_MS - HOLD_FROM_MS + 1);
    // Both came too soon to be an answer to the card: neither decided, then or later.
    expect(decide).not.toHaveBeenCalled();
    expect(btn.getAttribute('aria-disabled')).toBe('false');
    expect(btn.title).toBe('Allow it');
    expect(hint.textContent).toBe('');
    btn.click();
    expect(decide).toHaveBeenCalledOnce();
    c.destroy();
  });

  it('a press a moment early is kept, shown as taken, and decides once when the card arms', () => {
    const c = arm();
    move(root);
    vi.advanceTimersByTime(HOLD_FROM_MS);
    btn.click();
    expect(decide).not.toHaveBeenCalled();
    expect(hint.textContent).toBe(HELD_TEXT);
    expect(btn.classList.contains('gv-held')).toBe(true);
    vi.advanceTimersByTime(ARM_DELAY_MS - HOLD_FROM_MS - 1);
    expect(decide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(decide).toHaveBeenCalledOnce();
    expect(btn.classList.contains('gv-held')).toBe(false);
    expect(hint.textContent).toBe('');
    vi.advanceTimersByTime(5000);
    expect(decide).toHaveBeenCalledOnce();
    c.destroy();
  });

  it('a kept press is for the card as it was: other content, another place or a hidden card drops it', () => {
    let top = 0;
    root.getBoundingClientRect = () =>
      ({ left: 0, top, right: 100, bottom: top + 50, width: 100, height: 50, x: 0, y: top }) as DOMRect;
    const early = (c: ReturnType<typeof arm>) => {
      c.changed(`k${Math.random()}`);
      move(root, 20 + Math.random() * 50, 20);
      vi.advanceTimersByTime(HOLD_FROM_MS + 50);
      btn.click();
      expect(btn.classList.contains('gv-held')).toBe(true);
    };
    const c = arm();
    // The card stopped appearing long ago.
    vi.advanceTimersByTime(APPEAR_SETTLE_MS + 100);

    early(c);
    c.changed('another request');
    expect(btn.classList.contains('gv-held')).toBe(false);
    move(root, 5, 5);
    vi.advanceTimersByTime(2000);
    expect(decide).not.toHaveBeenCalled();

    early(c);
    top = 80;
    c.check();
    expect(btn.classList.contains('gv-held')).toBe(false);
    move(root, 6, 6);
    vi.advanceTimersByTime(2000);
    expect(decide).not.toHaveBeenCalled();

    early(c);
    root.hidden = true;
    c.check();
    root.hidden = false;
    move(root, 7, 7);
    vi.advanceTimersByTime(2000);
    expect(decide).not.toHaveBeenCalled();

    // The last press wins while one is kept.
    const other = vi.fn<(event: Event) => void>();
    const deny = button('Deny', () => undefined);
    root.appendChild(deny);
    c.register(deny);
    deny.addEventListener('click', c.guard(other));
    early(c);
    deny.click();
    expect(btn.classList.contains('gv-held')).toBe(false);
    vi.advanceTimersByTime(ARM_DELAY_MS);
    expect(decide).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();
    c.destroy();
  });

  it('a card that moves while it opens keeps the pointer of a person who stood still on the button', () => {
    let top = 0;
    root.getBoundingClientRect = () =>
      ({ left: 0, top, right: 100, bottom: top + 50, width: 100, height: 50, x: 0, y: top }) as DOMRect;
    const c = arm();
    move(root);
    // The animation goes on after the last move of the pointer.
    vi.advanceTimersByTime(120);
    top = 30;
    vi.advanceTimersByTime(120);
    top = 60;
    vi.advanceTimersByTime(ARM_DELAY_MS + 200);
    expect(c.isArmed()).toBe(true);
    btn.click();
    expect(decide).toHaveBeenCalledOnce();
    c.destroy();
  });

  it('a move of the card is seen when the pointer next moves, not at the press', () => {
    let top = 0;
    root.getBoundingClientRect = () =>
      ({ left: 0, top, right: 100, bottom: top + 50, width: 100, height: 50, x: 0, y: top }) as DOMRect;
    const c = arm();
    move(root);
    vi.advanceTimersByTime(2000);
    // The list above it grew while the pointer was elsewhere; the person then goes to the button.
    top = 90;
    move(root, 40, 100);
    vi.advanceTimersByTime(ARM_DELAY_MS);
    btn.click();
    expect(decide).toHaveBeenCalledOnce();
    c.destroy();
  });

  it('a scroll by the person asks only that it has come to rest, and their press is not lost', () => {
    let top = 0;
    root.getBoundingClientRect = () =>
      ({ left: 0, top, right: 100, bottom: top + 50, width: 100, height: 50, x: 0, y: top }) as DOMRect;
    const c = arm();
    move(root);
    vi.advanceTimersByTime(3000);
    root.dispatchEvent(new Event('wheel', { bubbles: true }));
    top = -400;
    document.dispatchEvent(new Event('scroll'));
    expect(c.isArmed()).toBe(false);
    btn.click();
    expect(decide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(OWN_SCROLL_SETTLE_MS);
    expect(decide).toHaveBeenCalledOnce();
    // A scroll that is not theirs (the page moved the card) is another card under the cursor.
    vi.advanceTimersByTime(3000);
    top = -100;
    document.dispatchEvent(new Event('scroll'));
    btn.click();
    vi.advanceTimersByTime(3000);
    expect(decide).toHaveBeenCalledOnce();
    c.destroy();
  });

  it('a real press on a card nobody pointed at decides nothing, and the next one does', () => {
    const press = () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const c = arm();
    vi.advanceTimersByTime(5000);
    press();
    expect(decide).not.toHaveBeenCalled();
    expect(hint.textContent).toBe(ARMING_TEXT);
    // A second press at once (a double click) decides nothing either.
    vi.advanceTimersByTime(150);
    press();
    vi.advanceTimersByTime(ARM_DELAY_MS);
    expect(decide).not.toHaveBeenCalled();
    expect(btn.getAttribute('aria-disabled')).toBe('false');
    press();
    expect(decide).toHaveBeenCalledOnce();
    c.destroy();
  });

  it('a key on a card that took the focus by itself never counts as pointing', () => {
    const c = arm();
    btn.focus();
    vi.advanceTimersByTime(5000);
    // Enter or Space on a focused button arrives as a click without a count.
    btn.click();
    vi.advanceTimersByTime(400);
    btn.click();
    vi.advanceTimersByTime(5000);
    btn.click();
    expect(decide).not.toHaveBeenCalled();
    expect(c.isArmed()).toBe(false);
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
    vi.advanceTimersByTime(HOLD_FROM_MS - 1);
    btn.click();
    vi.advanceTimersByTime(ARM_DELAY_MS - HOLD_FROM_MS + 1);
    expect(decide).not.toHaveBeenCalled();
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
