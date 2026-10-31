/**
 * Friday's procedural sounds (plan §7.10, handoff Part 08 §4, ERRATA F33): six short tones made
 * from oscillators, a little filtered noise and gain envelopes; no audio files. A master gain sets
 * the volume (0.18 by default); muted, nothing is built or played. The context is created only when
 * the page allows it (the first gesture in a browser, at load in the desktop Notch window) and is
 * suspended after 1.5 s of silence, because a running context keeps an audio thread busy. Without
 * Web Audio every call is a no-op.
 */

export const WAV_SOUND_NAMES = [
  'peek',
  'open',
  'close',
  'hover',
  'blip',
  'slap',
  'annoyed',
  'dizzy',
  'greet',
  'work',
  'finish',
  'error',
  'approval',
  'question',
  'approve',
  'gulp',
  'tick',
  'send',
  'love',
  'pop',
  'proud',
  'wink',
  'yawn',
  'attach',
  'think',
  'search',
  'rate',
  'sleep',
  'greeting',
] as const;

export type WavSoundName = (typeof WAV_SOUND_NAMES)[number];

export type SoundName =
  | 'node_appear'
  | 'escalation_alert'
  | 'allow_success'
  | 'task_complete'
  | 'emergency_halt'
  | 'click_tick'
  | WavSoundName;

export const SOUND_NAMES: readonly SoundName[] = [
  'node_appear',
  'escalation_alert',
  'allow_success',
  'task_complete',
  'emergency_halt',
  'click_tick',
];

export const WAV_MAP: Readonly<Record<string, WavSoundName>> = Object.freeze({
  node_appear: 'pop',
  escalation_alert: 'approval',
  allow_success: 'approve',
  task_complete: 'finish',
  emergency_halt: 'error',
  click_tick: 'tick',
});

/** The volume at the default setting (Part 08 §4.2: soft, not fatiguing). */
export const DEFAULT_VOLUME = 0.18;
/** Silence this long suspends the context. */
export const IDLE_SUSPEND_MS = 1_500;

/** How long each sound rings (seconds), for the idle timer. */
export const SOUND_LENGTH: Readonly<Record<string, number>> = Object.freeze({
  node_appear: 0.08,
  escalation_alert: 0.28,
  allow_success: 0.07,
  task_complete: 0.27,
  emergency_halt: 0.45,
  click_tick: 0.012,
});

/** The parts of an `AudioContext` the synth uses (a fake one in tests). */
export type AudioContextLike = Pick<
  AudioContext,
  | 'currentTime'
  | 'state'
  | 'destination'
  | 'sampleRate'
  | 'createGain'
  | 'createOscillator'
  | 'createBiquadFilter'
  | 'createBuffer'
  | 'createBufferSource'
  | 'resume'
  | 'suspend'
>;

export interface SynthEnv {
  /** Creates the context, or null where Web Audio does not exist (or refuses). */
  create(): AudioContextLike | null;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** Finds the page's `AudioContext` constructor (`webkitAudioContext` on older engines). */
export function audioContextFactory(): (() => AudioContextLike | null) | null {
  const g = globalThis as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  return () => {
    try {
      return new Ctor();
    } catch {
      return null;
    }
  };
}

export function defaultSynthEnv(): SynthEnv {
  const factory = audioContextFactory();
  return {
    create: () => (factory ? factory() : null),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
}

function volumeOf(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
}

export class Synth {
  #ctx: AudioContextLike | null = null;
  #master: GainNode | null = null;
  #noise: AudioBuffer | null = null;
  #buffers = new Map<string, AudioBuffer>();
  #preloadPromise: Promise<void> | null = null;
  #muted = false;
  #volume = DEFAULT_VOLUME;
  #idle: unknown = null;
  #failed = false;

  constructor(private readonly env: SynthEnv = defaultSynthEnv()) {}

  /** True once a context exists. */
  get ready(): boolean {
    return this.#ctx !== null;
  }

  /** True while the context runs (not suspended by the page or by the idle timer). */
  get running(): boolean {
    return this.#ctx?.state === 'running';
  }

  get muted(): boolean {
    return this.#muted;
  }

  get volume(): number {
    return this.#volume;
  }

  /** Preloads the character WAV palette into memory when running in a live browser or desktop app. */
  async #preload(): Promise<void> {
    if (this.#preloadPromise) return this.#preloadPromise;
    const ctx = this.#ctx;
    if (!ctx || typeof (ctx as unknown as { decodeAudioData?: unknown }).decodeAudioData !== 'function') return;
    if (typeof fetch !== 'function') return;

    this.#preloadPromise = (async () => {
      const base =
        typeof window !== 'undefined' && window.location
          ? ((window.location.href.split('?')[0] ?? '').split('#')[0] ?? '')
          : 'http://127.0.0.1:4310/ui/';
      const dirUrl = base.endsWith('/') ? base : base.slice(0, base.lastIndexOf('/') + 1);

      await Promise.all(
        WAV_SOUND_NAMES.map(async (name) => {
          try {
            const urls = [new URL(`sounds/${name}.wav`, dirUrl).href, `/sounds/${name}.wav`];
            for (const u of urls) {
              try {
                const res = await fetch(u);
                if (!res.ok) continue;
                const arrayBuf = await res.arrayBuffer();
                const audioBuf = await (
                  ctx as unknown as { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> }
                ).decodeAudioData(arrayBuf);
                this.#buffers.set(name, audioBuf);
                return;
              } catch {
                // try next URL
              }
            }
          } catch {
            // ignore loading error
          }
        }),
      );
    })();
    return this.#preloadPromise;
  }

  /** The context, created on the first call (after a gesture, or at load in the desktop Notch). */
  init(): boolean {
    if (this.#ctx) {
      this.#resume();
      return true;
    }
    if (this.#failed) return false;
    let ctx: AudioContextLike | null = null;
    try {
      ctx = this.env.create();
    } catch {
      ctx = null;
    }
    if (!ctx) {
      this.#failed = true;
      return false;
    }
    try {
      const master = ctx.createGain();
      master.gain.setValueAtTime(this.#gain(), ctx.currentTime);
      master.connect(ctx.destination);
      this.#ctx = ctx;
      this.#master = master;
    } catch {
      this.#failed = true;
      return false;
    }
    this.#resume();
    this.#scheduleSuspend(0);
    void this.#preload();
    return true;
  }

  setMuted(muted: boolean): void {
    this.#muted = Boolean(muted);
    this.#applyGain();
  }

  setVolume(volume: number): void {
    this.#volume = volumeOf(volume);
    this.#applyGain();
  }

  #gain(): number {
    return this.#muted ? 0 : this.#volume;
  }

  #applyGain(): void {
    if (!this.#ctx || !this.#master) return;
    try {
      this.#master.gain.setValueAtTime(this.#gain(), this.#ctx.currentTime);
    } catch {
      // a closed context: nothing to set
    }
  }

  #resume(): void {
    const ctx = this.#ctx;
    if (ctx?.state !== 'suspended') return;
    try {
      void ctx.resume().catch(() => undefined);
    } catch {
      // the page does not allow it yet
    }
  }

  #scheduleSuspend(lengthS: number): void {
    if (this.#idle !== null) this.env.clearTimeout(this.#idle);
    this.#idle = this.env.setTimeout(
      () => {
        this.#idle = null;
        const ctx = this.#ctx;
        if (ctx?.state !== 'running') return;
        try {
          void ctx.suspend().catch(() => undefined);
        } catch {
          // already closed
        }
      },
      Math.round(lengthS * 1000) + IDLE_SUSPEND_MS,
    );
  }

  /** Plays a sound; false when muted, silent or without a context. */
  play(name: SoundName): boolean {
    const ctx = this.#ctx;
    const master = this.#master;
    if (!ctx || !master || this.#muted || this.#volume <= 0) return false;
    const isKnown =
      (SOUND_NAMES as readonly string[]).includes(name) || (WAV_SOUND_NAMES as readonly string[]).includes(name);
    if (!isKnown) return false;
    this.#resume();

    // Prefer the shipped WAV buffer when one is loaded
    const wavName = (WAV_SOUND_NAMES as readonly string[]).includes(name) ? (name as WavSoundName) : WAV_MAP[name];
    const buf = wavName ? this.#buffers.get(wavName) : undefined;
    if (buf && typeof ctx.createBufferSource === 'function') {
      try {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(1, ctx.currentTime);
        src.connect(gain);
        gain.connect(master);
        src.start(ctx.currentTime);
        this.#scheduleSuspend(buf.duration || 0.3);
        return true;
      } catch {
        // Fall back to synth
      }
    }

    try {
      this.#build(ctx, master, name, ctx.currentTime);
    } catch {
      return false;
    }
    this.#scheduleSuspend(SOUND_LENGTH[name] ?? 0.3);
    return true;
  }

  /** Stops the idle timer (the context itself is left to the page). */
  dispose(): void {
    if (this.#idle !== null) this.env.clearTimeout(this.#idle);
    this.#idle = null;
  }

  #tone(
    ctx: AudioContextLike,
    out: AudioNode,
    type: OscillatorType,
    at: number,
    length: number,
    from: number,
    to: number | null,
    peak: number,
  ): OscillatorNode {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    if (to !== null) osc.frequency.exponentialRampToValueAtTime(to, at + length);
    gain.gain.setValueAtTime(peak, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + length);
    osc.connect(gain);
    gain.connect(out);
    osc.start(at);
    osc.stop(at + length);
    return osc;
  }

  #noiseBuffer(ctx: AudioContextLike): AudioBuffer {
    if (this.#noise) return this.#noise;
    const length = Math.max(1, Math.round(ctx.sampleRate * 0.05));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // A fixed pattern: the same hiss every time, no randomness needed.
    let seed = 0x9e3779b9;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 4294967296) * 2 - 1;
    }
    this.#noise = buffer;
    return buffer;
  }

  #build(ctx: AudioContextLike, master: GainNode, name: SoundName, now: number): void {
    switch (name) {
      case 'node_appear':
        // A sine chirp 600 → 950 Hz in 50 ms.
        this.#tone(ctx, master, 'sine', now, 0.08, 600, null, 0.15).frequency.exponentialRampToValueAtTime(
          950,
          now + 0.05,
        );
        break;
      case 'pop':
      case 'blip':
      case 'peek':
        this.#tone(ctx, master, 'sine', now, 0.08, 700, null, 0.16).frequency.exponentialRampToValueAtTime(
          1050,
          now + 0.05,
        );
        break;
      case 'escalation_alert':
        // A major third (C5 + E5) decaying over 280 ms.
        for (const f of [523.25, 659.25]) this.#tone(ctx, master, 'sine', now, 0.28, f, null, 0.12);
        break;
      case 'question':
      case 'think':
      case 'search':
        for (const f of [523.25, 659.25]) this.#tone(ctx, master, 'sine', now, 0.28, f, null, 0.12);
        break;
      case 'allow_success': {
        // A triangle 800 → 400 Hz in 70 ms with a breath of high-passed noise.
        this.#tone(ctx, master, 'triangle', now, 0.07, 800, 400, 0.2);
        const src = ctx.createBufferSource();
        src.buffer = this.#noiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.setValueAtTime(3000, now);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
        src.connect(filter);
        filter.connect(gain);
        gain.connect(master);
        src.start(now);
        src.stop(now + 0.04);
        break;
      }
      case 'approval':
      case 'approve':
      case 'proud':
      case 'love':
      case 'rate': {
        this.#tone(ctx, master, 'sine', now, 0.18, 880, null, 0.18);
        this.#tone(ctx, master, 'sine', now + 0.05, 0.22, 1760, null, 0.15);
        break;
      }
      case 'task_complete':
        // An ascending C5 E5 G5 arpeggio.
        [523.25, 659.25, 783.99].forEach((f, i) => {
          this.#tone(ctx, master, 'sine', now + i * 0.06, 0.15, f, null, 0.12);
        });
        break;
      case 'finish':
      case 'greet':
      case 'greeting':
      case 'send':
        [523.25, 659.25, 783.99].forEach((f, i) => {
          this.#tone(ctx, master, 'sine', now + i * 0.06, 0.16, f, null, 0.16);
        });
        break;
      case 'emergency_halt': {
        // A sawtooth falling 220 → 40 Hz through a closing low-pass.
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800, now);
        filter.frequency.exponentialRampToValueAtTime(160, now + 0.45);
        filter.connect(master);
        this.#tone(ctx, filter, 'sawtooth', now, 0.45, 220, 40, 0.25);
        break;
      }
      case 'slap':
      case 'error':
      case 'annoyed':
      case 'dizzy': {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800, now);
        filter.frequency.exponentialRampToValueAtTime(160, now + 0.45);
        filter.connect(master);
        this.#tone(ctx, filter, 'sawtooth', now, 0.45, 220, 40, 0.25);
        break;
      }
      case 'click_tick': {
        // A 12 ms high-passed click at 1200 Hz.
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.setValueAtTime(1000, now);
        filter.connect(master);
        this.#tone(ctx, filter, 'square', now, 0.012, 1200, null, 0.05);
        break;
      }
      case 'tick':
      case 'hover': {
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.setValueAtTime(1000, now);
        filter.connect(master);
        this.#tone(ctx, filter, 'square', now, 0.012, 1200, null, 0.08);
        break;
      }
      default:
        this.#tone(ctx, master, 'sine', now, 0.15, 784, null, 0.16);
        this.#tone(ctx, master, 'sine', now + 0.04, 0.2, 1046.5, null, 0.18);
        break;
    }
  }
}
