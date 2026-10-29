import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ISLAND_TIMINGS, IslandFsm, type IslandSnapshot, sanitizeTimings, type TimerApi } from './island-fsm.js';

const S = 1000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function fsm(initial: IslandSnapshot['state'] = 'compact', timings = {}): IslandFsm {
  return new IslandFsm({ initial, timings });
}

describe('island state machine: idle and hover (Part 01 §3)', () => {
  it('hides the compact pill after 60 s idle, not before', () => {
    const m = fsm();
    vi.advanceTimersByTime(59_999);
    expect(m.state).toBe('compact');
    vi.advanceTimersByTime(1);
    expect(m.state).toBe('hidden');
  });

  it('peeks from the strip to the pill on hover, then opens the card on hover', () => {
    const m = fsm('hidden');
    m.pointerEnter();
    expect(m.state).toBe('compact');
    m.pointerLeave();
    m.pointerEnter();
    expect(m.snapshot).toMatchObject({ state: 'expanded', openedBy: 'hover', pointerInside: true });
  });

  it('collapses a card opened by hover 0.6 s after the pointer leaves', () => {
    const m = fsm();
    m.pointerEnter();
    m.pointerLeave();
    vi.advanceTimersByTime(599);
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(1);
    expect(m.state).toBe('compact');
    vi.advanceTimersByTime(60 * S);
    expect(m.state).toBe('hidden');
  });

  it('collapses a clicked card 15 s after the pointer leaves', () => {
    const m = fsm();
    m.pointerEnter();
    m.open();
    expect(m.snapshot.openedBy).toBe('click');
    m.pointerLeave();
    vi.advanceTimersByTime(14_999);
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(1);
    expect(m.state).toBe('compact');
  });

  it('keeps a card open while the pointer is on it, and restarts the countdown on re-entry', () => {
    const m = fsm();
    m.open();
    m.pointerEnter();
    vi.advanceTimersByTime(10 * 60 * S);
    expect(m.state).toBe('expanded');
    m.pointerLeave();
    vi.advanceTimersByTime(10 * S);
    m.pointerEnter();
    m.pointerLeave();
    vi.advanceTimersByTime(14 * S);
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(S);
    expect(m.state).toBe('compact');
  });

  it('collapses a card opened by the shortcut with the pointer elsewhere after 15 s', () => {
    const m = fsm('hidden');
    m.open();
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(15 * S);
    expect(m.state).toBe('compact');
  });

  it('the shortcut on an open card restarts its countdown', () => {
    const m = fsm();
    m.open();
    vi.advanceTimersByTime(10 * S);
    m.open();
    vi.advanceTimersByTime(10 * S);
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(5 * S);
    expect(m.state).toBe('compact');
  });

  it('holds still while keyboard focus is inside, and counts down when it leaves', () => {
    const m = fsm('hidden');
    m.focusEnter();
    expect(m.state).toBe('compact');
    vi.advanceTimersByTime(10 * 60 * S);
    expect(m.state).toBe('compact');
    m.open();
    m.focusLeave();
    vi.advanceTimersByTime(15 * S);
    expect(m.state).toBe('compact');
    vi.advanceTimersByTime(60 * S);
    expect(m.state).toBe('hidden');
  });

  it('uses the timings from the preferences, including changes', () => {
    const m = fsm('compact', { collapseS: 5, hideS: 10 });
    vi.advanceTimersByTime(10 * S);
    expect(m.state).toBe('hidden');
    m.setTimings({ hideS: 2 });
    m.open();
    vi.advanceTimersByTime(5 * S);
    expect(m.state).toBe('compact');
    vi.advanceTimersByTime(2 * S);
    expect(m.state).toBe('hidden');
  });

  it('restarts the idle time when agents work, and brings the strip back as the pill', () => {
    const m = fsm();
    vi.advanceTimersByTime(50 * S);
    m.activity();
    vi.advanceTimersByTime(50 * S);
    expect(m.state).toBe('compact');
    vi.advanceTimersByTime(10 * S);
    expect(m.state).toBe('hidden');
    m.activity();
    expect(m.state).toBe('compact');
  });

  it('activity does not change an expanded card', () => {
    const m = fsm();
    m.open();
    m.activity();
    expect(m.state).toBe('expanded');
  });
});

describe('island state machine: pinning (Part 01 §3.2, plan §7.8)', () => {
  it('opens and pins on an item, and no timer collapses or hides it', () => {
    const m = fsm('hidden');
    m.itemArrived();
    expect(m.snapshot).toMatchObject({ state: 'expanded', pinned: true, folded: false, openedBy: 'item' });
    vi.advanceTimersByTime(24 * 3600 * S);
    expect(m.state).toBe('expanded');
    m.pointerEnter();
    m.pointerLeave();
    vi.advanceTimersByTime(24 * 3600 * S);
    expect(m.state).toBe('expanded');
    expect(m.timers).toEqual([]);
  });

  it('"Later" folds to compact while the pin holds; it is never hidden and reopens on hover', () => {
    const m = fsm();
    m.itemArrived();
    m.later();
    expect(m.snapshot).toMatchObject({ state: 'compact', pinned: true, folded: true });
    vi.advanceTimersByTime(24 * 3600 * S);
    expect(m.state).toBe('compact');
    m.pointerEnter();
    expect(m.snapshot).toMatchObject({ state: 'expanded', openedBy: 'hover', folded: true });
    m.pointerLeave();
    vi.advanceTimersByTime(600);
    expect(m.snapshot).toMatchObject({ state: 'compact', folded: true, pinned: true });
  });

  it('a folded card opened by a click stays unfolded and pinned', () => {
    const m = fsm();
    m.itemArrived();
    m.later();
    m.open();
    expect(m.snapshot).toMatchObject({ state: 'expanded', folded: false, pinned: true });
    vi.advanceTimersByTime(3600 * S);
    expect(m.state).toBe('expanded');
  });

  it('a new item unfolds and reopens the card', () => {
    const m = fsm();
    m.itemArrived();
    m.later();
    m.itemArrived();
    expect(m.snapshot).toMatchObject({ state: 'expanded', folded: false, pinned: true });
  });

  it('"decided" collapses to compact unless another item waits', () => {
    const m = fsm();
    m.itemArrived();
    m.decided(true);
    expect(m.snapshot).toMatchObject({ state: 'expanded', pinned: true });
    m.decided(false);
    expect(m.snapshot).toMatchObject({ state: 'compact', pinned: false, folded: false });
    vi.advanceTimersByTime(60 * S);
    expect(m.state).toBe('hidden');
  });

  it('"decided" while folded keeps the fold when another item waits, and clears it otherwise', () => {
    const m = fsm();
    m.itemArrived();
    m.later();
    m.decided(true);
    expect(m.snapshot).toMatchObject({ state: 'compact', folded: true, pinned: true });
    m.decided(false);
    expect(m.snapshot).toMatchObject({ state: 'compact', folded: false, pinned: false });
  });

  it('"studioOpened" folds the card; the item stays pending', () => {
    const m = fsm();
    m.itemArrived();
    m.studioOpened();
    expect(m.snapshot).toMatchObject({ state: 'compact', pinned: true, folded: true });
    vi.advanceTimersByTime(3600 * S);
    expect(m.state).toBe('compact');
  });

  it('a pin makes a hidden strip visible, and unpinning lets it hide again', () => {
    const m = fsm('hidden');
    m.setPinned(true);
    expect(m.snapshot).toMatchObject({ state: 'compact', pinned: true });
    vi.advanceTimersByTime(3600 * S);
    expect(m.state).toBe('compact');
    m.setPinned(false);
    vi.advanceTimersByTime(60 * S);
    expect(m.state).toBe('hidden');
  });

  it('unpinning an expanded card starts its collapse countdown', () => {
    const m = fsm();
    m.itemArrived();
    m.setPinned(false);
    vi.advanceTimersByTime(15 * S);
    expect(m.snapshot).toMatchObject({ state: 'compact', pinned: false });
  });

  it('a pin arriving during the countdown keeps the card open', () => {
    const m = fsm();
    m.open();
    vi.advanceTimersByTime(10 * S);
    m.setPinned(true);
    vi.advanceTimersByTime(3600 * S);
    expect(m.state).toBe('expanded');
  });

  it('timers re-check the pin when they fire: a stale timer does nothing', () => {
    // A timer API whose clear never cancels: every timer fires, even after it was replaced.
    const fns: (() => void)[] = [];
    const leaky: TimerApi = {
      set: (fn) => {
        fns.push(fn);
        return fns.length;
      },
      clear: () => undefined,
    };
    const m = new IslandFsm({ initial: 'compact', timers: leaky });
    m.setPinned(true);
    m.itemArrived();
    for (const fn of fns) fn();
    expect(m.snapshot).toMatchObject({ state: 'expanded', pinned: true });
    m.later();
    for (const fn of fns) fn();
    expect(m.snapshot).toMatchObject({ state: 'compact', pinned: true });
  });

  it('never hides while pinned, under any sequence of inputs (randomised)', () => {
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const inputs: ((m: IslandFsm) => void)[] = [
      (m) => m.pointerEnter(),
      (m) => m.pointerLeave(),
      (m) => m.focusEnter(),
      (m) => m.focusLeave(),
      (m) => m.open(),
      (m) => m.itemArrived(),
      (m) => m.setPinned(true),
      (m) => m.setPinned(false),
      (m) => m.later(),
      (m) => m.studioOpened(),
      (m) => m.decided(true),
      (m) => m.decided(false),
      (m) => m.greet(),
      (m) => m.celebrate(),
      (m) => m.activity(),
    ];
    for (let run = 0; run < 20; run++) {
      const m = fsm(rand() < 0.5 ? 'hidden' : 'compact');
      for (let step = 0; step < 300; step++) {
        inputs[Math.floor(rand() * inputs.length)]?.(m);
        vi.advanceTimersByTime(Math.floor(rand() * 90 * S));
        const s = m.snapshot;
        if (s.pinned) expect(s.state).not.toBe('hidden');
        if (s.folded) expect(s.pinned).toBe(true);
        expect(s.greeting !== null).toBe(s.state === 'greeting');
        expect(s.openedBy !== null).toBe(s.state === 'expanded');
        // A pinned, unfolded card that is open is never collapsed by a timer.
        if (s.state === 'expanded' && s.pinned && !s.folded) expect(m.timers).not.toContain('collapse');
      }
      m.destroy();
    }
  });
});

describe('island state machine: greeting and celebration', () => {
  it('greets for 2.4 s, then shows the pill', () => {
    const m = fsm('hidden');
    m.greet();
    expect(m.snapshot).toMatchObject({ state: 'greeting', greeting: 'welcome' });
    vi.advanceTimersByTime(2399);
    expect(m.state).toBe('greeting');
    vi.advanceTimersByTime(1);
    expect(m.snapshot).toMatchObject({ state: 'compact', greeting: null });
  });

  it('does not greet over a pinned card', () => {
    const m = fsm();
    m.itemArrived();
    m.greet();
    m.celebrate();
    expect(m.state).toBe('expanded');
  });

  it('celebrates a completed goal, but not over a card the human is using', () => {
    const m = fsm();
    m.celebrate();
    expect(m.snapshot).toMatchObject({ state: 'greeting', greeting: 'celebrate' });
    vi.advanceTimersByTime(2400);
    expect(m.state).toBe('compact');
    m.pointerEnter();
    expect(m.state).toBe('expanded');
    m.celebrate();
    expect(m.state).toBe('expanded');
    m.pointerLeave();
    m.focusEnter();
    m.celebrate();
    expect(m.state).toBe('expanded');
  });

  it('a second greeting restarts the timer', () => {
    const m = fsm();
    m.greet();
    vi.advanceTimersByTime(2000);
    m.celebrate();
    vi.advanceTimersByTime(2000);
    expect(m.snapshot).toMatchObject({ state: 'greeting', greeting: 'celebrate' });
    vi.advanceTimersByTime(400);
    expect(m.state).toBe('compact');
  });

  it('an item during the greeting opens the card at once', () => {
    const m = fsm();
    m.greet();
    m.itemArrived();
    expect(m.state).toBe('expanded');
    vi.advanceTimersByTime(3 * S);
    expect(m.state).toBe('expanded');
  });

  it('a pinned folded pill may greet, and returns to the folded pill', () => {
    const m = fsm();
    m.itemArrived();
    m.later();
    m.celebrate();
    expect(m.state).toBe('greeting');
    vi.advanceTimersByTime(2400);
    expect(m.snapshot).toMatchObject({ state: 'compact', folded: true, pinned: true });
  });
});

describe('island state machine: plumbing', () => {
  it('notifies listeners only on change, with the previous snapshot', () => {
    const m = fsm();
    const seen: [string, string][] = [];
    const off = m.subscribe((next, prev) => seen.push([prev.state, next.state]));
    m.pointerLeave();
    m.open();
    m.open();
    expect(seen).toEqual([['compact', 'expanded']]);
    off();
    m.later();
    expect(seen).toHaveLength(1);
  });

  it('later on the strip does nothing', () => {
    const m = fsm('hidden');
    m.later();
    expect(m.state).toBe('hidden');
  });

  it('destroy clears every timer and ignores later inputs', () => {
    const m = fsm();
    m.greet();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    m.destroy();
    expect(vi.getTimerCount()).toBe(0);
    m.itemArrived();
    vi.advanceTimersByTime(3600 * S);
    expect(m.state).toBe('greeting');
  });

  it('sanitises timings: non-numbers, zero, negatives and huge values', () => {
    expect(sanitizeTimings({ collapseS: Number.NaN, hideS: -1, greetingS: 0 })).toEqual({ ...ISLAND_TIMINGS });
    expect(sanitizeTimings({ collapseS: 1e12 }).collapseS).toBe(86_400);
    expect(sanitizeTimings({ hoverGraceS: 0.001 }).hoverGraceS).toBe(0.05);
    expect(sanitizeTimings({ hideS: '5' as unknown as number }).hideS).toBe(60);
  });

  it('starts expanded or greeting when asked', () => {
    expect(fsm('expanded').snapshot.openedBy).toBe('click');
    const g = fsm('greeting');
    expect(g.snapshot.greeting).toBe('welcome');
    vi.advanceTimersByTime(2400);
    expect(g.state).toBe('compact');
  });
});

describe('island state machine without a card (a browser page, review §4)', () => {
  function pill(): IslandFsm {
    return new IslandFsm({ initial: 'compact', card: false });
  }

  it('never expands: hover, click and an arriving item leave the pill as it is', () => {
    const m = pill();
    expect(m.hasCard).toBe(false);
    m.pointerEnter();
    expect(m.snapshot).toMatchObject({ state: 'compact', pointerInside: true, openedBy: null });
    m.pointerLeave();
    m.open();
    expect(m.state).toBe('compact');
    m.itemArrived();
    expect(m.snapshot).toMatchObject({ state: 'compact', pinned: true });
    // The pin still holds the pill on the screen.
    vi.advanceTimersByTime(3600 * S);
    expect(m.state).toBe('compact');
    m.decided(false);
    vi.advanceTimersByTime(60 * S);
    expect(m.state).toBe('hidden');
  });

  it('still wakes from the strip, greets and celebrates', () => {
    const m = pill();
    vi.advanceTimersByTime(60 * S);
    expect(m.state).toBe('hidden');
    m.pointerEnter();
    expect(m.state).toBe('compact');
    m.pointerLeave();
    m.pointerEnter();
    expect(m.state).toBe('compact');
    m.pointerLeave();
    m.celebrate();
    expect(m.snapshot).toMatchObject({ state: 'greeting', greeting: 'celebrate' });
    vi.advanceTimersByTime(2400);
    expect(m.state).toBe('compact');
    m.greet();
    expect(m.snapshot.greeting).toBe('welcome');
  });

  it('cannot start expanded', () => {
    expect(new IslandFsm({ initial: 'expanded', card: false }).state).toBe('compact');
    expect(new IslandFsm({ initial: 'expanded' }).hasCard).toBe(true);
  });
});
