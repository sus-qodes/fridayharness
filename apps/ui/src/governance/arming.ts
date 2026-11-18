/**
 * Decisions are bound to what was shown (plan FD-28, LESSONS UI-37). A card's decision controls
 * arm only after the card has been visible and unchanged for 700 ms **and** the pointer has moved
 * onto it (or the user moved focus into it); any change of content or position re-arms them.
 * Cards open under a resting cursor and next to text fields, so neither a click that was meant for
 * what was there before nor a stray key can decide.
 *
 * What the rule must not do is lose a press its person meant (2026-11-18: "Approve needed two
 * clicks", three times in one day). Four things did that, and none of them is another card
 * arriving under the cursor:
 *  - the card's own opening animation moved it, which took the pointer away from a person who had
 *    already moved onto it and then stood still on the button;
 *  - the person's own scroll inside a long card (a plan to its Approve button) moved it;
 *  - a move was noticed only at the press, so a shift of ten seconds ago refused it;
 *  - a press a moment early was dropped, and one with a resting cursor could never succeed.
 * So: a card that is still appearing keeps its pointer; a scroll by the person keeps it and asks
 * only for the scroll to settle; the position is read at every move of the pointer; a press that
 * comes a moment early is kept and acts when the wait is over; and a real press on a card nobody
 * pointed at counts as pointing from then on, so the next one decides.
 *
 * The rule itself is a pure reducer (`armReduce`, `isArmed`); `armDecisions` wires it to a card's
 * DOM: pointer and focus listeners, visibility, a position check, and the look of unarmed buttons.
 */

export const ARM_DELAY_MS = 700;
/**
 * A move smaller than this is layout settling (a line of text changing, sub-pixel rounding), not
 * another card arriving under the cursor; it does not re-arm (LESSONS UI-44).
 */
export const POSITION_TOLERANCE_PX = 4;

/** What unarmed buttons say. */
export const ARMING_TEXT = 'Ready in a moment';

/** What is said while a press that came a moment early waits to act (see `guard`). */
export const HELD_TEXT = 'One moment…';

/**
 * A press this long after the card last changed is its person's answer to what is shown, and is
 * kept until the card arms. One sooner is the end of a move that began before the card was there
 * (a hand already on its way to something else), and does nothing.
 */
export const HOLD_FROM_MS = 300;
/** A card moves while it opens (its animation): that is one arrival, not a second one. */
export const APPEAR_SETTLE_MS = 400;
/** How long after the person's own scroll a move of the card is theirs. */
export const OWN_SCROLL_WINDOW_MS = 400;
/** What is asked after the person's own scroll: that it has come to rest. */
export const OWN_SCROLL_SETTLE_MS = 150;
/** How often a card that is still appearing is looked at, so the end of its animation is seen. */
const APPEAR_POLL_MS = 100;

/** Time and timers, injectable for tests. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ArmState {
  /** When the card last became visible; null while it is not. */
  visibleSince: number | null;
  /** When its content or position last changed. */
  changedAt: number;
  /** The content that decisions are about (approval id, capability, target, …). */
  key: string;
  /** Its last measured position, `left,top`; null before the first measurement. */
  position: string | null;
  /** The pointer moved onto the card since the last change. */
  pointer: boolean;
  /** The user moved focus into the card, and it is still there. */
  focus: boolean;
}

export type ArmInput =
  | { type: 'visible'; visible: boolean; now: number }
  | { type: 'content'; key: string; now: number }
  /** `creditMs`: the person moved it themselves (a scroll); this much of the wait is not asked again. */
  | { type: 'position'; position: string; now: number; creditMs?: number }
  | { type: 'pointer'; now: number }
  /** A real press (mouse, touch, pen) on a decision of a card nobody had pointed at. */
  | { type: 'pressed'; now: number }
  | { type: 'focus'; inside: boolean; byUser: boolean; now: number };

export function initialArm(key: string, now: number): ArmState {
  return { visibleSince: null, changedAt: now, key, position: null, pointer: false, focus: false };
}

/** The next state after one input. A change of content or position starts the wait again. */
export function armReduce(s: ArmState, input: ArmInput): ArmState {
  switch (input.type) {
    case 'visible':
      if (input.visible) return s.visibleSince === null ? { ...s, visibleSince: input.now } : s;
      return s.visibleSince === null && !s.pointer ? s : { ...s, visibleSince: null, pointer: false };
    case 'content':
      return input.key === s.key ? s : { ...s, key: input.key, changedAt: input.now, pointer: false };
    case 'position':
      if (s.position === input.position) return s;
      // The first measurement is where it appeared, not a move.
      if (s.position === null) return { ...s, position: input.position };
      if (nearby(s.position, input.position)) return s;
      // Their own scroll: they are still pointing at it, and wait only for it to come to rest.
      if (input.creditMs !== undefined)
        return { ...s, position: input.position, changedAt: Math.max(s.changedAt, input.now - input.creditMs) };
      // Still appearing: the wait counts from where it comes to rest, the pointer stays.
      if (s.visibleSince !== null && input.now - s.visibleSince <= APPEAR_SETTLE_MS)
        return { ...s, position: input.position, changedAt: input.now };
      return { ...s, position: input.position, changedAt: input.now, pointer: false };
    case 'pointer':
      return s.pointer ? s : { ...s, pointer: true };
    case 'pressed':
      // It decides nothing itself; whoever pressed is here now, and the wait starts at the press.
      if (s.visibleSince === null || s.pointer || s.focus) return s;
      return { ...s, pointer: true, changedAt: input.now };
    case 'focus':
      if (!input.inside) return s.focus ? { ...s, focus: false } : s;
      return input.byUser && !s.focus ? { ...s, focus: true } : s;
  }
}

/** Two `left,top` positions within the tolerance on both axes. */
function nearby(a: string, b: string): boolean {
  const [ax, ay] = a.split(',').map(Number);
  const [bx, by] = b.split(',').map(Number);
  if (![ax, ay, bx, by].every((v) => Number.isFinite(v))) return false;
  return (
    Math.abs((ax as number) - (bx as number)) <= POSITION_TOLERANCE_PX &&
    Math.abs((ay as number) - (by as number)) <= POSITION_TOLERANCE_PX
  );
}

/** Since when the card has been visible and unchanged; null while it is not visible. */
function stableSince(s: ArmState): number | null {
  return s.visibleSince === null ? null : Math.max(s.visibleSince, s.changedAt);
}

export function isArmed(s: ArmState, now: number, delayMs = ARM_DELAY_MS): boolean {
  const since = stableSince(s);
  return since !== null && (s.pointer || s.focus) && now - since >= delayMs;
}

/**
 * Milliseconds until the card arms by time alone: 0 when armed, null while it waits for something
 * other than time (visibility, the pointer or focus).
 */
export function armsIn(s: ArmState, now: number, delayMs = ARM_DELAY_MS): number | null {
  const since = stableSince(s);
  if (since === null || !(s.pointer || s.focus)) return null;
  return Math.max(0, since + delayMs - now);
}

// ---------------------------------------------------------------------------------------------
// DOM

export interface ArmingController {
  /** Whether decisions may act now (re-checks visibility and position first). */
  isArmed(): boolean;
  /** The decision content changed (a new approval in the same card): wait again. */
  changed(key: string): void;
  /** A decision button: `aria-disabled` and "Ready in a moment" while unarmed. */
  register(button: HTMLElement): void;
  /** Wraps a decision handler so it does nothing while unarmed. */
  guard<E extends Event>(fn: (event: E) => void): (event: E) => void;
  /** Re-reads visibility and position now. */
  check(): void;
  destroy(): void;
}

export interface ArmingOptions {
  key: string;
  clock?: Clock;
  delayMs?: number;
  /** Shows "Ready in a moment" while unarmed, empty once armed. */
  hint?: HTMLElement;
  onChange?: (armed: boolean) => void;
}

/** How long after a Tab key a focus counts as the user's own move. */
const USER_FOCUS_WINDOW_MS = 600;

/** A press made with a mouse, a finger or a pen: a key, or code, reports no click count. */
function realPress(event: Event): boolean {
  return typeof MouseEvent !== 'undefined' && event instanceof MouseEvent && event.detail > 0;
}

/** Arms the decision buttons of `root` by the rule above. */
export function armDecisions(root: HTMLElement, opts: ArmingOptions): ArmingController {
  const clock = opts.clock ?? systemClock;
  const delay = opts.delayMs ?? ARM_DELAY_MS;
  let state = initialArm(opts.key, clock.now());
  let armed = false;
  let timer: unknown = null;
  let ioVisible: boolean | null = null;
  let lastTabAt = Number.NEGATIVE_INFINITY;
  let lastPointer: { x: number; y: number } | null = null;
  let lastOwnScrollAt = Number.NEGATIVE_INFINITY;
  let destroyed = false;
  /**
   * A press on a decision that came before the card had armed, by a person who had pointed at the
   * card (2026-11-18). It was dropped without a word: the person pressed Approve, saw "Ready in a
   * moment" come and go, and had to press again. It is kept, and acts the moment the card arms, if
   * the card is still the one that was pressed: same content, same place.
   */
  let held: { run: () => void; key: string; position: string | null; button: HTMLElement | null } | null = null;
  const dropHeld = (): void => {
    held?.button?.classList.remove('gv-held');
    held = null;
  };
  const buttons = new Set<HTMLElement>();
  const titles = new WeakMap<HTMLElement, string>();
  const doc = root.ownerDocument;

  const visibleNow = (): boolean =>
    root.isConnected && root.closest('[hidden]') === null && doc.visibilityState !== 'hidden' && (ioVisible ?? true);

  const positionNow = (): string => {
    const r = root.getBoundingClientRect();
    return `${Math.round(r.left)},${Math.round(r.top)}`;
  };

  const apply = (): void => {
    const next = isArmed(state, clock.now(), delay);
    for (const b of buttons) paint(b, next);
    // A press was meant for the card as it was: another content or place is another card, and so
    // is one that nobody points at any more.
    if (
      held &&
      (held.key !== state.key || held.position !== state.position || armsIn(state, clock.now(), delay) === null)
    )
      dropHeld();
    if (opts.hint) opts.hint.textContent = next ? '' : held ? HELD_TEXT : ARMING_TEXT;
    if (next !== armed) {
      armed = next;
      opts.onChange?.(armed);
    }
    if (next && held) {
      const { run } = held;
      dropHeld();
      run();
    }
  };

  const paint = (b: HTMLElement, on: boolean): void => {
    b.setAttribute('aria-disabled', on ? 'false' : 'true');
    b.classList.toggle('gv-unarmed', !on);
    if (on) {
      const original = titles.get(b);
      if (original) b.title = original;
      else b.removeAttribute('title');
    } else {
      b.title = ARMING_TEXT;
    }
  };

  const schedule = (): void => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (destroyed) return;
    const now = clock.now();
    const wait = armsIn(state, now, delay);
    // While it appears it is looked at often, so the end of its animation is not found at a press.
    const appearing = state.visibleSince !== null && now - state.visibleSince <= APPEAR_SETTLE_MS;
    const next = appearing ? Math.min(wait !== null && wait > 0 ? wait : APPEAR_POLL_MS, APPEAR_POLL_MS) : wait;
    if (next !== null && next > 0) timer = clock.setTimeout(onTimer, next);
  };

  const dispatch = (input: ArmInput): void => {
    state = armReduce(state, input);
  };

  const check = (): void => {
    if (destroyed) return;
    const now = clock.now();
    dispatch({ type: 'visible', visible: visibleNow(), now });
    if (state.visibleSince !== null) {
      const own = now - lastOwnScrollAt <= OWN_SCROLL_WINDOW_MS;
      dispatch({
        type: 'position',
        position: positionNow(),
        now,
        ...(own ? { creditMs: Math.max(0, delay - OWN_SCROLL_SETTLE_MS) } : {}),
      });
    }
    apply();
    schedule();
  };

  const onTimer = (): void => {
    timer = null;
    check();
  };

  const onPointerMove = (e: PointerEvent | MouseEvent): void => {
    // Only a real move counts: a card that appears under a resting cursor is not "pointed at".
    const moved =
      (typeof e.movementX === 'number' && e.movementX !== 0) ||
      (typeof e.movementY === 'number' && e.movementY !== 0) ||
      (lastPointer !== null && (lastPointer.x !== e.clientX || lastPointer.y !== e.clientY));
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!moved || destroyed) return;
    // Where the card is comes first: a pointer that moves now points at the card as it is now.
    const now = clock.now();
    dispatch({ type: 'visible', visible: visibleNow(), now });
    if (state.visibleSince !== null) dispatch({ type: 'position', position: positionNow(), now });
    if (!state.pointer) dispatch({ type: 'pointer', now });
    apply();
    schedule();
  };

  /** The person scrolls the card, or what holds it: the move that follows is their own. */
  const onOwnScroll = (): void => {
    lastOwnScrollAt = clock.now();
  };

  const onScroll = (e: Event): void => {
    const target = e.target as Node | null;
    // Only a scroll that carries the card with it.
    if (target && target !== doc && !target.contains(root)) return;
    check();
  };

  const onPointerLeave = (): void => {
    lastPointer = null;
  };

  /**
   * A mouse press is not pointing: a card that appeared under a resting cursor would otherwise
   * arm on the very click meant for what was there before. A touch or a pen has no resting
   * cursor, so putting it on the card counts as pointing at it.
   */
  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    if (state.pointer) return;
    dispatch({ type: 'pointer', now: clock.now() });
    check();
  };

  const onFocusIn = (): void => {
    const now = clock.now();
    // Only keyboard navigation moves focus "by the user"; a click focuses what it hits.
    const byUser = now - lastTabAt <= USER_FOCUS_WINDOW_MS;
    dispatch({ type: 'focus', inside: true, byUser, now });
    check();
  };

  const onFocusOut = (e: FocusEvent): void => {
    const next = e.relatedTarget as Node | null;
    if (next && root.contains(next)) return;
    dispatch({ type: 'focus', inside: false, byUser: false, now: clock.now() });
    check();
  };

  const onDocKey = (e: KeyboardEvent): void => {
    if (e.key === 'Tab') lastTabAt = clock.now();
  };

  const onVisibility = (): void => check();

  root.addEventListener('pointermove', onPointerMove as EventListener);
  root.addEventListener('pointerleave', onPointerLeave);
  root.addEventListener('pointerdown', onPointerDown as EventListener, true);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut as EventListener);
  doc.addEventListener('keydown', onDocKey as EventListener, true);
  doc.addEventListener('visibilitychange', onVisibility);
  root.addEventListener('wheel', onOwnScroll, { passive: true });
  root.addEventListener('touchmove', onOwnScroll, { passive: true });
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });

  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (!last) return;
      ioVisible = last.isIntersecting;
      check();
    });
    io.observe(root);
  }

  // The host attaches the card right after building it: look once it is in the page.
  let initial: unknown = clock.setTimeout(() => {
    initial = null;
    check();
  }, 0);

  return {
    isArmed(): boolean {
      check();
      return armed;
    },
    changed(key: string): void {
      dispatch({ type: 'content', key, now: clock.now() });
      check();
    },
    register(button: HTMLElement): void {
      if (button.title) titles.set(button, button.title);
      buttons.add(button);
      paint(button, armed);
    },
    guard<E extends Event>(fn: (event: E) => void): (event: E) => void {
      return (event: E) => {
        check();
        if (!armed) {
          event.preventDefault();
          const now = clock.now();
          const wait = armsIn(state, now, delay);
          if (wait === null) {
            // Nobody pointed at the card (it appeared under a resting cursor): the press was meant
            // for what was there before, and decides nothing. A real press is its person being
            // here, though: the wait starts now, and their next press decides. A key does not
            // count (a card that takes the focus stands next to text being typed).
            if (realPress(event)) {
              dispatch({ type: 'pressed', now });
              apply();
              schedule();
            }
            return;
          }
          // Too soon after the card changed to be an answer to it.
          if (wait > Math.max(0, delay - HOLD_FROM_MS)) return;
          // Only the short wait is missing: the press is kept and acts when it is over.
          dropHeld();
          const button = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
          button?.classList.add('gv-held');
          held = { run: () => fn(event), key: state.key, position: state.position, button };
          apply();
          schedule();
          return;
        }
        fn(event);
      };
    },
    check,
    destroy(): void {
      destroyed = true;
      dropHeld();
      if (timer !== null) clock.clearTimeout(timer);
      if (initial !== null) clock.clearTimeout(initial);
      timer = null;
      io?.disconnect();
      root.removeEventListener('pointermove', onPointerMove as EventListener);
      root.removeEventListener('pointerleave', onPointerLeave);
      root.removeEventListener('pointerdown', onPointerDown as EventListener, true);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut as EventListener);
      doc.removeEventListener('keydown', onDocKey as EventListener, true);
      doc.removeEventListener('visibilitychange', onVisibility);
      root.removeEventListener('wheel', onOwnScroll);
      root.removeEventListener('touchmove', onOwnScroll);
      doc.removeEventListener('scroll', onScroll, { capture: true });
      buttons.clear();
    },
  };
}
