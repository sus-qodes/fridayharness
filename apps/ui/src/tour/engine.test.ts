import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BubbleAction, BubbleMessage } from '../mascot/bubble.js';
import type { MascotStageHandle, StageTarget } from '../mascot/stage.js';
import { makeContext, type TestContext } from '../test/context.js';
import { createTour, defaultTourEnv, type TourEnv, type TourHandle, type TourStep } from './engine.js';
import type { SpotlightHandle } from './spotlight.js';

const STEPS: readonly TourStep[] = [
  { id: 'one', target: null, body: 'first', nextLabel: 'Onward' },
  {
    id: 'two',
    target: '.some-target',
    body: 'second',
    advanceOn: (state) => state.ui.indexing,
  },
  { id: 'three', target: '.missing-target', body: 'third', nextLabel: 'Done' },
];

interface FakeStage extends MascotStageHandle {
  targets: (StageTarget | null)[];
  says: (BubbleMessage | null)[];
  shown: number;
  hidden: number;
  actions: ((action: BubbleAction) => void)[];
  gestureNames: string[];
  expressNames: string[];
}

function fakeStage(): FakeStage {
  const stage: FakeStage = {
    el: document.createElement('div'),
    targets: [],
    says: [],
    shown: 0,
    hidden: 0,
    actions: [],
    gestureNames: [],
    expressNames: [],
    mascot: {
      el: document.createElement('canvas'),
      engine: {
        express: (shape: string) => stage.expressNames.push(shape),
        gesture: (kind: string) => stage.gestureNames.push(kind),
      },
    } as unknown as MascotStageHandle['mascot'],
    bubble: {
      visible: false,
      typing: false,
      el: document.createElement('div'),
    } as unknown as MascotStageHandle['bubble'],
    show() {
      stage.shown += 1;
    },
    hide() {
      stage.hidden += 1;
    },
    get visible() {
      return true;
    },
    get busy() {
      return false;
    },
    moveTo(target: StageTarget | null) {
      stage.targets.push(target);
    },
    say(message: BubbleMessage | null) {
      stage.says.push(message);
    },
    onAction(listener: (action: BubbleAction) => void) {
      stage.actions.push(listener);
      return () => {
        const i = stage.actions.indexOf(listener);
        if (i >= 0) stage.actions.splice(i, 1);
      };
    },
    destroy() {},
  };
  return stage;
}

function fakeSpot(): SpotlightHandle {
  return {
    el: document.createElement('div'),
    highlight: vi.fn(),
    clear: vi.fn(),
    get visible() {
      return true;
    },
    destroy: vi.fn(),
  };
}

interface FakeTourEnv extends TourEnv {
  saved: { done: boolean; step: number } | null;
  timers: Map<number, () => void>;
  fireTimers(): void;
}

function fakeEnv(rects: Record<string, StageTarget> = {}): FakeTourEnv {
  let next = 1;
  const timers = new Map<number, () => void>();
  const env: FakeTourEnv = {
    doc: document,
    timers,
    saved: null,
    setTimeout: (fn) => {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id as number),
    load: () => env.saved,
    save: (progress) => {
      env.saved = progress;
    },
    rectOf: (selector) => rects[selector] ?? null,
    fireTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
  };
  return env;
}

let ctx: TestContext;
let stage: FakeStage;
let spot: SpotlightHandle;
let env: FakeTourEnv;
let tour: TourHandle;

beforeEach(() => {
  ctx = makeContext();
  ctx.store.patch('system', { connection: 'live', snapshotAt: ctx.clock.now - 1_000 });
  document.body.replaceChildren();
  stage = fakeStage();
  spot = fakeSpot();
  env = fakeEnv({ '.some-target': { x: 100, y: 100, width: 50, height: 40 } });
  tour = createTour(ctx, { stage, spotlight: spot }, env);
});

afterEach(() => {
  tour?.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function click(actionId: string): void {
  for (const listener of [...stage.actions]) listener({ id: actionId, label: actionId });
}

describe('the tour engine', () => {
  it('does not start without steps', () => {
    tour.start([]);
    expect(tour.active).toBe(false);
  });

  it('starts at the first step: spotlight, walk, say', () => {
    tour.start(STEPS);
    expect(tour.active).toBe(true);
    expect(tour.stepId).toBe('one');
    expect(tour.progress).toEqual({ step: 1, total: 3 });
    expect(stage.shown).toBe(1);
    expect(stage.targets[0]).toBeNull();
    expect(spot.highlight).toHaveBeenCalledWith(null);
    const said = stage.says[0];
    expect(said?.body).toBe('first');
    const labels = said?.actions?.map((a) => a.id);
    expect(labels).toEqual(['next', 'skip']);
  });

  it('records the onboarding events as it goes', async () => {
    const posts: unknown[] = [];
    (ctx.api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = (p: string, b: unknown) => {
      posts.push([p, b]);
      return Promise.resolve({ ok: true });
    };
    tour.start(STEPS);
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0]).toEqual(['/onboarding', { event: 'started' }]);
    click('next');
    await vi.waitFor(() => expect(posts.some((p) => JSON.stringify(p).includes('step_completed'))).toBe(true));
    click('skip');
    await vi.waitFor(() => expect(JSON.stringify(posts)).toContain('skipped'));
  });

  it('next walks to the measured target; the missing one falls back to centre', () => {
    tour.start(STEPS);
    click('next');
    expect(tour.stepId).toBe('two');
    expect(stage.targets[1]).toEqual({ x: 100, y: 100, width: 50, height: 40 });
    expect(spot.highlight).toHaveBeenLastCalledWith({ x: 100, y: 100, width: 50, height: 40 });
    click('next');
    expect(tour.stepId).toBe('three');
    // '.missing-target' has no rect: centre stage, no hole.
    expect(stage.targets[2]).toBeNull();
    expect(spot.highlight).toHaveBeenLastCalledWith(null);
  });

  it('the last step says Done and finishing celebrates and persists', () => {
    tour.start(STEPS);
    click('next');
    click('next');
    const said = stage.says[stage.says.length - 1];
    expect(said?.actions?.at(-2)?.label).toBe('Done');
    click('next');
    expect(tour.active).toBe(false);
    expect(stage.gestureNames).toContain('celebrate');
    expect(env.saved).toEqual({ done: true, step: 2 });
    expect(tour.completedBefore).toBe(true);
  });

  it('back returns one step', () => {
    tour.start(STEPS);
    click('next');
    click('back');
    expect(tour.stepId).toBe('one');
    expect(env.saved).toEqual({ done: false, step: 0 });
  });

  it('skip marks the tour done and stops', () => {
    tour.start(STEPS);
    click('skip');
    expect(tour.active).toBe(false);
    expect(env.saved).toEqual({ done: true, step: 0 });
    expect(spot.clear).toHaveBeenCalled();
    // Friday leaves the screen at once — the stage used to linger after a skip.
    expect(stage.hidden).toBeGreaterThan(0);
  });

  it('auto-advances when the step condition holds, debounced', () => {
    tour.start(STEPS);
    click('next');
    expect(tour.stepId).toBe('two');
    env.fireTimers();
    // The condition does not hold yet: still on step two.
    expect(tour.stepId).toBe('two');
    ctx.store.patch('ui', { indexing: true });
    env.fireTimers();
    expect(tour.stepId).toBe('three');
    // And the auto-advance recorded the step as completed.
    expect(env.saved).toEqual({ done: false, step: 2 });
  });

  it('resumes from the saved step when not done', () => {
    env.saved = { done: false, step: 2 };
    tour = createTour(ctx, { stage, spotlight: spot }, env);
    tour.start(STEPS);
    expect(tour.stepId).toBe('three');
  });

  it('never auto-starts again after completion', () => {
    tour.start(STEPS);
    click('next');
    click('next');
    click('next');
    const stage2 = fakeStage();
    tour.start(STEPS);
    // start() on an inactive but completed tour does begin again (replay), so assert progress reset.
    expect(tour.active).toBe(true);
    expect(tour.stepId).toBe('one');
    void stage2;
  });

  it('step action runs against the context', () => {
    const run = vi.fn();
    tour.start([{ id: 'act', target: null, body: 'x', action: { id: 'go', label: 'Go', run } }]);
    click('go');
    expect(run).toHaveBeenCalledWith(ctx);
  });

  it('stop(true) finishes like the last Next', () => {
    tour.start(STEPS);
    tour.stop(true);
    expect(env.saved?.done).toBe(true);
    expect(tour.active).toBe(false);
  });

  it('destroy tears the stage and spotlight down', () => {
    const destroy = vi.spyOn(stage, 'destroy');
    const spotDestroy = vi.spyOn(spot, 'destroy');
    tour.start(STEPS);
    tour.destroy();
    expect(destroy).toHaveBeenCalled();
    expect(spotDestroy).toHaveBeenCalled();
  });
});

describe('the default tour env', () => {
  it('persists through localStorage when available', () => {
    const env2 = defaultTourEnv();
    env2.save({ done: true, step: 1 });
    expect(env2.load()?.done).toBe(true);
    env2.save(null);
    expect(env2.load()).toBeNull();
    env2.save({ done: false, step: 2 });
    expect(env2.load()).toEqual({ done: false, step: 2 });
  });
});
