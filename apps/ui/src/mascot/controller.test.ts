import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reaction, ReactionKind } from '../store/state.js';
import { makeContext, type TestContext } from '../test/context.js';
import { makeApproval, makeHarness, makeSnapshot } from '../test/fixtures.js';
import { readPalette } from './character.js';
import { gestureFor, MascotController, type MascotReaction, prefersReducedMotion } from './controller.js';
import { MascotEngine, seededRandom } from './engine.js';

let ctx: TestContext;
let engine: MascotEngine;
let controller: MascotController;
let changes = 0;
let nextId = 1;

function push(kind: ReactionKind, at = ctx.clock.now): Reaction {
  const r = { id: nextId++, kind, at };
  const a = ctx.store.select('activity');
  ctx.store.setState({ activity: { ...a, reactions: [...a.reactions, r] } });
  return r;
}

function mount(): void {
  engine = new MascotEngine({ random: seededRandom(1) });
  controller = new MascotController(ctx, engine, readPalette(document.createElement('div')), () => changes++, {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    matchMedia: null,
  });
  controller.start();
}

beforeEach(() => {
  vi.useFakeTimers();
  changes = 0;
  ctx = makeContext();
  ctx.store.patch('system', { connection: 'live', snapshotAt: ctx.clock.now - 1_000 });
  ctx.store.patch('activity', { lastActivityAt: ctx.clock.now - 1_000 });
});

afterEach(() => {
  controller?.destroy();
  vi.useRealTimers();
});

describe('gestureFor', () => {
  it('maps reactions to what the mascot does', () => {
    const table: [MascotReaction, string | null][] = [
      ['click', 'wink'],
      ['node', 'bounce'],
      ['agent', 'hop'],
      ['approved', 'hop'],
      ['denied', 'droop'],
      ['completed', 'jump'],
      ['goal-completed', 'celebrate'],
      ['failed', 'sweat'],
      ['lost', 'sweat'],
      ['approval', 'alert'],
      ['question', 'alert'],
      ['plan', 'alert'],
      ['halt', null],
    ];
    for (const [kind, gesture] of table) expect(gestureFor(kind), kind).toBe(gesture);
  });
});

describe('prefersReducedMotion', () => {
  it('follows the setting, then the system', () => {
    const yes = () => ({ matches: true });
    expect(prefersReducedMotion('reduce', null)).toBe(true);
    expect(prefersReducedMotion('full', yes)).toBe(false);
    expect(prefersReducedMotion('system', yes)).toBe(true);
    expect(prefersReducedMotion('system', () => ({ matches: false }))).toBe(false);
    expect(prefersReducedMotion('system', null)).toBe(false);
    expect(
      prefersReducedMotion('system', () => {
        throw new Error('no');
      }),
    ).toBe(false);
  });
});

describe('MascotController', () => {
  it('consumes each reaction once, in id order, and ignores the ones from before it started', () => {
    push('completed');
    mount();
    const spy = vi.spyOn(engine, 'gesture');
    push('node');
    push('approved');
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['bounce', 'hop']);
    // The same list again (another activity change) plays nothing new.
    ctx.store.patch('activity', { lastActivityAt: ctx.clock.now });
    expect(spy).toHaveBeenCalledTimes(2);
    // Out-of-order ids in one update are played by id.
    const a = ctx.store.select('activity');
    ctx.store.setState({
      activity: {
        ...a,
        reactions: [...a.reactions, { id: 101, kind: 'denied', at: ctx.clock.now }, { id: 100, kind: 'node', at: 0 }],
      },
    });
    expect(spy.mock.calls.slice(2).map((c) => c[0])).toEqual(['bounce', 'droop']);
  });

  it('picks the state from the store and tints the mascot with it', () => {
    mount();
    expect(controller.state).toBe('idle');
    const tint = vi.spyOn(engine, 'setTint');
    ctx.board(makeSnapshot({ approvals: [makeApproval()] }));
    expect(controller.state).toBe('approval');
    expect(engine.state).toBe('approval');
    expect(tint).toHaveBeenLastCalledWith({ r: 245, g: 158, b: 11 });
    ctx.store.patch('ui', { indexing: true });
    ctx.board(makeSnapshot());
    expect(controller.state).toBe('searching');
    expect(changes).toBeGreaterThan(0);
  });

  it('re-checks when a time-bound state runs out', () => {
    mount();
    ctx.store.patch('activity', {
      agents: {
        a: {
          current: { at: ctx.clock.now, tool: 'Edit', kind: 'write', target: null, decision: 'allow', taskId: null },
          log: [],
          usage: null,
          model: null,
        },
      },
    });
    expect(controller.state).toBe('working');
    ctx.clock.now += 3_000;
    vi.advanceTimersByTime(3_100);
    expect(controller.state).toBe('idle');
  });

  it('greets an agent that registers after the first snapshot', () => {
    ctx.board(makeSnapshot({ harnesses: [makeHarness()] }));
    mount();
    const spy = vi.spyOn(engine, 'gesture');
    ctx.board(makeSnapshot({ harnesses: [makeHarness()] }));
    expect(spy).not.toHaveBeenCalled();
    ctx.board(makeSnapshot({ harnesses: [makeHarness(), makeHarness({ harness_id: 'harness_2' })] }));
    expect(spy).toHaveBeenCalledWith('hop');
  });

  it('learns the agents from the first snapshot without greeting them', () => {
    ctx.store.setState({ board: null });
    mount();
    const spy = vi.spyOn(engine, 'gesture');
    ctx.board(makeSnapshot({ harnesses: [makeHarness()] }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('follows the motion preference', () => {
    mount();
    expect(engine.reduced).toBe(false);
    ctx.store.patch('prefs', { motion: 'reduce' });
    expect(engine.reduced).toBe(true);
    ctx.store.patch('prefs', { motion: 'full' });
    expect(engine.reduced).toBe(false);
  });

  it('winks on a click', () => {
    mount();
    const spy = vi.spyOn(engine, 'gesture');
    controller.click();
    expect(spy).toHaveBeenCalledWith('wink');
  });

  it('stops listening and clears its timer on destroy', () => {
    mount();
    const spy = vi.spyOn(engine, 'gesture');
    const state = vi.spyOn(engine, 'setState');
    controller.destroy();
    push('node');
    ctx.board(makeSnapshot({ approvals: [makeApproval()] }));
    expect(spy).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
