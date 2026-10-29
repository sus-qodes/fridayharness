/**
 * Blip's motion (plan §7.9, handoff Part 02 §2.2, §5, §6). Pure: no DOM and no timers; the
 * mascot's frame loop calls `tick` with the time since the last frame and draws `pose()`.
 *
 * - Physics steps take `dt = min(0.05, Δ)`; springs are sub-stepped at 1/240 s with the left-over
 *   time carried to the next call, so motion is the same at any frame rate.
 * - Smoothing that ignores frame rate: `x += (t − x)(1 − c^dt)`.
 * - Blinks are scheduled 3–6 s apart, sometimes doubled.
 * - Gaze comes from the pointer, clamped to yaw ±0.85 and pitch ±0.65 (Part 02 §2.2), or from the
 *   state (a fixed look, a scan).
 * - Tweens are channels of keys (target, duration, easing); a newer animation on a channel replaces
 *   the older one. Every channel is an offset that returns to 0.
 * - `busy` says whether another frame is needed; `nextWakeIn` when the next blink is due.
 *
 * Units are design pixels of the 96 × 96 grid Blip is drawn on; y grows downward, except `lift`,
 * which is upward like Part 02's jump.
 */
import { EYE_SHAPES, EYES, type EyeShape } from './eyes.js';
import type { Rgb } from './geometry.js';
import { addParticles, confetti, hearts, type Particle, snooze, sparks, stepParticles, sweat } from './particles.js';
import { type Badge, type MascotState, STATE_LOOK, type StateLook } from './states.js';

export const MAX_DT = 0.05;
export const SUBSTEP = 1 / 240;
export const YAW_LIMIT = 0.85;
export const PITCH_LIMIT = 0.65;
/** The pointer distance (CSS px) over which the eyes turn fully (Part 02 §2.2's D_screen). */
export const GAZE_DISTANCE = 320;
/** Blinks come this many seconds apart. */
export const BLINK_MIN_S = 3;
export const BLINK_MAX_S = 6;
/** The chance that a blink is a quick double blink. */
export const DOUBLE_BLINK = 0.25;

/** Smoothing constants: the fraction left after one second. */
const C_GAZE = 0.0005;
const C_BODY = 0.004;
const C_COLOR = 0.01;
const SETTLE = 0.002;

export function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(hi, Math.max(lo, value));
}

/** One frame of frame-rate-independent smoothing toward `target`. */
export function smooth(x: number, target: number, c: number, dt: number): number {
  if (!Number.isFinite(target)) return Number.isFinite(x) ? x : 0;
  if (!Number.isFinite(x)) return target;
  if (!(dt > 0)) return x;
  const next = x + (target - x) * (1 - c ** dt);
  return Math.abs(target - next) < SETTLE ? target : next;
}

/** The gaze a pointer offset (CSS px from Blip's centre) asks for. */
export function gazeFromPointer(dx: number, dy: number, distance = GAZE_DISTANCE): { yaw: number; pitch: number } {
  return {
    yaw: clamp(dx / distance, -YAW_LIMIT, YAW_LIMIT),
    pitch: clamp(dy / distance, -PITCH_LIMIT, PITCH_LIMIT),
  };
}

// ---------------------------------------------------------------------------------------------
// Springs

export interface SpringConfig {
  stiffness: number;
  damping: number;
}

/** A damped spring, `a = −k(x − target) − c·v + force`, semi-implicit Euler at 1/240 s. */
export class Spring {
  x: number;
  v = 0;
  target: number;
  #carry = 0;

  constructor(
    initial = 0,
    readonly config: SpringConfig = { stiffness: 180, damping: 12 },
  ) {
    this.x = Number.isFinite(initial) ? initial : 0;
    this.target = this.x;
  }

  get settled(): boolean {
    return this.x === this.target && this.v === 0;
  }

  /** Advances by `dt` seconds under an extra acceleration `force`. */
  step(dt: number, force = 0): void {
    if (!(dt > 0)) return;
    const f = Number.isFinite(force) ? force : 0;
    let time = this.#carry + Math.min(dt, MAX_DT);
    const { stiffness: k, damping: c } = this.config;
    while (time >= SUBSTEP - 1e-9) {
      const a = -k * (this.x - this.target) - c * this.v + f;
      this.v += a * SUBSTEP;
      this.x += this.v * SUBSTEP;
      time -= SUBSTEP;
    }
    this.#carry = Math.max(0, time);
    if (!Number.isFinite(this.x) || !Number.isFinite(this.v)) this.snap();
    else if (f === 0 && Math.abs(this.x - this.target) < 0.01 && Math.abs(this.v) < 0.05) this.snap();
  }

  snap(): void {
    this.x = this.target;
    this.v = 0;
    this.#carry = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Tweens

export type Easing = (t: number) => number;

export const Ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => t * (2 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  outBack: (t: number) => {
    const s = 1.70158;
    const u = t - 1;
    return u * u * ((s + 1) * u + s) + 1;
  },
  outElastic: (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1;
  },
  outBounce: (t: number) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t - 1.5 / d) ** 2 + 0.75;
    if (t < 2.5 / d) return n * (t - 2.25 / d) ** 2 + 0.9375;
    return n * (t - 2.625 / d) ** 2 + 0.984375;
  },
} satisfies Record<string, Easing>;

export interface TweenKey {
  target: number;
  durationMs: number;
  ease: Easing;
}

/** Offsets Blip's tweens drive; each rests at 0. */
export type Channel = 'lift' | 'scaleX' | 'scaleY' | 'tilt' | 'blush' | 'blink' | 'glow';

/** Part 02 §6: the jump on completion (design px, up positive). */
export const JUMP_TWEEN: readonly TweenKey[] = Object.freeze([
  { target: -4, durationMs: 120, ease: Ease.inQuad },
  { target: 28, durationMs: 240, ease: Ease.outQuad },
  { target: 26, durationMs: 80, ease: Ease.linear },
  { target: -6, durationMs: 180, ease: Ease.inQuad },
  { target: 0, durationMs: 160, ease: Ease.outElastic },
]);

/** The squash and stretch that go with the jump. */
const JUMP_SQUASH: readonly TweenKey[] = [
  { target: -0.1, durationMs: 120, ease: Ease.inQuad },
  { target: 0.08, durationMs: 240, ease: Ease.outQuad },
  { target: 0, durationMs: 80, ease: Ease.linear },
  { target: -0.12, durationMs: 180, ease: Ease.inQuad },
  { target: 0, durationMs: 160, ease: Ease.outElastic },
];

/** A 400 ms excited bounce (a new task or goal). */
export const BOUNCE_TWEEN: readonly TweenKey[] = Object.freeze([
  { target: 7, durationMs: 110, ease: Ease.outQuad },
  { target: 0, durationMs: 110, ease: Ease.inQuad },
  { target: 3.5, durationMs: 80, ease: Ease.outQuad },
  { target: 0, durationMs: 100, ease: Ease.inQuad },
]);

/** A happy hop (an agent arrived, an approval granted). */
export const HOP_TWEEN: readonly TweenKey[] = Object.freeze([
  { target: -2, durationMs: 80, ease: Ease.inQuad },
  { target: 12, durationMs: 170, ease: Ease.outQuad },
  { target: 0, durationMs: 330, ease: Ease.outBounce },
]);

/** A tired droop (a denial). */
export const DROOP_TWEEN: readonly TweenKey[] = Object.freeze([
  { target: -5, durationMs: 220, ease: Ease.outQuad },
  { target: -5, durationMs: 380, ease: Ease.linear },
  { target: 0, durationMs: 420, ease: Ease.inOutQuad },
]);

/** A small alert bounce (an approval or question arrived). */
const ALERT_TWEEN: readonly TweenKey[] = [
  { target: 4, durationMs: 90, ease: Ease.outQuad },
  { target: 0, durationMs: 160, ease: Ease.outBounce },
];

const BLINK_SINGLE: readonly TweenKey[] = [
  { target: 1, durationMs: 70, ease: Ease.inQuad },
  { target: 0, durationMs: 110, ease: Ease.outQuad },
];

const BLINK_DOUBLE: readonly TweenKey[] = [
  ...BLINK_SINGLE,
  { target: 0, durationMs: 60, ease: Ease.linear },
  ...BLINK_SINGLE,
];

/** Reduced motion: reactions become a fade of the glow, never movement. */
const FLASH_TWEEN: readonly TweenKey[] = [
  { target: 1, durationMs: 160, ease: Ease.outQuad },
  { target: 0, durationMs: 520, ease: Ease.inOutQuad },
];

interface ChannelTween {
  keys: readonly TweenKey[];
  index: number;
  elapsed: number;
  from: number;
  value: number;
  onComplete?: () => void;
}

/** A timeline of channels; each key starts from the previous key's target. */
export class Timeline {
  readonly #channels = new Map<Channel, ChannelTween>();

  /** Starts `keys` on `channel` from its current value, replacing what ran there. */
  play(channel: Channel, keys: readonly TweenKey[], onComplete?: () => void): void {
    const from = this.value(channel);
    if (!keys.length) {
      this.#channels.delete(channel);
      return;
    }
    this.#channels.set(channel, {
      keys,
      index: 0,
      elapsed: 0,
      from,
      value: from,
      ...(onComplete ? { onComplete } : {}),
    });
  }

  value(channel: Channel): number {
    return this.#channels.get(channel)?.value ?? 0;
  }

  running(channel: Channel): boolean {
    return this.#channels.has(channel);
  }

  get active(): boolean {
    return this.#channels.size > 0;
  }

  step(dt: number): void {
    if (!(dt > 0)) return;
    const done: ChannelTween[] = [];
    for (const [channel, tw] of this.#channels) {
      let left = dt * 1000;
      while (left > 0 && tw.index < tw.keys.length) {
        const key = tw.keys[tw.index] as TweenKey;
        const need = Math.max(0, key.durationMs - tw.elapsed);
        if (left >= need) {
          left -= need;
          tw.from = key.target;
          tw.value = key.target;
          tw.index++;
          tw.elapsed = 0;
        } else {
          tw.elapsed += left;
          left = 0;
          const f = key.durationMs > 0 ? tw.elapsed / key.durationMs : 1;
          const eased = key.ease(Math.min(1, Math.max(0, f)));
          tw.value = tw.from + (key.target - tw.from) * (Number.isFinite(eased) ? eased : 1);
        }
      }
      if (tw.index >= tw.keys.length) {
        this.#channels.delete(channel);
        done.push(tw);
      }
    }
    for (const tw of done) tw.onComplete?.();
  }

  /** Ends every tween at its final value (they all rest at 0). */
  finish(): void {
    const done = [...this.#channels.values()];
    this.#channels.clear();
    for (const tw of done) tw.onComplete?.();
  }
}

// ---------------------------------------------------------------------------------------------
// Blinks

export type Random = () => number;

/** A small seeded generator (mulberry32) for tests and reproducible motion. */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class BlinkScheduler {
  next: number;

  constructor(
    readonly random: Random,
    now = 0,
  ) {
    this.next = now + this.interval();
  }

  interval(): number {
    return BLINK_MIN_S + (BLINK_MAX_S - BLINK_MIN_S) * clamp(this.random(), 0, 1);
  }

  /** At clock `t`: null, or the blink that is due (and the next one is scheduled). */
  due(t: number): 'single' | 'double' | null {
    if (t < this.next) return null;
    this.next = t + this.interval();
    return this.random() < DOUBLE_BLINK ? 'double' : 'single';
  }

  /** Re-plans from `t` (after a long pause, so blinks do not pile up). */
  reset(t: number): void {
    this.next = t + this.interval();
  }
}

// ---------------------------------------------------------------------------------------------
// The engine

export type Gesture = 'bounce' | 'hop' | 'droop' | 'jump' | 'celebrate' | 'sweat' | 'alert' | 'wink';

/** Colours the engine gives particles. */
export interface ParticleColors {
  confetti: readonly string[];
  spark: string;
  sweat: string;
  z: string;
  heart: string;
}

/** What the character draws this frame. */
export interface Pose {
  /** Engine clock (seconds). */
  t: number;
  state: MascotState;
  eyes: EyeShape;
  /** Up positive (design px). */
  lift: number;
  /** Down positive (design px): a held droop. */
  drop: number;
  scaleX: number;
  scaleY: number;
  tilt: number;
  yaw: number;
  pitch: number;
  /** 0 shut, 1 open. */
  lid: number;
  blush: number;
  /** Antenna tip displacement (design px). */
  antennaX: number;
  antennaY: number;
  tint: Rgb;
  /** Extra glow of the visor rim and antenna (0..1). */
  glow: number;
  /** Antenna light 0..1 (pulses in some states). */
  light: number;
  led: number;
  badge: Badge | null;
  particles: readonly Particle[];
  /** The ground shadow's scale (smaller in the air). */
  shadow: number;
  reduced: boolean;
}

export interface EngineOptions {
  random?: Random;
  reduced?: boolean;
  colors?: Partial<ParticleColors>;
}

const DEFAULT_COLORS: ParticleColors = {
  confetti: ['#10b981', '#22d3ee', '#f59e0b', '#a855f7', '#38bdf8'],
  spark: '#10b981',
  sweat: '#38bdf8',
  z: '#94a3b8',
  heart: 'rgba(251, 113, 133, 0.9)',
};

export class MascotEngine {
  /** Seconds, advanced by `tick` and `resume`. */
  t = 0;
  state: MascotState = 'idle';
  reduced: boolean;
  readonly random: Random;
  readonly colors: ParticleColors;

  #look: StateLook = STATE_LOOK.idle;
  readonly #timeline = new Timeline();
  readonly #blinks: BlinkScheduler;
  #particles: Particle[] = [];
  #ambientUntil = 0;
  #nextEmit = 0;
  /** A temporary expression, held until `#expressionUntil`. */
  #expression: EyeShape | null = null;
  #expressionUntil = 0;
  #pointer: { dx: number; dy: number } | null = null;

  // Smoothed values.
  #yaw = 0;
  #pitch = 0;
  #scaleX = 1;
  #scaleY = 1;
  #drop = 0;
  #tilt = 0;
  #led = 1;
  #tint: Rgb = { r: 226, g: 232, b: 240 };
  #tintTarget: Rgb = { r: 226, g: 232, b: 240 };

  // Secondary motion: the antenna tip lags the head.
  readonly #antX = new Spring(0, { stiffness: 140, damping: 9 });
  readonly #antY = new Spring(0, { stiffness: 160, damping: 11 });
  #headVX = 0;
  #headVY = 0;
  #headX = 0;
  #headY = 0;
  /** The next tick takes the head's position as the new rest (no kick after a pause). */
  #baseline = true;

  // Procedural offsets of the current frame.
  #bob = 0;
  #breath = 0;
  #tiltWave = 0;

  constructor(opts: EngineOptions = {}) {
    this.random = opts.random ?? Math.random;
    this.reduced = opts.reduced ?? false;
    this.colors = { ...DEFAULT_COLORS, ...opts.colors };
    this.#blinks = new BlinkScheduler(this.random, 0);
  }

  get look(): StateLook {
    return this.#look;
  }

  /** Something happened (a state change, the pointer moved, a reaction): the looping motion runs again. */
  stimulate(): void {
    this.#ambientUntil = this.t + this.#look.motion.ambientS;
  }

  setState(state: MascotState): void {
    if (state === this.state) return;
    this.state = state;
    this.#look = STATE_LOOK[state] ?? STATE_LOOK.idle;
    this.#nextEmit = this.t + 0.2;
    this.stimulate();
  }

  setTint(rgb: Rgb): void {
    if (![rgb.r, rgb.g, rgb.b].every(Number.isFinite)) return;
    this.#tintTarget = { ...rgb };
  }

  /** Jumps the tint (the first frame shows the state's colour, not a fade from grey). */
  snapTint(): void {
    this.#tint = { ...this.#tintTarget };
  }

  /** The pointer's offset from Blip's centre in CSS px, or null when it left. */
  setPointer(offset: { dx: number; dy: number } | null): void {
    const prev = this.#pointer;
    if (offset && (!Number.isFinite(offset.dx) || !Number.isFinite(offset.dy))) return;
    this.#pointer = offset ? { dx: offset.dx, dy: offset.dy } : null;
    const moved = !prev !== !offset || (prev && offset && (prev.dx !== offset.dx || prev.dy !== offset.dy));
    if (moved) this.stimulate();
  }

  setReduced(reduced: boolean): void {
    if (this.reduced === reduced) return;
    this.reduced = reduced;
    if (reduced) {
      this.#particles = [];
      this.#timeline.finish();
      this.#antX.snap();
      this.#antY.snap();
    }
  }

  /** Holds an eye shape for `seconds`, then the state's eyes come back. */
  express(shape: EyeShape, seconds: number): void {
    this.#expression = shape;
    this.#expressionUntil = this.t + Math.max(0, seconds);
  }

  /** Plays a reaction; under reduced motion every reaction is a fade of the glow. */
  gesture(kind: Gesture): void {
    this.stimulate();
    if (this.reduced) {
      this.#timeline.play('glow', FLASH_TWEEN);
      if (kind === 'wink') this.express('wink', 0.9);
      if (kind === 'hop') this.express('happy', 1.2);
      if (kind === 'droop') this.express('tired', 0.8);
      return;
    }
    const r = this.random;
    switch (kind) {
      case 'bounce':
        this.#timeline.play('lift', BOUNCE_TWEEN);
        this.#timeline.play('scaleY', [
          { target: 0.05, durationMs: 110, ease: Ease.outQuad },
          { target: -0.04, durationMs: 110, ease: Ease.inQuad },
          { target: 0, durationMs: 180, ease: Ease.outQuad },
        ]);
        this.express('wide', 0.4);
        this.#add(sparks(r, this.colors.spark, 2));
        break;
      case 'hop':
        this.#timeline.play('lift', HOP_TWEEN);
        this.#timeline.play('glow', FLASH_TWEEN);
        this.express('happy', 1.2);
        this.#add(sparks(r, this.colors.spark, 6));
        break;
      case 'droop':
        this.#timeline.play('lift', DROOP_TWEEN);
        this.#timeline.play('scaleY', [
          { target: -0.06, durationMs: 220, ease: Ease.outQuad },
          { target: -0.06, durationMs: 380, ease: Ease.linear },
          { target: 0, durationMs: 420, ease: Ease.inOutQuad },
        ]);
        this.express('tired', 0.8);
        break;
      case 'jump':
      case 'celebrate':
        this.#timeline.play('lift', JUMP_TWEEN);
        this.#timeline.play('scaleY', JUMP_SQUASH);
        this.#timeline.play(
          'scaleX',
          JUMP_SQUASH.map((k) => ({ ...k, target: -k.target * 0.6 })),
        );
        this.express(kind === 'celebrate' ? 'star' : 'happy', 1.1);
        this.#add(confetti(r, this.colors.confetti, kind === 'celebrate' ? 28 : 18));
        break;
      case 'sweat':
        this.#add(sweat(r, this.colors.sweat, 2));
        break;
      case 'alert':
        this.#timeline.play('lift', ALERT_TWEEN);
        this.express('wide', 0.6);
        break;
      case 'wink':
        this.#timeline.play('lift', [
          { target: 3, durationMs: 90, ease: Ease.outQuad },
          { target: 0, durationMs: 200, ease: Ease.outBounce },
        ]);
        this.#timeline.play('blush', [
          { target: 1, durationMs: 140, ease: Ease.outQuad },
          { target: 1, durationMs: 650, ease: Ease.linear },
          { target: 0, durationMs: 360, ease: Ease.inOutQuad },
        ]);
        this.express('wink', 0.9);
        this.#add(hearts(r, this.colors.heart, 2));
        break;
    }
  }

  #add(more: Particle[]): void {
    if (this.reduced) return;
    this.#particles = addParticles(this.#particles, more);
  }

  get particles(): readonly Particle[] {
    return this.#particles;
  }

  /** The eye shape this frame (a temporary expression wins over the state's). */
  get eyes(): EyeShape {
    if (this.#expression && this.t < this.#expressionUntil) return this.#expression;
    return this.#look.eyes;
  }

  get ambient(): boolean {
    return !this.reduced && this.t < this.#ambientUntil;
  }

  /** True while another frame would show something different. */
  get busy(): boolean {
    if (this.#timeline.active || this.#particles.length > 0) return true;
    if (this.#expression && this.t < this.#expressionUntil) return true;
    if (this.ambient) return true;
    if (!this.#antX.settled || !this.#antY.settled) return true;
    return !this.#converged();
  }

  /** Seconds until something is due while Blip holds still (the next blink); null when nothing is. */
  nextWakeIn(): number | null {
    if (!this.#look.blinks) return null;
    return Math.max(0, this.#blinks.next - this.t);
  }

  #targets() {
    const m = this.#look.motion;
    let yaw = 0;
    let pitch = 0;
    if (!this.reduced) {
      const p = this.#pointer ? gazeFromPointer(this.#pointer.dx, this.#pointer.dy) : { yaw: 0, pitch: 0 };
      switch (m.gaze) {
        case 'pointer':
          ({ yaw, pitch } = p);
          break;
        case 'forward':
          yaw = p.yaw * 0.3;
          pitch = p.pitch * 0.3;
          break;
        case 'up-right':
          yaw = 0.55;
          pitch = -0.55;
          break;
        case 'scan':
          yaw = this.ambient ? 0.7 * Math.sin(2 * Math.PI * 1.2 * this.t) : 0;
          pitch = 0.1;
          break;
        case 'down':
          yaw = p.yaw * 0.35;
          pitch = 0.45;
          break;
        case 'centre':
          break;
      }
    }
    return {
      yaw: clamp(yaw, -YAW_LIMIT, YAW_LIMIT),
      pitch: clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT),
      scaleX: m.scaleX,
      scaleY: m.scaleY,
      drop: m.drop,
      tilt: this.reduced ? 0 : m.tilt,
      led: m.led,
    };
  }

  #converged(): boolean {
    const t = this.#targets();
    return (
      this.#yaw === t.yaw &&
      this.#pitch === t.pitch &&
      this.#scaleX === t.scaleX &&
      this.#scaleY === t.scaleY &&
      this.#drop === t.drop &&
      this.#tilt === t.tilt &&
      this.#led === t.led &&
      this.#breath === 0 &&
      this.#bob === 0 &&
      this.#tiltWave === 0 &&
      this.#tint.r === this.#tintTarget.r &&
      this.#tint.g === this.#tintTarget.g &&
      this.#tint.b === this.#tintTarget.b
    );
  }

  /** Advances by `delta` seconds of real time (physics takes at most 0.05 s of it). */
  tick(delta: number): void {
    const real = Number.isFinite(delta) && delta > 0 ? delta : 0;
    if (real === 0) return;
    const dt = Math.min(MAX_DT, real);
    this.t += real;
    const m = this.#look.motion;

    // Blinks.
    const blink = this.#blinks.due(this.t);
    if (blink && this.#look.blinks && EYES[this.eyes].blinks && !this.#timeline.running('blink'))
      this.#timeline.play('blink', blink === 'double' ? BLINK_DOUBLE : BLINK_SINGLE);
    if (this.#expression && this.t >= this.#expressionUntil) this.#expression = null;

    // Smoothing toward the state's targets.
    const t = this.#targets();
    if (this.reduced) {
      this.#yaw = t.yaw;
      this.#pitch = t.pitch;
      this.#scaleX = t.scaleX;
      this.#scaleY = t.scaleY;
      this.#drop = t.drop;
      this.#tilt = t.tilt;
    } else {
      this.#yaw = smooth(this.#yaw, t.yaw, C_GAZE, dt);
      this.#pitch = smooth(this.#pitch, t.pitch, C_GAZE, dt);
      this.#scaleX = smooth(this.#scaleX, t.scaleX, C_BODY, dt);
      this.#scaleY = smooth(this.#scaleY, t.scaleY, C_BODY, dt);
      this.#drop = smooth(this.#drop, t.drop, C_BODY, dt);
      this.#tilt = smooth(this.#tilt, t.tilt, C_BODY, dt);
    }
    this.#led = smooth(this.#led, t.led, C_COLOR, dt);
    this.#tint = {
      r: smooth(this.#tint.r, this.#tintTarget.r, C_COLOR, dt),
      g: smooth(this.#tint.g, this.#tintTarget.g, C_COLOR, dt),
      b: smooth(this.#tint.b, this.#tintTarget.b, C_COLOR, dt),
    };

    // Looping motion of the state, while it runs.
    const ambient = this.ambient;
    const tt = this.t;
    if (ambient) {
      this.#breath = m.breathAmp * Math.sin(2 * Math.PI * m.breathHz * tt);
      const wave = Math.sin(2 * Math.PI * m.bobHz * tt);
      this.#bob = m.bobAmp * (m.bobShape === 'bounce' ? Math.abs(wave) : wave);
      this.#tiltWave = m.tiltAmp * Math.sin(2 * Math.PI * m.tiltHz * tt);
      if (m.emit && tt >= this.#nextEmit) {
        this.#nextEmit = tt + m.emit.everyS;
        if (m.emit.type === 'z') this.#add([snooze(this.random, this.colors.z)]);
        else if (m.emit.type === 'sweat') this.#add(sweat(this.random, this.colors.sweat, 1));
      }
    } else {
      this.#breath = smooth(this.#breath, 0, C_BODY, dt);
      this.#bob = smooth(this.#bob, 0, C_BODY, dt);
      this.#tiltWave = smooth(this.#tiltWave, 0, C_BODY, dt);
    }

    this.#timeline.step(dt);
    this.#particles = stepParticles(this.#particles, dt);

    // Secondary motion: the antenna tip feels the head's acceleration.
    if (this.reduced) {
      this.#antX.snap();
      this.#antY.snap();
    } else {
      const tilt = this.#tilt + this.#tiltWave + this.#timeline.value('tilt');
      const headX = Math.sin(tilt) * 26 + this.#yaw * 3;
      const headY = -(this.#timeline.value('lift') + this.#bob) + this.#drop;
      if (this.#baseline) {
        this.#baseline = false;
        this.#headX = headX;
        this.#headY = headY;
        this.#headVX = 0;
        this.#headVY = 0;
      }
      const vx = (headX - this.#headX) / dt;
      const vy = (headY - this.#headY) / dt;
      const ax = clamp((vx - this.#headVX) / dt, -4000, 4000);
      const ay = clamp((vy - this.#headVY) / dt, -4000, 4000);
      this.#headX = headX;
      this.#headY = headY;
      this.#headVX = vx;
      this.#headVY = vy;
      this.#antX.target = this.state === 'halted' ? 5 : 0;
      this.#antY.target = this.state === 'halted' ? 3 : this.state === 'sleeping' ? 1.2 : 0;
      const moving = Math.abs(ax) > 1 || Math.abs(ay) > 1;
      this.#antX.step(dt, moving ? -ax * 0.02 : 0);
      this.#antY.step(dt, moving ? -ay * 0.012 : 0);
      this.#antX.x = clamp(this.#antX.x, -8, 8);
      this.#antY.x = clamp(this.#antY.x, -5, 5);
    }
  }

  /** Back after `gap` seconds without frames (hidden, or holding still): everything settles. */
  resume(gap: number): void {
    if (!(gap > 0) || !Number.isFinite(gap)) return;
    this.t += gap;
    if (gap < 0.25) return;
    this.#timeline.finish();
    this.#particles = [];
    if (this.#expression && this.t >= this.#expressionUntil) this.#expression = null;
    const t = this.#targets();
    this.#yaw = t.yaw;
    this.#pitch = t.pitch;
    this.#scaleX = t.scaleX;
    this.#scaleY = t.scaleY;
    this.#drop = t.drop;
    this.#tilt = t.tilt;
    this.#led = t.led;
    this.#tint = { ...this.#tintTarget };
    this.#breath = 0;
    this.#bob = 0;
    this.#tiltWave = 0;
    this.#antX.snap();
    this.#antY.snap();
    this.#baseline = true;
    // Overdue by more than a second: Blip was hidden; plan the next blink from now.
    if (this.t - this.#blinks.next > 1) this.#blinks.reset(this.t);
  }

  pose(): Pose {
    const tl = this.#timeline;
    const m = this.#look.motion;
    const pulse = m.pulseHz > 0 && this.ambient ? 0.5 + 0.5 * Math.sin(2 * Math.PI * m.pulseHz * this.t) : 1;
    const lift = tl.value('lift') + this.#bob;
    return {
      t: this.t,
      state: this.state,
      eyes: this.eyes,
      lift,
      drop: this.#drop,
      scaleX: this.#scaleX + tl.value('scaleX') - this.#breath * 0.5,
      scaleY: this.#scaleY + tl.value('scaleY') + this.#breath,
      tilt: this.#tilt + this.#tiltWave + tl.value('tilt'),
      yaw: this.#yaw,
      pitch: this.#pitch,
      lid: 1 - clamp(tl.value('blink'), 0, 1),
      blush: clamp(tl.value('blush'), 0, 1),
      antennaX: this.#antX.x,
      antennaY: this.#antY.x,
      tint: { ...this.#tint },
      glow: clamp(tl.value('glow'), 0, 1),
      light: clamp(this.#led * (0.55 + 0.45 * pulse), 0, 1),
      led: clamp(this.#led, 0, 1),
      badge: this.#look.badge,
      particles: this.#particles,
      shadow: clamp(1 - Math.max(0, lift) / 40, 0.4, 1.1),
      reduced: this.reduced,
    };
  }
}

export type { Rgb };
export { EYE_SHAPES };
