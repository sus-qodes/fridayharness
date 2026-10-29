import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAudioContext } from './fake-audio.js';
import {
  audioContextFactory,
  DEFAULT_VOLUME,
  IDLE_SUSPEND_MS,
  SOUND_LENGTH,
  SOUND_NAMES,
  Synth,
  type SynthEnv,
} from './synth.js';

let fake: FakeAudioContext;

function env(create: SynthEnv['create'] = () => fake.asContext()): SynthEnv {
  return {
    create,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
}

function ready(): Synth {
  const s = new Synth(env());
  expect(s.init()).toBe(true);
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = new FakeAudioContext();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Synth', () => {
  it('knows the six sounds of Part 08 §4', () => {
    expect(SOUND_NAMES).toEqual([
      'node_appear',
      'escalation_alert',
      'allow_success',
      'task_complete',
      'emergency_halt',
      'click_tick',
    ]);
  });

  it('sets the master gain to 0.18 by default and follows the volume', () => {
    const s = ready();
    expect(fake.master?.gain.value).toBe(DEFAULT_VOLUME);
    expect(fake.master?.outputs[0]).toBe(fake.destination);
    s.setVolume(0.5);
    expect(fake.master?.gain.value).toBe(0.5);
    s.setVolume(7);
    expect(fake.master?.gain.value).toBe(1);
    s.setVolume(Number.NaN);
    expect(fake.master?.gain.value).toBe(DEFAULT_VOLUME);
  });

  it('plays node_appear as a sine chirp from 600 to 950 Hz', () => {
    const s = ready();
    expect(s.play('node_appear')).toBe(true);
    const osc = fake.oscillators[0];
    expect(osc?.type).toBe('sine');
    expect(osc?.frequency.events).toEqual([
      ['set', 600, 2],
      ['exp', 950, 2.05],
    ]);
    expect(osc?.starts).toEqual([2]);
    expect(osc?.stops[0]).toBeCloseTo(2.08, 9);
    const env = fake.gains[1]?.gain.events;
    expect(env?.[0]).toEqual(['set', 0.15, 2]);
    expect(env?.[1]?.[0]).toBe('exp');
    expect(env?.[1]?.[1]).toBe(0.001);
  });

  it('plays escalation_alert as a major third that decays in 280 ms', () => {
    const s = ready();
    s.play('escalation_alert');
    expect(fake.frequencies()).toEqual([523.25, 659.25]);
    for (const o of fake.oscillators) expect(o.stops[0]).toBeCloseTo(2.28, 9);
    expect(fake.gains.slice(1).map((g) => g.gain.events[0]?.[1])).toEqual([0.12, 0.12]);
  });

  it('plays allow_success as a falling triangle with a breath of noise', () => {
    const s = ready();
    s.play('allow_success');
    expect(fake.oscillators[0]?.type).toBe('triangle');
    expect(fake.frequencies()).toEqual([800, 400]);
    expect(fake.sources).toHaveLength(1);
    expect(fake.filters[0]?.type).toBe('highpass');
    // The noise buffer is made once.
    s.play('allow_success');
    expect(fake.sources[1]?.buffer).toBe(fake.sources[0]?.buffer);
  });

  it('plays task_complete as a C5 E5 G5 arpeggio', () => {
    const s = ready();
    s.play('task_complete');
    expect(fake.frequencies()).toEqual([523.25, 659.25, 783.99]);
    expect(fake.oscillators.map((o) => o.starts[0])).toEqual([2, 2.06, 2.12]);
  });

  it('plays emergency_halt as a sawtooth falling through a closing low-pass', () => {
    const s = ready();
    s.play('emergency_halt');
    expect(fake.oscillators[0]?.type).toBe('sawtooth');
    expect(fake.frequencies()).toEqual([220, 40]);
    const filter = fake.filters[0];
    expect(filter?.type).toBe('lowpass');
    expect(filter?.frequency.events.map((e) => e[1])).toEqual([1800, 160]);
    expect(fake.oscillators[0]?.outputs[0]?.outputs[0]).toBe(filter);
    expect(filter?.outputs[0]).toBe(fake.master);
  });

  it('plays click_tick as a 12 ms high-passed 1200 Hz click', () => {
    const s = ready();
    s.play('click_tick');
    expect(fake.frequencies()).toEqual([1200]);
    expect(fake.filters[0]?.type).toBe('highpass');
    expect(fake.oscillators[0]?.stops[0]).toBeCloseTo(2.012, 9);
  });

  it('plays nothing at all while muted or at volume 0', () => {
    const s = ready();
    s.setMuted(true);
    expect(fake.master?.gain.value).toBe(0);
    for (const name of SOUND_NAMES) expect(s.play(name)).toBe(false);
    expect(fake.oscillators).toHaveLength(0);
    s.setMuted(false);
    expect(fake.master?.gain.value).toBe(DEFAULT_VOLUME);
    s.setVolume(0);
    expect(s.play('click_tick')).toBe(false);
    expect(fake.oscillators).toHaveLength(0);
  });

  it('refuses unknown sound names', () => {
    const s = ready();
    expect(s.play('agent_spawn' as never)).toBe(false);
    expect(fake.oscillators).toHaveLength(0);
  });

  it('suspends the context after 1.5 s of silence and resumes for the next sound', () => {
    const s = ready();
    // Created but silent: suspended after the idle time.
    vi.advanceTimersByTime(IDLE_SUSPEND_MS - 1);
    expect(fake.suspends).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fake.suspends).toBe(1);
    expect(fake.state).toBe('suspended');
    s.play('emergency_halt');
    expect(fake.resumes).toBe(1);
    const wait = Math.round((SOUND_LENGTH.emergency_halt ?? 0) * 1000) + IDLE_SUSPEND_MS;
    vi.advanceTimersByTime(wait - 1);
    expect(fake.suspends).toBe(1);
    // Another sound restarts the idle time.
    s.play('click_tick');
    vi.advanceTimersByTime(wait - 1);
    expect(fake.suspends).toBe(2);
    s.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is a no-op without Web Audio, and survives a context that throws', () => {
    const none = new Synth(env(() => null));
    expect(none.init()).toBe(false);
    expect(none.init()).toBe(false);
    expect(none.ready).toBe(false);
    expect(none.play('task_complete')).toBe(false);
    const throws = new Synth(
      env(() => {
        throw new Error('NotAllowedError');
      }),
    );
    expect(throws.init()).toBe(false);
    expect(throws.play('task_complete')).toBe(false);
    // Before init nothing plays either.
    expect(new Synth(env()).play('node_appear')).toBe(false);
  });

  it('finds the page AudioContext, or reports there is none', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    expect(audioContextFactory()).toBeNull();
    vi.stubGlobal('webkitAudioContext', FakeAudioContext);
    const make = audioContextFactory();
    expect(make?.()).toBeInstanceOf(FakeAudioContext);
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('no');
        }
      },
    );
    expect(audioContextFactory()?.()).toBeNull();
  });
});
