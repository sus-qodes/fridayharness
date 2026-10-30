/**
 * Connects the store to the mascot.s engine (plan §7.9): picks the state on every change (and again when
 * a time-bound condition runs out), plays reactions once each (consumed by id: the highest handled
 * id is kept, only newer ones play), notices newly registered agents, and follows the motion and
 * outfit preferences.
 */
import type { AppContext } from '../shell/context.js';
import type { ReactionKind, RootState } from '../store/state.js';
import type { Palette } from './character.js';
import type { Gesture, MascotEngine } from './engine.js';
import { type MascotState, nextChangeAt, STATE_LOOK, selectState } from './states.js';

/** A reaction from the store, a click on the mascot, or an agent that just registered. */
export type MascotReaction = ReactionKind | 'click' | 'agent';

/** What the mascot does for a reaction (plan §7.9; ERRATA F27 maps Part 06's moods to these). */
export function gestureFor(kind: MascotReaction): Gesture | null {
  switch (kind) {
    case 'click':
      return 'wink';
    case 'node':
      return 'bounce';
    case 'agent':
    case 'approved':
      return 'hop';
    case 'denied':
      return 'droop';
    case 'completed':
      return 'jump';
    case 'goal-completed':
      return 'celebrate';
    case 'failed':
    case 'lost':
      return 'sweat';
    case 'approval':
    case 'question':
    case 'plan':
      return 'alert';
    case 'halt':
      return null;
    default:
      return null;
  }
}

/** True when motion should become fades: the setting, then the system (plan §6.6). */
export function prefersReducedMotion(
  motion: RootState['prefs']['motion'],
  matchMedia?: ((query: string) => { matches: boolean } | null) | null,
): boolean {
  if (motion === 'reduce') return true;
  if (motion === 'full') return false;
  try {
    return Boolean(matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

export interface ControllerEnv {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  matchMedia?: ((query: string) => MediaQueryList | null) | null;
}

/** Re-checks never wait longer than this (a coarse guard against clock jumps). */
const MAX_WAIT_MS = 60_000;

function maxReactionId(state: Readonly<RootState>): number {
  let max = 0;
  for (const r of state.activity.reactions) if (r.id > max) max = r.id;
  return max;
}

export class MascotController {
  #lastReaction: number;
  #harnesses: Set<string> | null = null;
  #timer: unknown = null;
  #unsubs: (() => void)[] = [];
  #state: MascotState = 'idle';
  #media: MediaQueryList | null = null;
  readonly #onMedia = () => this.#motion();

  constructor(
    private readonly ctx: Pick<AppContext, 'store' | 'now'>,
    private readonly engine: MascotEngine,
    private readonly palette: Palette,
    /** Called whenever the mascot has something new to show (the loop wakes). */
    private readonly changed: () => void,
    private readonly env: ControllerEnv,
  ) {
    const state = ctx.store.getState();
    // Reactions from before the mascot was mounted are history, not news.
    this.#lastReaction = maxReactionId(state);
    if (state.board) this.#harnesses = new Set(state.board.harnesses.map((h) => h.harness_id));
  }

  get state(): MascotState {
    return this.#state;
  }

  start(): void {
    const { store } = this.ctx;
    this.#motion();
    try {
      this.#media = this.env.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
      this.#media?.addEventListener?.('change', this.#onMedia);
    } catch {
      this.#media = null;
    }
    this.#unsubs.push(
      store.subscribe('board', (next) => {
        this.#agents(next);
        this.update();
      }),
      store.subscribe('activity', () => {
        this.#reactions();
        this.update();
      }),
      store.subscribe('system', () => this.update()),
      store.subscribe('ui', (next, prev) => {
        if (next.indexing !== prev.indexing) this.update();
      }),
      store.subscribe('prefs', (next, prev) => {
        if (next.motion !== prev.motion) this.#motion();
        if (next.outfit !== prev.outfit) this.changed();
      }),
    );
    this.update();
    this.engine.snapTint();
    this.changed();
  }

  /** Picks the state for now and schedules the next re-check. */
  update(): void {
    const now = this.ctx.now();
    const root = this.ctx.store.getState();
    const state = selectState(root, now);
    const tint = this.palette.tints[STATE_LOOK[state].tint];
    if (tint) this.engine.setTint(tint);
    if (state !== this.#state || this.engine.state !== state) {
      this.#state = state;
      this.engine.setState(state);
      this.changed();
    }
    this.#schedule(nextChangeAt(root, now), now);
  }

  /** A click (or Enter/Space) on an interactive mascot. */
  click(): void {
    this.react('click');
  }

  react(kind: MascotReaction): void {
    const g = gestureFor(kind);
    if (!g) return;
    this.engine.gesture(g);
    this.changed();
  }

  destroy(): void {
    for (const u of this.#unsubs.splice(0)) u();
    if (this.#timer !== null) this.env.clearTimeout(this.#timer);
    this.#timer = null;
    try {
      this.#media?.removeEventListener?.('change', this.#onMedia);
    } catch {
      // nothing to undo
    }
    this.#media = null;
  }

  #schedule(at: number | null, now: number): void {
    if (this.#timer !== null) this.env.clearTimeout(this.#timer);
    this.#timer = null;
    if (at === null) return;
    const wait = Math.min(MAX_WAIT_MS, Math.max(50, at - now + 5));
    this.#timer = this.env.setTimeout(() => {
      this.#timer = null;
      this.update();
    }, wait);
  }

  #reactions(): void {
    const list = this.ctx.store.select('activity').reactions;
    const fresh = list.filter((r) => r.id > this.#lastReaction).sort((a, b) => a.id - b.id);
    for (const r of fresh) {
      this.#lastReaction = r.id;
      this.react(r.kind);
    }
  }

  #agents(board: RootState['board']): void {
    if (!board) return;
    const ids = new Set(board.harnesses.map((h) => h.harness_id));
    const known = this.#harnesses;
    this.#harnesses = ids;
    // The first snapshot only sets what is known; later ones greet newcomers.
    if (!known) return;
    for (const id of ids) {
      if (!known.has(id)) {
        this.react('agent');
        break;
      }
    }
  }

  #motion(): void {
    const reduced = prefersReducedMotion(this.ctx.store.select('prefs').motion, this.env.matchMedia);
    if (reduced !== this.engine.reduced) {
      this.engine.setReduced(reduced);
      this.changed();
    }
  }
}
