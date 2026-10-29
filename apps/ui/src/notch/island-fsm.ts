/**
 * The Notch's state machine (plan §7.8, FD-13; handoff Part 01 §3). Pure: no DOM. Timers are
 * injected, so tests drive every transition with fake timers.
 *
 * States: `hidden` (a 120×4 strip), `compact` (a 200×32 pill), `expanded` (a 400-wide card) and
 * `greeting` (320×96, at launch and for celebrations).
 *
 * The pin invariant: while something waits for a human (`pinned`), the island never goes to
 * `hidden`, and an expanded card is never collapsed by a timer unless the human folded it with
 * "Later" (or opened the Studio). Every timer re-checks the pin when it fires.
 */

export type IslandState = 'hidden' | 'compact' | 'expanded' | 'greeting';

/** What opened the expanded card: a pointer resting on the pill, a click or shortcut, or an item. */
export type OpenedBy = 'hover' | 'click' | 'item';

export type GreetingKind = 'welcome' | 'celebrate';

export interface IslandSnapshot {
  readonly state: IslandState;
  /** Something waits for a human: an approval, a question or a blocked agent. */
  readonly pinned: boolean;
  /** The card was folded with "Later" (or by opening the Studio) while the pin holds. */
  readonly folded: boolean;
  /** Set only while `expanded`. */
  readonly openedBy: OpenedBy | null;
  /** Set only while `greeting`. */
  readonly greeting: GreetingKind | null;
  readonly pointerInside: boolean;
  readonly focusInside: boolean;
}

export interface IslandTimings {
  /** Collapse an expanded card this long after the pointer left (Part 01 §3.2: 15 s). */
  collapseS: number;
  /** …or this long when it opened because the pointer rested on the pill (0.6 s). */
  hoverGraceS: number;
  /** Hide the compact pill after this long without anything happening (60 s). */
  hideS: number;
  /** How long the greeting shows (2.4 s). */
  greetingS: number;
}

export const ISLAND_TIMINGS: Readonly<IslandTimings> = Object.freeze({
  collapseS: 15,
  hoverGraceS: 0.6,
  hideS: 60,
  greetingS: 2.4,
});

/** The bounds a timing is clamped to (a stored preference is untrusted input). */
const MIN_S = 0.05;
const MAX_S = 86_400;

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type TimerName = 'collapse' | 'hide' | 'greeting';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type IslandListener = (next: IslandSnapshot, prev: IslandSnapshot) => void;

function sanitize(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_S, Math.max(MIN_S, value));
}

export function sanitizeTimings(t: Partial<IslandTimings> | undefined, base: IslandTimings = ISLAND_TIMINGS) {
  return {
    collapseS: sanitize(t?.collapseS, base.collapseS),
    hoverGraceS: sanitize(t?.hoverGraceS, base.hoverGraceS),
    hideS: sanitize(t?.hideS, base.hideS),
    greetingS: sanitize(t?.greetingS, base.greetingS),
  } satisfies IslandTimings;
}

export interface IslandFsmOptions {
  initial?: IslandState;
  timings?: Partial<IslandTimings>;
  timers?: TimerApi;
}

export class IslandFsm {
  #s: IslandSnapshot;
  #timings: IslandTimings;
  readonly #timers: TimerApi;
  readonly #running = new Map<TimerName, { handle: unknown; ms: number }>();
  readonly #listeners = new Set<IslandListener>();
  #destroyed = false;

  constructor(opts: IslandFsmOptions = {}) {
    this.#timers = opts.timers ?? realTimers;
    this.#timings = sanitizeTimings(opts.timings);
    const initial = opts.initial ?? 'compact';
    this.#s = Object.freeze({
      state: initial,
      pinned: false,
      folded: false,
      openedBy: initial === 'expanded' ? 'click' : null,
      greeting: initial === 'greeting' ? 'welcome' : null,
      pointerInside: false,
      focusInside: false,
    });
    this.#reconcile();
  }

  get snapshot(): IslandSnapshot {
    return this.#s;
  }

  get state(): IslandState {
    return this.#s.state;
  }

  get timings(): Readonly<IslandTimings> {
    return this.#timings;
  }

  /** The pointer or the keyboard is on the island: no timer runs. */
  get engaged(): boolean {
    return this.#s.pointerInside || this.#s.focusInside;
  }

  /** Which timers are running (for tests and diagnostics). */
  get timers(): TimerName[] {
    return [...this.#running.keys()];
  }

  subscribe(listener: IslandListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** New durations (the notch timings in Settings); running timers keep theirs until they restart. */
  setTimings(t: Partial<IslandTimings>): void {
    this.#timings = sanitizeTimings({ ...this.#timings, ...t }, this.#timings);
    this.#reconcile();
  }

  // ---- inputs -------------------------------------------------------------------------------

  pointerEnter(): void {
    const s = this.#s;
    if (s.state === 'hidden') this.#set({ pointerInside: true, state: 'compact' });
    else if (s.state === 'compact') this.#set({ pointerInside: true, state: 'expanded', openedBy: 'hover' });
    else this.#set({ pointerInside: true });
  }

  pointerLeave(): void {
    this.#set({ pointerInside: false });
  }

  /** Keyboard focus moved into the island: it shows itself and holds still. */
  focusEnter(): void {
    const s = this.#s;
    this.#set({ focusInside: true, ...(s.state === 'hidden' ? { state: 'compact' as const } : {}) });
  }

  focusLeave(): void {
    this.#set({ focusInside: false });
  }

  /** A click on the pill, or the Notch shortcut. */
  open(): void {
    // Restarts the countdown when the card is already open.
    this.#clear('collapse');
    this.#set({ state: 'expanded', openedBy: 'click', folded: false });
  }

  /** An approval, a question or a blocked agent arrived: open the card and pin it. */
  itemArrived(): void {
    this.#clear('collapse');
    this.#set({ state: 'expanded', openedBy: 'item', pinned: true, folded: false });
  }

  /**
   * Something new waits where the page already shows it in full (the Studio's Decisions tray): pin
   * the pill without opening the card. The pin counts as folded, so a card the human opens by
   * hover or click collapses on its timer as usual (ERRATA F40).
   */
  pinQuietly(): void {
    const s = this.#s;
    this.#set({ pinned: true, folded: s.pinned ? s.folded : true });
  }

  /** Whether something waits (derived from the board). */
  setPinned(pinned: boolean): void {
    if (this.#s.pinned === pinned) return;
    this.#set({ pinned });
  }

  /** "Later" (and `Esc` in the card): fold to compact; the pin holds, so it stays visible. */
  later(): void {
    const s = this.#s;
    if (s.state === 'hidden') return;
    this.#set({ state: 'compact', folded: s.pinned });
  }

  /** "Open in Studio": the card folds; the item stays pending and visible in the Studio. */
  studioOpened(): void {
    this.later();
  }

  /** An item was decided (here or elsewhere): collapse to compact unless another item waits. */
  decided(othersWaiting: boolean): void {
    const s = this.#s;
    if (othersWaiting) {
      this.#set({ pinned: true });
      return;
    }
    this.#set({ pinned: false, folded: false, state: s.state === 'expanded' ? 'compact' : s.state });
  }

  /** The launch greeting. Skipped while an item holds the card open. */
  greet(): void {
    const s = this.#s;
    if (s.state === 'expanded' && s.pinned && !s.folded) return;
    this.#clear('greeting');
    this.#set({ state: 'greeting', greeting: 'welcome' });
  }

  /** A goal completed. Never interrupts a card that holds an item or that the human is using. */
  celebrate(): void {
    const s = this.#s;
    if (s.focusInside) return;
    if (s.state === 'expanded' && ((s.pinned && !s.folded) || s.pointerInside)) return;
    this.#clear('greeting');
    this.#set({ state: 'greeting', greeting: 'celebrate' });
  }

  /** Agents did something: a hidden strip comes back as the pill; the pill's idle time restarts. */
  activity(): void {
    const s = this.#s;
    if (s.state === 'hidden') {
      this.#set({ state: 'compact' });
      return;
    }
    if (s.state === 'compact') {
      this.#clear('hide');
      this.#reconcile();
    }
  }

  destroy(): void {
    this.#destroyed = true;
    for (const name of [...this.#running.keys()]) this.#clear(name);
    this.#listeners.clear();
  }

  // ---- internals ----------------------------------------------------------------------------

  #set(changes: Partial<Mutable<IslandSnapshot>>): void {
    if (this.#destroyed) return;
    const prev = this.#s;
    const next: Mutable<IslandSnapshot> = { ...prev, ...changes };
    if (next.state !== 'greeting') next.greeting = null;
    if (next.state === 'greeting' && next.greeting === null) next.greeting = 'welcome';
    if (next.state !== 'expanded') next.openedBy = null;
    if (next.state === 'expanded' && next.openedBy === null) next.openedBy = 'click';
    if (!next.pinned) next.folded = false;
    // The pin invariant: something waits, so the island stays visible.
    if (next.pinned && next.state === 'hidden') next.state = 'compact';
    const changed = (Object.keys(next) as (keyof IslandSnapshot)[]).some((k) => next[k] !== prev[k]);
    if (changed) {
      this.#s = Object.freeze(next);
      for (const listener of [...this.#listeners]) listener(this.#s, prev);
    }
    this.#reconcile();
  }

  /** Starts the timers the current state needs and stops the others. */
  #reconcile(): void {
    if (this.#destroyed) return;
    const s = this.#s;
    const engaged = this.engaged;
    const t = this.#timings;

    if (s.state === 'greeting') this.#ensure('greeting', t.greetingS, () => this.#greetingEnded());
    else this.#clear('greeting');

    if (s.state === 'expanded' && !engaged && !(s.pinned && !s.folded)) {
      const seconds = s.openedBy === 'hover' ? t.hoverGraceS : t.collapseS;
      this.#ensure('collapse', seconds, () => this.#collapseDue());
    } else this.#clear('collapse');

    if (s.state === 'compact' && !engaged && !s.pinned) this.#ensure('hide', t.hideS, () => this.#hideDue());
    else this.#clear('hide');
  }

  #ensure(name: TimerName, seconds: number, fire: () => void): void {
    const ms = Math.round(seconds * 1000);
    const running = this.#running.get(name);
    if (running && running.ms === ms) return;
    if (running) this.#timers.clear(running.handle);
    const handle = this.#timers.set(() => {
      if (this.#running.get(name)?.handle !== handle) return;
      this.#running.delete(name);
      fire();
    }, ms);
    this.#running.set(name, { handle, ms });
  }

  #clear(name: TimerName): void {
    const running = this.#running.get(name);
    if (!running) return;
    this.#timers.clear(running.handle);
    this.#running.delete(name);
  }

  #greetingEnded(): void {
    if (this.#s.state === 'greeting') this.#set({ state: 'compact' });
    else this.#reconcile();
  }

  #collapseDue(): void {
    const s = this.#s;
    // Re-check when firing: the pin may have come back, or the human returned to the card.
    if (s.state === 'expanded' && !this.engaged && !(s.pinned && !s.folded)) this.#set({ state: 'compact' });
    else this.#reconcile();
  }

  #hideDue(): void {
    const s = this.#s;
    // The pin invariant, checked again when the timer fires.
    if (s.state === 'compact' && !this.engaged && !s.pinned) this.#set({ state: 'hidden' });
    else this.#reconcile();
  }
}
