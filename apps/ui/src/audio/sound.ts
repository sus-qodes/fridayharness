/**
 * When Friday makes a sound (plan §7.2, §7.10): approvals, questions, proposed plans and blocked
 * agents chime `escalation_alert`; an approval granted here plays `allow_success`; a completed task
 * or goal plays `task_complete`; new tasks and goals play `node_appear` at most once per snapshot
 * that added nodes (and once per 1.5 s); a halt plays `emergency_halt`. Tool calls play nothing
 * (ERRATA F33). Mute and volume follow the preferences. Reactions are consumed by id.
 *
 * One synth serves the page. In a browser its context starts on the first gesture; the desktop
 * Notch window creates it at load (`initAudio({ atLoad: true })`). Only the window that calls
 * `startSound` plays anything, so the desktop Studio window stays silent.
 */
import type { UiSnapshot } from '@friday/protocol';
import type { AppContext } from '../shell/context.js';
import type { ReactionKind, RootState } from '../store/state.js';
import { type SoundName, Synth, WAV_SOUND_NAMES } from './synth.js';

/** A sound of a kind plays at most this often. */
// The character sounds have no gap of their own: each plays when its moment comes.
export const MIN_GAP_MS: Readonly<Record<SoundName, number>> = Object.freeze({
  ...(Object.fromEntries(WAV_SOUND_NAMES.map((n) => [n, 0])) as Record<(typeof WAV_SOUND_NAMES)[number], number>),
  node_appear: 1_500,
  escalation_alert: 1_000,
  allow_success: 250,
  task_complete: 800,
  emergency_halt: 1_000,
  click_tick: 40,
});

/** The sound a reaction plays, if any. */
export function soundFor(kind: ReactionKind): SoundName | null {
  switch (kind) {
    case 'approval':
    case 'question':
    case 'plan':
      return 'escalation_alert';
    case 'approved':
      return 'allow_success';
    case 'completed':
    case 'goal-completed':
      return 'task_complete';
    case 'node':
      return 'node_appear';
    case 'halt':
      return 'emergency_halt';
    default:
      return null;
  }
}

/** Lets each sound through at most once per its gap. */
export class RateLimiter {
  readonly #last = new Map<SoundName, number>();

  allow(name: SoundName, now: number): boolean {
    const last = this.#last.get(name);
    if (last !== undefined && now - last < MIN_GAP_MS[name] && now >= last) return false;
    this.#last.set(name, now);
    return true;
  }
}

/**
 * `node_appear` belongs to the snapshot that shows the new nodes: a burst of `task.created` events
 * (a plan of twenty tasks) chimes once. A node reaction waits for a snapshot that added nodes (or
 * matches one that just did); the limiter keeps it to once per 1.5 s.
 */
export class NodeSoundGate {
  /** A node reaction that has not met its snapshot yet. */
  #pendingAt: number | null = null;
  /** The last snapshot that added nodes, and whether it has chimed. */
  #addedAt: number | null = null;
  #sounded = true;

  /** How long a node reaction waits for its snapshot, and how recent a snapshot it may match. */
  static readonly WAIT_MS = 3_000;
  static readonly MATCH_MS = 1_000;

  /** A node reaction arrived; true when it should chime now. */
  reaction(now: number): boolean {
    if (this.#addedAt !== null && !this.#sounded && now - this.#addedAt <= NodeSoundGate.MATCH_MS) {
      this.#sounded = true;
      return true;
    }
    this.#pendingAt = now;
    return false;
  }

  /** A snapshot arrived that added `added` tasks and goals; true when it should chime now. */
  snapshot(added: number, now: number): boolean {
    if (!(added > 0)) return false;
    this.#addedAt = now;
    this.#sounded = false;
    if (this.#pendingAt !== null && now - this.#pendingAt <= NodeSoundGate.WAIT_MS) {
      this.#pendingAt = null;
      this.#sounded = true;
      return true;
    }
    return false;
  }
}

/** Tasks and goals in `next` that `prev` did not have (0 for the first snapshot). */
export function addedNodes(prev: UiSnapshot | null, next: UiSnapshot | null): number {
  if (!prev || !next) return 0;
  const known = new Set<string>();
  for (const t of prev.tasks) known.add(t.task_id);
  for (const g of prev.goals) known.add(g.goal_id);
  let n = 0;
  for (const t of next.tasks) if (!known.has(t.task_id)) n++;
  for (const g of next.goals) if (!known.has(g.goal_id)) n++;
  return n;
}

/** Tasks that became WAITING(blocked) in `next` (a spawned agent stopped for a human, plan §2). */
export function newlyBlocked(prev: UiSnapshot | null, next: UiSnapshot | null): number {
  if (!prev || !next) return 0;
  const before = new Set(
    prev.tasks.filter((t) => t.status === 'WAITING' && t.waiting_reason === 'blocked').map((t) => t.task_id),
  );
  return next.tasks.filter((t) => t.status === 'WAITING' && t.waiting_reason === 'blocked' && !before.has(t.task_id))
    .length;
}

// ---------------------------------------------------------------------------------------------
// The page's synth

let shared: Synth | null = null;
/** How many `startSound` are running: sounds play only while one is. */
let active = 0;
let gestureTarget: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = null;
let gestureSynth: Synth | null = null;

function synth(): Synth {
  if (!shared) shared = new Synth();
  return shared;
}

/** Each gesture creates or resumes the context; once it runs (or cannot exist) the listeners go. */
function onGesture(): void {
  const s = gestureSynth;
  if (!s?.init() || s.running) stopListening();
}

function stopListening(): void {
  if (!gestureTarget) return;
  gestureTarget.removeEventListener('pointerdown', onGesture, true);
  gestureTarget.removeEventListener('keydown', onGesture, true);
  gestureTarget = null;
  gestureSynth = null;
}

/**
 * Prepares the audio context: in a browser on the first pointer or key press (pages may not start
 * audio before one), with `atLoad` (the desktop Notch window) at once. A context the page left
 * suspended is resumed by the next gesture.
 */
export function initAudio(opts: { atLoad?: boolean } = {}): void {
  initAudioWith(synth(), opts, typeof window !== 'undefined' ? window : null);
}

export function initAudioWith(
  s: Synth,
  opts: { atLoad?: boolean },
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null,
): void {
  if (opts.atLoad && !s.init()) return;
  if (s.running || !target || gestureTarget) return;
  gestureTarget = target;
  gestureSynth = s;
  target.addEventListener('pointerdown', onGesture, true);
  target.addEventListener('keydown', onGesture, true);
}

/** Plays a sound now (when sound is on and a `startSound` runs, or when force is requested); false otherwise. */
export function playSound(name: SoundName, opts: { force?: boolean } = {}): boolean {
  if (active === 0 && !opts.force) return false;
  const s = synth();
  if (!s.ready) s.init();
  return s.play(name);
}

const tickLimiter = new RateLimiter();

/** The short tick other areas play (the canvas's zoom snap, plan §7.10). */
export function clickTick(): void {
  if (active === 0) return;
  if (tickLimiter.allow('click_tick', Date.now())) synth().play('click_tick');
}

/** Starts the sounds for this window; returns the function that stops them. */
export function startSound(ctx: AppContext): () => void {
  return startSoundWith(ctx, synth());
}

export function startSoundWith(ctx: Pick<AppContext, 'store' | 'now'>, s: Synth): () => void {
  const { store } = ctx;
  const limiter = new RateLimiter();
  const gate = new NodeSoundGate();
  const max = (state: Readonly<RootState>) => state.activity.reactions.reduce((m, r) => Math.max(m, r.id), 0);
  let lastReaction = max(store.getState());
  let stopped = false;

  const applyPrefs = () => {
    const p = store.select('prefs');
    s.setMuted(p.muted);
    s.setVolume(p.volume);
  };
  applyPrefs();
  active++;

  const play = (name: SoundName, now: number) => {
    if (limiter.allow(name, now)) s.play(name);
  };

  const unsubs = [
    store.subscribe('prefs', (next, prev) => {
      if (next.muted !== prev.muted || next.volume !== prev.volume) applyPrefs();
    }),
    store.subscribe('activity', (next) => {
      const fresh = next.reactions.filter((r) => r.id > lastReaction).sort((a, b) => a.id - b.id);
      if (!fresh.length) return;
      const now = ctx.now();
      for (const r of fresh) {
        lastReaction = r.id;
        // A new agent is a card appearing, not a decision granted.
        const name = r.kind === 'approved' && r.label === 'agent' ? 'node_appear' : soundFor(r.kind);
        if (!name) continue;
        if (name === 'node_appear') {
          if (gate.reaction(now)) play(name, now);
        } else play(name, now);
      }
    }),
    store.subscribe('board', (next, prev) => {
      const now = ctx.now();
      if (gate.snapshot(addedNodes(prev, next), now)) play('node_appear', now);
      if (newlyBlocked(prev, next) > 0) play('escalation_alert', now);
    }),
  ];

  return () => {
    if (stopped) return;
    stopped = true;
    active = Math.max(0, active - 1);
    for (const u of unsubs) u();
  };
}

/** Tests only: forgets the page's synth and listeners. */
export function resetSoundForTests(next: Synth | null = null): void {
  stopListening();
  shared = next;
  active = 0;
}
