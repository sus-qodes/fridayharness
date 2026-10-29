/**
 * What Blip shows (plan §7.9, handoff Part 02 §3 with Friday's conditions, ERRATA F27, F28): one
 * state chosen from the store by priority, and the look of each state (eyes, tint, badge, motion).
 * Pure: no DOM, no timers.
 */
import type { UiSnapshot } from '@friday/protocol';
import { waitsForHuman } from '../model/status.js';
import type { ReactionKind, RootState } from '../store/state.js';
import type { EyeShape } from './eyes.js';
import type { ParticleType } from './particles.js';

export type MascotState =
  | 'idle'
  | 'working'
  | 'thinking'
  | 'searching'
  | 'approval'
  | 'question'
  | 'error'
  | 'finished'
  | 'sleeping'
  | 'halted';

export const MASCOT_STATES: readonly MascotState[] = [
  'idle',
  'working',
  'thinking',
  'searching',
  'approval',
  'question',
  'error',
  'finished',
  'sleeping',
  'halted',
];

/** An agent's tool ran this recently: working. */
export const WORKING_MS = 3_000;
/** A failure this recent: error. */
export const ERROR_MS = 8_000;
/** A completion this recent: finished. */
export const FINISHED_MS = 4_000;
/** No activity for this long: asleep. */
export const SLEEP_AFTER_MS = 10 * 60_000;
/**
 * An approval or question reaction newer than the last snapshot shows at once, before the snapshot
 * that lists it is read (plan §7.2), for at most this long.
 */
export const UNREAD_MS = 5_000;
/** A reaction stamped this far in the future (clock skew) still counts as now. */
const SKEW_MS = 1_000;

/**
 * The order in which conditions win (plan §7.9). `paused` is sleeping while Friday is paused, which
 * outranks work; plain `sleeping` (inactivity, Friday stopped) is the last resort.
 */
export const PRIORITY = [
  'approval',
  'question',
  'error',
  'finished',
  'halted',
  'paused',
  'working',
  'thinking',
  'searching',
  'idle',
  'sleeping',
] as const;

export type Condition = (typeof PRIORITY)[number];

function within(at: number, now: number, windowMs: number): boolean {
  const age = now - at;
  return age >= -SKEW_MS && age < windowMs;
}

function recentReaction(state: RootState, kinds: readonly ReactionKind[], now: number, windowMs: number): boolean {
  return state.activity.reactions.some((r) => kinds.includes(r.kind) && within(r.at, now, windowMs));
}

/** An approval or question announced by the stream that the board has not caught up with yet. */
function unread(state: RootState, kinds: readonly ReactionKind[], now: number): boolean {
  const seen = state.system.snapshotAt;
  return state.activity.reactions.some((r) => kinds.includes(r.kind) && r.at > seen && within(r.at, now, UNREAD_MS));
}

function expiresAt(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function live(a: UiSnapshot['approvals'][number], now: number): boolean {
  if (a.status !== 'pending' || a.expired) return false;
  const exp = expiresAt(a.expires_at);
  return exp === null || exp > now;
}

/** Pending approvals that have not expired (the row's flag, and the client's own clock, plan §2). */
export function pendingApprovals(board: UiSnapshot | null, now: number): number {
  return board ? board.approvals.filter((a) => live(a, now)).length : 0;
}

/** The first approval that waits, if any. */
export function firstPendingApproval(board: UiSnapshot | null, now: number): UiSnapshot['approvals'][number] | null {
  return board?.approvals.find((a) => live(a, now)) ?? null;
}

function questionWaits(board: UiSnapshot | null): boolean {
  if (!board) return false;
  return board.escalations.some((e) => e.status === 'pending') || board.tasks.some((t) => waitsForHuman(t));
}

function agentWorking(state: RootState, now: number): boolean {
  for (const agent of Object.values(state.activity.agents)) {
    const at = agent?.current?.at;
    if (typeof at === 'number' && within(at, now, WORKING_MS)) return true;
  }
  return false;
}

/** The last moment anything happened that Blip knows of (0: nothing yet). */
export function lastActive(state: RootState): number {
  return Math.max(state.activity.lastActivityAt || 0, state.system.snapshotAt || 0);
}

function inactive(state: RootState, now: number): boolean {
  const last = lastActive(state);
  return last > 0 && now - last >= SLEEP_AFTER_MS;
}

/** Every condition that holds now, in priority order (the first one wins). */
export function conditions(state: RootState, now: number): Condition[] {
  const board = state.board;
  const connection = state.system.connection;
  const control = board?.control;
  const held: Condition[] = [];
  if (pendingApprovals(board, now) > 0 || unread(state, ['approval'], now)) held.push('approval');
  if (questionWaits(board) || unread(state, ['question', 'plan'], now)) held.push('question');
  if (recentReaction(state, ['failed', 'lost'], now, ERROR_MS) || connection === 'reconnecting') held.push('error');
  if (recentReaction(state, ['completed', 'goal-completed'], now, FINISHED_MS)) held.push('finished');
  if (control?.paused && control.halted_at) held.push('halted');
  else if (control?.paused) held.push('paused');
  if (agentWorking(state, now)) held.push('working');
  if (board?.brain_jobs.some((j) => j.status === 'calling')) held.push('thinking');
  if (state.ui.indexing) held.push('searching');
  if (connection === 'stopped' || connection === 'signed-out' || inactive(state, now)) held.push('sleeping');
  else held.push('idle');
  return held.sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b));
}

function toState(c: Condition): MascotState {
  return c === 'paused' ? 'sleeping' : c;
}

/** The state Blip shows now. */
export function selectState(state: RootState, now: number): MascotState {
  const first = conditions(state, now)[0];
  return first ? toState(first) : 'idle';
}

/**
 * The next moment a time-bound condition can change on its own (a reaction ages out, an approval
 * expires, inactivity turns into sleep), so the caller re-checks then; null when nothing is due.
 */
export function nextChangeAt(state: RootState, now: number): number | null {
  let next = Number.POSITIVE_INFINITY;
  const consider = (t: number) => {
    if (t > now && t < next) next = t;
  };
  for (const r of state.activity.reactions) {
    if (r.kind === 'failed' || r.kind === 'lost') consider(r.at + ERROR_MS);
    else if (r.kind === 'completed' || r.kind === 'goal-completed') consider(r.at + FINISHED_MS);
    else if ((r.kind === 'approval' || r.kind === 'question' || r.kind === 'plan') && r.at > state.system.snapshotAt)
      consider(r.at + UNREAD_MS);
  }
  for (const agent of Object.values(state.activity.agents)) {
    const at = agent?.current?.at;
    if (typeof at === 'number') consider(at + WORKING_MS);
  }
  for (const a of state.board?.approvals ?? []) {
    const exp = live(a, now) ? expiresAt(a.expires_at) : null;
    if (exp !== null) consider(exp);
  }
  const last = lastActive(state);
  if (last > 0) consider(last + SLEEP_AFTER_MS);
  return Number.isFinite(next) ? next : null;
}

// ---------------------------------------------------------------------------------------------
// Looks

/** A colour token of `styles/tokens.css`. */
export type TintToken =
  | '--color-slate-200'
  | '--color-neon-blue'
  | '--color-violet'
  | '--color-indigo'
  | '--color-amber'
  | '--color-cyan'
  | '--color-crimson'
  | '--color-emerald'
  | '--color-slate-500';

export type Badge = 'bang' | 'question' | 'dots';

/** Where the eyes look: the pointer, or a fixed or scanning gaze of the state. */
export type GazeMode = 'pointer' | 'forward' | 'up-right' | 'scan' | 'down' | 'centre';

export interface StateMotion {
  /** Breathing: a vertical scale oscillation. */
  breathHz: number;
  breathAmp: number;
  /** A vertical bob (design px); `bounce` keeps it above the rest position. */
  bobHz: number;
  bobAmp: number;
  bobShape: 'sine' | 'bounce';
  /** A constant head tilt (radians) and a rhythmic one. */
  tilt: number;
  tiltHz: number;
  tiltAmp: number;
  gaze: GazeMode;
  /** A held squash: < 1 droops (error), much less flattens (halted). */
  scaleY: number;
  scaleX: number;
  /** A held drop (design px, down positive). */
  drop: number;
  /** Particles the state emits while its motion runs. */
  emit: { type: ParticleType; everyS: number } | null;
  /** The antenna light's pulse (0: steady). */
  pulseHz: number;
  /** LED brightness 0..1. */
  led: number;
  /** Seconds the looping motion runs after the last stimulus before Blip holds still. */
  ambientS: number;
}

export interface StateLook {
  eyes: EyeShape;
  tint: TintToken;
  badge: Badge | null;
  /** Whether Blip blinks in this state. */
  blinks: boolean;
  motion: StateMotion;
  /** What the state means, for the accessible name. */
  description: string;
}

const STILL: StateMotion = {
  breathHz: 0.4,
  breathAmp: 0.018,
  bobHz: 0,
  bobAmp: 0,
  bobShape: 'sine',
  tilt: 0,
  tiltHz: 0,
  tiltAmp: 0,
  gaze: 'pointer',
  scaleY: 1,
  scaleX: 1,
  drop: 0,
  emit: null,
  pulseHz: 0,
  led: 1,
  ambientS: 8,
};

function motion(m: Partial<StateMotion>): StateMotion {
  return Object.freeze({ ...STILL, ...m });
}

export const STATE_LOOK: Readonly<Record<MascotState, StateLook>> = Object.freeze({
  idle: {
    eyes: 'pill',
    tint: '--color-slate-200',
    badge: null,
    blinks: true,
    motion: motion({}),
    description: 'Friday is idle',
  },
  working: {
    eyes: 'pill',
    tint: '--color-neon-blue',
    badge: 'dots',
    blinks: true,
    motion: motion({ gaze: 'forward', bobHz: 2.4, bobAmp: 0.9, pulseHz: 2, ambientS: 6 }),
    description: 'An agent is working',
  },
  thinking: {
    eyes: 'pill',
    tint: '--color-violet',
    badge: 'dots',
    blinks: true,
    motion: motion({ gaze: 'up-right', tiltHz: 0.5, tiltAmp: 0.08, pulseHz: 1, ambientS: 30 }),
    description: 'The Master Brain is planning',
  },
  searching: {
    eyes: 'pill',
    tint: '--color-indigo',
    badge: 'dots',
    blinks: false,
    motion: motion({ gaze: 'scan', pulseHz: 1.2, ambientS: 30 }),
    description: 'Friday is indexing the code graph',
  },
  approval: {
    eyes: 'wide',
    tint: '--color-amber',
    badge: 'bang',
    blinks: true,
    motion: motion({ gaze: 'down', bobHz: 1.6, bobAmp: 2.2, bobShape: 'bounce', pulseHz: 1.6, ambientS: 30 }),
    description: 'An approval waits for you',
  },
  question: {
    eyes: 'pill',
    tint: '--color-cyan',
    badge: 'question',
    blinks: true,
    motion: motion({ tilt: 0.17, tiltHz: 0.6, tiltAmp: 0.03, pulseHz: 0.8, ambientS: 30 }),
    description: 'A question waits for you',
  },
  error: {
    eyes: 'tired',
    tint: '--color-crimson',
    badge: null,
    blinks: true,
    motion: motion({
      gaze: 'down',
      scaleY: 0.92,
      scaleX: 1.03,
      drop: 1.5,
      emit: { type: 'sweat', everyS: 1.4 },
      ambientS: 8,
    }),
    description: 'Something failed',
  },
  finished: {
    eyes: 'happy',
    tint: '--color-emerald',
    badge: null,
    blinks: false,
    motion: motion({ breathHz: 0.8, breathAmp: 0.025, ambientS: 4 }),
    description: 'Work finished',
  },
  sleeping: {
    eyes: 'closed',
    tint: '--color-slate-500',
    badge: null,
    blinks: false,
    motion: motion({
      breathHz: 0.2,
      breathAmp: 0.03,
      gaze: 'centre',
      drop: 1,
      emit: { type: 'z', everyS: 1.8 },
      led: 0.55,
      ambientS: 20,
    }),
    description: 'Friday is resting',
  },
  halted: {
    eyes: 'x',
    tint: '--color-crimson',
    badge: null,
    blinks: false,
    motion: motion({ breathAmp: 0, gaze: 'centre', scaleY: 0.72, scaleX: 1.14, drop: 7, led: 0.7, ambientS: 0 }),
    description: 'Friday is halted',
  },
});

/** The accessible description of what Blip shows (paused is said as such). */
export function describe(state: MascotState, root: Pick<RootState, 'board'>): string {
  if (state === 'sleeping' && root.board?.control.paused) return 'Friday is paused';
  return STATE_LOOK[state].description;
}
