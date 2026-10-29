import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactionKind } from '../store/state.js';
import { makeContext, type TestContext } from '../test/context.js';
import { makeGoal, makeSnapshot, makeTask } from '../test/fixtures.js';
import { FakeAudioContext } from './fake-audio.js';
import {
  addedNodes,
  clickTick,
  initAudioWith,
  MIN_GAP_MS,
  NodeSoundGate,
  newlyBlocked,
  playSound,
  RateLimiter,
  resetSoundForTests,
  soundFor,
  startSoundWith,
} from './sound.js';
import { Synth } from './synth.js';

let fake: FakeAudioContext;
let synth: Synth;
let ctx: TestContext;
let stop: (() => void) | null = null;
let nextId = 1;

function push(kind: ReactionKind): void {
  const a = ctx.store.select('activity');
  ctx.store.setState({ activity: { ...a, reactions: [...a.reactions, { id: nextId++, kind, at: ctx.clock.now }] } });
}

function freqs(): number[] {
  return fake.frequencies();
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = new FakeAudioContext();
  synth = new Synth({
    create: () => fake.asContext(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  });
  synth.init();
  resetSoundForTests(synth);
  ctx = makeContext();
});

afterEach(() => {
  stop?.();
  stop = null;
  resetSoundForTests(null);
  vi.useRealTimers();
});

describe('soundFor', () => {
  it('maps reactions to the catalogue of Part 08 (tool calls and failures play nothing)', () => {
    const table: [ReactionKind, string | null][] = [
      ['approval', 'escalation_alert'],
      ['question', 'escalation_alert'],
      ['plan', 'escalation_alert'],
      ['approved', 'allow_success'],
      ['completed', 'task_complete'],
      ['goal-completed', 'task_complete'],
      ['node', 'node_appear'],
      ['halt', 'emergency_halt'],
      ['denied', null],
      ['failed', null],
      ['lost', null],
    ];
    for (const [kind, sound] of table) expect(soundFor(kind), kind).toBe(sound);
  });
});

describe('RateLimiter', () => {
  it('lets a sound through once per its gap', () => {
    const r = new RateLimiter();
    expect(r.allow('escalation_alert', 0)).toBe(true);
    expect(r.allow('escalation_alert', MIN_GAP_MS.escalation_alert - 1)).toBe(false);
    expect(r.allow('task_complete', 1)).toBe(true);
    expect(r.allow('escalation_alert', MIN_GAP_MS.escalation_alert)).toBe(true);
    // A clock that went backwards does not mute it for good.
    expect(r.allow('escalation_alert', 0)).toBe(true);
  });
});

describe('NodeSoundGate', () => {
  it('chimes once for a burst of node reactions and the snapshot that adds them', () => {
    const g = new NodeSoundGate();
    expect(g.reaction(0)).toBe(false);
    expect(g.reaction(10)).toBe(false);
    expect(g.reaction(20)).toBe(false);
    expect(g.snapshot(20, 300)).toBe(true);
    expect(g.snapshot(1, 600)).toBe(false);
  });

  it('matches a reaction that comes just after its snapshot', () => {
    const g = new NodeSoundGate();
    expect(g.snapshot(2, 0)).toBe(false);
    expect(g.reaction(500)).toBe(true);
    expect(g.reaction(600)).toBe(false);
  });

  it('stays silent for snapshots without node reactions and reactions without snapshots', () => {
    const g = new NodeSoundGate();
    expect(g.snapshot(5, 0)).toBe(false);
    expect(g.reaction(5_000)).toBe(false);
    expect(g.snapshot(0, 5_100)).toBe(false);
    expect(g.snapshot(1, 5_000 + NodeSoundGate.WAIT_MS + 1)).toBe(false);
  });
});

describe('snapshot comparisons', () => {
  it('counts added tasks and goals, never on the first snapshot', () => {
    const a = makeSnapshot({ tasks: [makeTask()], goals: [makeGoal()] });
    const b = makeSnapshot({
      tasks: [makeTask(), makeTask({ task_id: 'task_2' }), makeTask({ task_id: 'task_3' })],
      goals: [makeGoal(), makeGoal({ goal_id: 'goal_2' })],
    });
    expect(addedNodes(a, b)).toBe(3);
    expect(addedNodes(b, a)).toBe(0);
    expect(addedNodes(null, b)).toBe(0);
  });

  it('counts tasks that just became blocked', () => {
    const running = makeTask({ status: 'RUNNING' });
    const blocked = makeTask({ status: 'WAITING', waiting_reason: 'blocked' });
    expect(newlyBlocked(makeSnapshot({ tasks: [running] }), makeSnapshot({ tasks: [blocked] }))).toBe(1);
    expect(newlyBlocked(makeSnapshot({ tasks: [blocked] }), makeSnapshot({ tasks: [blocked] }))).toBe(0);
    expect(newlyBlocked(null, makeSnapshot({ tasks: [blocked] }))).toBe(0);
  });
});

describe('startSound', () => {
  it('plays the sound of each reaction, once each', () => {
    stop = startSoundWith(ctx, synth);
    push('approval');
    expect(freqs()).toEqual([523.25, 659.25]);
    push('approved');
    expect(fake.oscillators.at(-1)?.type).toBe('triangle');
    push('completed');
    expect(freqs().slice(-3)).toEqual([523.25, 659.25, 783.99]);
    push('halt');
    expect(fake.oscillators.at(-1)?.type).toBe('sawtooth');
    const count = fake.oscillators.length;
    // The same reactions again (another activity change) play nothing.
    ctx.store.patch('activity', { lastActivityAt: ctx.clock.now });
    push('denied');
    push('failed');
    expect(fake.oscillators).toHaveLength(count);
  });

  it('ignores reactions from before it started', () => {
    push('completed');
    stop = startSoundWith(ctx, synth);
    ctx.store.patch('activity', { lastActivityAt: 1 });
    expect(fake.oscillators).toHaveLength(0);
  });

  it('rate-limits a burst of alerts', () => {
    stop = startSoundWith(ctx, synth);
    push('approval');
    push('question');
    push('plan');
    expect(fake.oscillators).toHaveLength(2);
    ctx.clock.now += MIN_GAP_MS.escalation_alert;
    push('question');
    expect(fake.oscillators).toHaveLength(4);
  });

  it('chimes node_appear once for the snapshot that added the nodes', () => {
    ctx.board(makeSnapshot({ tasks: [] }));
    stop = startSoundWith(ctx, synth);
    push('node');
    push('node');
    expect(fake.oscillators).toHaveLength(0);
    ctx.board(makeSnapshot({ tasks: [makeTask(), makeTask({ task_id: 'task_2' })] }));
    expect(freqs()).toEqual([600, 950]);
    // Another snapshot within 1.5 s with a new node and a reaction: still once.
    ctx.clock.now += 500;
    push('node');
    ctx.board(makeSnapshot({ tasks: [makeTask(), makeTask({ task_id: 'task_2' }), makeTask({ task_id: 'task_3' })] }));
    expect(fake.oscillators).toHaveLength(1);
  });

  it('chimes when a spawned agent stops for a human', () => {
    ctx.board(makeSnapshot({ tasks: [makeTask({ status: 'RUNNING' })] }));
    stop = startSoundWith(ctx, synth);
    ctx.board(makeSnapshot({ tasks: [makeTask({ status: 'WAITING', waiting_reason: 'blocked' })] }));
    expect(freqs()).toEqual([523.25, 659.25]);
  });

  it('follows mute and volume', () => {
    ctx.store.patch('prefs', { muted: true });
    stop = startSoundWith(ctx, synth);
    push('approval');
    expect(fake.oscillators).toHaveLength(0);
    ctx.store.patch('prefs', { muted: false, volume: 0.4 });
    expect(fake.master?.gain.value).toBe(0.4);
    ctx.clock.now += 5_000;
    push('approval');
    expect(fake.oscillators).toHaveLength(2);
  });

  it('stops playing once stopped', () => {
    stop = startSoundWith(ctx, synth);
    expect(playSound('click_tick')).toBe(true);
    stop();
    stop();
    stop = null;
    push('approval');
    expect(playSound('task_complete')).toBe(false);
    clickTick();
    expect(fake.oscillators).toHaveLength(1);
  });

  it('lets other areas tick only while sounds run, rate-limited', () => {
    clickTick();
    expect(fake.oscillators).toHaveLength(0);
    stop = startSoundWith(ctx, synth);
    vi.setSystemTime(10_000);
    clickTick();
    clickTick();
    expect(freqs()).toEqual([1200]);
    vi.setSystemTime(10_000 + MIN_GAP_MS.click_tick);
    clickTick();
    expect(fake.oscillators).toHaveLength(2);
  });
});

describe('initAudio', () => {
  function target() {
    const t = new EventTarget();
    return t as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
  }

  it('waits for the first gesture in a browser', () => {
    const later = new FakeAudioContext();
    const s = new Synth({ create: () => later.asContext(), setTimeout, clearTimeout });
    const t = target();
    initAudioWith(s, {}, t);
    expect(s.ready).toBe(false);
    (t as unknown as EventTarget).dispatchEvent(new Event('pointerdown'));
    expect(s.ready).toBe(true);
    expect(later.master?.gain.value).toBe(0.18);
  });

  it('keeps listening while the page leaves the context suspended', () => {
    const later = new FakeAudioContext();
    later.state = 'suspended';
    later.resume = function () {
      this.resumes++;
      return Promise.resolve();
    };
    const s = new Synth({ create: () => later.asContext(), setTimeout, clearTimeout });
    const t = target();
    initAudioWith(s, {}, t);
    (t as unknown as EventTarget).dispatchEvent(new Event('keydown'));
    expect(s.ready).toBe(true);
    (t as unknown as EventTarget).dispatchEvent(new Event('pointerdown'));
    expect(later.resumes).toBe(2);
    later.state = 'running';
    (t as unknown as EventTarget).dispatchEvent(new Event('pointerdown'));
    (t as unknown as EventTarget).dispatchEvent(new Event('pointerdown'));
    expect(later.resumes).toBe(2);
  });

  it('starts at once in the desktop Notch window', () => {
    const now = new FakeAudioContext();
    const s = new Synth({ create: () => now.asContext(), setTimeout, clearTimeout });
    initAudioWith(s, { atLoad: true }, target());
    expect(s.ready).toBe(true);
  });

  it('does nothing harmful without Web Audio', () => {
    const s = new Synth({ create: () => null, setTimeout, clearTimeout });
    const t = target();
    expect(() => initAudioWith(s, { atLoad: true }, t)).not.toThrow();
    expect(() => initAudioWith(s, {}, t)).not.toThrow();
    (t as unknown as EventTarget).dispatchEvent(new Event('pointerdown'));
    expect(s.ready).toBe(false);
    expect(() => initAudioWith(s, {}, null)).not.toThrow();
  });
});
