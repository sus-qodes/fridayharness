/**
 * Decisions are bound to what was shown (plan FD-28, LESSONS UI-37). A card's decision controls
 * arm only after the card has been visible and unchanged for 700 ms **and** the pointer has moved
 * onto it (or the user moved focus into it); any change of content or position re-arms them.
 * Cards open under a resting cursor and next to text fields, so neither a click that was meant for
 * what was there before nor a stray key can decide.
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
  | { type: 'position'; position: string; now: number }
  | { type: 'pointer'; now: number }
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
      return { ...s, position: input.position, changedAt: input.now, pointer: false };
    case 'pointer':
      return s.pointer ? s : { ...s, pointer: true };
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
  let destroyed = false;
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
    if (opts.hint) opts.hint.textContent = next ? '' : ARMING_TEXT;
    if (next !== armed) {
      armed = next;
      opts.onChange?.(armed);
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
    const wait = armsIn(state, clock.now(), delay);
    if (wait !== null && wait > 0) timer = clock.setTimeout(onTimer, wait);
  };

  const dispatch = (input: ArmInput): void => {
    state = armReduce(state, input);
  };

  const check = (): void => {
    if (destroyed) return;
    const now = clock.now();
    dispatch({ type: 'visible', visible: visibleNow(), now });
    if (state.visibleSince !== null) dispatch({ type: 'position', position: positionNow(), now });
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
    if (!moved || state.pointer) return;
    dispatch({ type: 'pointer', now: clock.now() });
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
          return;
        }
        fn(event);
      };
    },
    check,
    destroy(): void {
      destroyed = true;
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
      buttons.clear();
    },
  };
}
