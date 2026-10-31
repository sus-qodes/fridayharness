/**
 * The tour engine (plan §7.10 onboarding): a list of steps, Friday walking between them with a
 * thought bubble, a spotlight on each target, and auto-advance when the step's condition holds.
 * Progress persists locally; completion is also recorded as onboarding events in Friday's own
 * event log, so any surface can tell how far a person got.
 */
import { clickTick, playSound } from '../audio/index.js';
import type { BubbleAction, BubbleMessage } from '../mascot/bubble.js';
import type { MascotStageHandle, StageTarget } from '../mascot/stage.js';
import type { AppContext } from '../shell/context.js';
import type { RootState } from '../store/state.js';
import type { SpotlightHandle } from './spotlight.js';
export interface TourStep {
  /** Stable id, used for persistence and the onboarding events. */
  id: string;
  /** CSS selector of what to highlight, or null to stand centre stage. */
  target: string | null;
  /** What Friday says, first person. */
  body: string;
  /** Optional short heading above the body. */
  title?: string;
  /** The last button's words ('Next' by default, 'Done' on the last step). */
  nextLabel?: string;
  /** An extra primary action that performs the step's navigation. */
  action?: { id: string; label: string; run: (ctx: AppContext) => void };
  /** Friday's expression while talking (default 'happy'). */
  mood?: 'happy' | 'alert' | 'neutral';
  /** Auto-advance when this holds (checked on every store change). */
  advanceOn?: (state: RootState) => boolean;
}

export interface TourEnv {
  doc: Document;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  /** Local persistence for resume across restarts. */
  load(): { done: boolean; step: number } | null;
  save(progress: { done: boolean; step: number } | null): void;
  /** Where target rectangles come from (a fake in tests). */
  rectOf(selector: string): StageTarget | null;
}

export function defaultTourEnv(): TourEnv {
  const KEY = 'friday.tour.v1';
  const w = typeof window !== 'undefined' ? window : null;
  return {
    doc: document,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    load: () => {
      try {
        const raw = w?.localStorage?.getItem(KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const p = parsed as { done?: unknown; step?: unknown };
          return { done: p.done === true, step: typeof p.step === 'number' ? p.step : 0 };
        }
      } catch {
        // A broken record is no record.
      }
      return null;
    },
    save: (progress) => {
      try {
        if (progress === null) w?.localStorage?.removeItem(KEY);
        else w?.localStorage?.setItem(KEY, JSON.stringify(progress));
      } catch {
        // Storage may be full or blocked; the tour still runs.
      }
    },
    rectOf: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 || r.height > 0)) return null;
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },
  };
}

export interface TourHandle {
  /** The stage's overlay element (the tour mounts with it). */
  el: HTMLElement;
  destroy(): void;
  /** Starts (or resumes) `steps`; defaults to the onboarding tour. */
  start(steps?: readonly TourStep[]): void;
  /** Ends the tour; `completed` records it as done. */
  stop(completed?: boolean): void;
  next(): void;
  back(): void;
  readonly active: boolean;
  /** The current step's id, or null while idle. */
  readonly stepId: string | null;
  /** 1-based step number and the total, for "N of M" banners; 0 of 0 while idle. */
  readonly progress: { step: number; total: number };
  /** True when a previous run was finished (the tour does not auto-start again). */
  readonly completedBefore: boolean;
}

export interface TourDeps {
  stage: MascotStageHandle;
  spotlight: SpotlightHandle;
}

/** Milliseconds a store-driven auto-advance is debounced. */
const ADVANCE_DEBOUNCE_MS = 250;

export function createTour(
  ctx: Pick<AppContext, 'store' | 'now' | 'api'>,
  deps: TourDeps,
  env: TourEnv = defaultTourEnv(),
): TourHandle {
  const { stage, spotlight } = deps;
  let steps: readonly TourStep[] = [];
  let index = -1;
  let active = false;
  let offAction: (() => void) | null = null;
  const offStore: (() => void)[] = [];
  let advanceTimer: unknown = null;
  let farewellTimer: unknown = null;
  let completedBefore = env.load()?.done === true;

  function unbind(): void {
    offAction?.();
    offAction = null;
    for (const off of offStore.splice(0)) off();
    if (advanceTimer !== null) env.clearTimeout(advanceTimer);
    advanceTimer = null;
    if (farewellTimer !== null) env.clearTimeout(farewellTimer);
    farewellTimer = null;
  }

  function persist(): void {
    env.save(active ? { done: false, step: index } : null);
  }

  function record(event: 'started' | 'step_completed' | 'completed' | 'skipped', step?: string): void {
    // Fire-and-forget: onboarding events must never block or break the tour.
    ctx.api.recordOnboarding(event, step).catch(() => {});
  }

  function targetOf(step: TourStep): StageTarget | null {
    if (step.target === null) return null;
    return env.rectOf(step.target);
  }

  function show(): void {
    const step = steps[index];
    if (!step) return;
    const target = targetOf(step);
    spotlight.highlight(target);
    stage.moveTo(target);
    stage.say(message(step));
    if (step.mood !== 'neutral') stage.mascot.engine.express(step.mood === 'alert' ? 'wide' : 'happy', 1.6);
  }

  function message(step: TourStep): BubbleMessage {
    const last = index === steps.length - 1;
    const actions: BubbleAction[] = [];
    if (index > 0) actions.push({ id: 'back', label: 'Back' });
    if (step.action) actions.push({ id: step.action.id, label: step.action.label, kind: 'primary' });
    actions.push({
      id: 'next',
      label: step.nextLabel ?? (last ? 'Done' : 'Next'),
      kind: step.action ? undefined : 'primary',
    });
    actions.push({ id: 'skip', label: 'Skip tour' });
    return { title: step.title, body: step.body, actions, meta: `Step ${index + 1} of ${steps.length}` };
  }

  function onAction(action: BubbleAction): void {
    const step = steps[index];
    if (!step) return;
    if (action.id === 'next') {
      clickTick();
      if (index >= steps.length - 1) finish();
      else goNext();
      return;
    }
    if (action.id === 'back') {
      clickTick();
      goBack();
      return;
    }
    if (action.id === 'skip') {
      stopTour(false);
      return;
    }
    if (step.action && action.id === step.action.id) {
      clickTick();
      step.action.run(ctx as AppContext);
    }
  }

  function scheduleAdvanceCheck(): void {
    if (advanceTimer !== null) env.clearTimeout(advanceTimer);
    advanceTimer = env.setTimeout(() => {
      advanceTimer = null;
      const step = steps[index];
      if (!active || !step?.advanceOn) return;
      try {
        if (step.advanceOn(ctx.store.getState())) {
          record('step_completed', step.id);
          if (index >= steps.length - 1) finish();
          else goNext();
        }
      } catch {
        // A broken condition never breaks the tour.
      }
    }, ADVANCE_DEBOUNCE_MS);
  }

  function finish(): void {
    const step = steps[index];
    if (step) record('step_completed', step.id);
    record('completed');
    stage.say({ body: 'All set. I am here in the notch whenever you need me.' });
    stage.mascot.engine.gesture('celebrate');
    playSound('task_complete', { force: true });
    env.save({ done: true, step: steps.length - 1 });
    completedBefore = true;
    teardown();
    // The farewell lingers a moment, then Friday walks off stage.
    farewellTimer = env.setTimeout(() => stage.hide(), 3_500);
  }

  function teardown(): void {
    unbind();
    active = false;
    spotlight.clear();
    // The stage keeps the farewell visible for a moment; the tour no longer drives it.
  }

  return {
    el: stage.el,
    destroy(): void {
      if (active) this.stop(false);
      spotlight.destroy();
      stage.destroy();
    },
    get active() {
      return active;
    },
    get stepId() {
      return steps[index]?.id ?? null;
    },
    get progress() {
      return active ? { step: index + 1, total: steps.length } : { step: 0, total: 0 };
    },
    get completedBefore() {
      return completedBefore;
    },
    start(given?: readonly TourStep[]): void {
      if (active) return;
      steps = given ?? steps;
      if (steps.length === 0) return;
      const saved = env.load();
      index = saved && !saved.done && saved.step > 0 && saved.step < steps.length ? saved.step : 0;
      active = true;
      stage.show();
      spotlight.el.hidden = false;
      offAction = stage.onAction(onAction);
      offStore.push(ctx.store.subscribe('board', scheduleAdvanceCheck));
      offStore.push(ctx.store.subscribe('activity', scheduleAdvanceCheck));
      offStore.push(ctx.store.subscribe('ui', scheduleAdvanceCheck));
      record('started');
      show();
      playSound('greet', { force: true });
      persist();
    },
    stop(completed = false): void {
      stopTour(completed);
    },
    next(): void {
      goNext();
    },
    back(): void {
      goBack();
    },
  };

  function goNext(): void {
    if (!active || index >= steps.length - 1) return;
    const step = steps[index];
    if (step) record('step_completed', step.id);
    index += 1;
    persist();
    show();
  }

  function goBack(): void {
    if (!active || index <= 0) return;
    index -= 1;
    persist();
    show();
  }

  function stopTour(completed = false): void {
    if (!active) return;
    if (completed) {
      finish();
      return;
    }
    record('skipped', steps[index]?.id);
    env.save({ done: true, step: index });
    completedBefore = true;
    stage.say(null);
    teardown();
    // Skipped: Friday leaves at once. (Only the completed farewell lingers; plan §7.10.)
    stage.hide();
  }
}
