/**
 * The onboarding tour (plan §7.10): the steps Friday walks a first-time user through, in his own
 * voice. Each step either points at real UI or performs the navigation itself; steps whose
 * condition holds on its own advance without a click.
 */
import type { AppContext } from '../shell/context.js';
import { openDrawer, openModal } from '../shell/context.js';
import type { RootState } from '../store/state.js';
import { createTour, type TourDeps, type TourHandle, type TourStep } from './engine.js';

export type { TourHandle } from './engine.js';

/** True while the board has no goals at all (the fresh-install state). */
export function boardIsEmpty(state: RootState): boolean {
  return (state.board?.goals.length ?? 0) === 0;
}

/** The board has at least one goal (the user created one — the first step's auto-advance). */
export function hasGoal(state: RootState): boolean {
  return !boardIsEmpty(state);
}

/** The onboarding steps, in walking order. */
export const ONBOARDING_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    target: null,
    title: 'Hello, I am Friday',
    body: 'I turn what you want into plans, tasks and checked code. I will walk you around — four stops, two minutes, and you know the whole loop.',
    mood: 'happy',
  },
  {
    id: 'new-goal',
    target: '.dk-new-goal',
    title: 'Start with a goal',
    body: 'This is the New goal button. Describe what you want in one line — I will draft a plan of tasks for you to approve. Try it: I will follow along.',
    action: {
      id: 'open-new-goal',
      label: 'Open New goal',
      run: (ctx: AppContext) => openModal(ctx, { kind: 'new-goal' }),
    },
    mood: 'happy',
    advanceOn: hasGoal,
  },
  {
    id: 'board',
    target: '.cv-stage',
    title: 'Your board',
    body: 'Everything I do for you shows up here. Each card is a task, and each task runs in its own copy of the project, so experiments never touch your own files.',
    mood: 'neutral',
  },
  {
    id: 'approvals',
    target: '.sh-rail',
    title: 'Waiting for you',
    body: 'When an agent wants permission — a file to write, a command to run — it waits here. Allow once, for this run, or for the whole task. You are always the decider.',
    action: {
      id: 'open-agents',
      label: 'See agents & permissions',
      run: (ctx: AppContext) => openDrawer(ctx, { kind: 'agents' }),
    },
    mood: 'alert',
  },
  {
    id: 'notch',
    target: '.sh-notch-layer',
    title: 'I live in the notch',
    body: 'Approvals, questions and finished work pop up here, even when you are in another app. Click me any time.',
    mood: 'happy',
  },
  {
    id: 'finale',
    target: null,
    title: 'That is the loop',
    body: 'Goal, plan, tasks, checks, ready to land. Create your first goal and I will take it from there — I will ask when I need you.',
    nextLabel: 'Done',
    mood: 'happy',
  },
];

/** The Notch step where the Notch is not in this window (the desktop app: it is a window of its own). */
export const NOTCH_ELSEWHERE: TourStep = {
  id: 'notch',
  target: null,
  title: 'I am at the top of your screen too',
  body: 'The small Friday at the top edge of your screen shows approvals, questions and finished work, even when you are in another app. Click it any time.',
  mood: 'happy',
};

/**
 * The steps for this window. The Notch step pointed at the in-page Notch, which the desktop app's
 * Studio does not have: there the step pointed at nothing (2026-11-17). Without a Notch in the
 * page it says where the Notch is instead.
 */
export function onboardingSteps(doc: Pick<Document, 'querySelector'> | null): readonly TourStep[] {
  const inPage = doc?.querySelector('.sh-notch-layer > *') != null;
  return inPage ? ONBOARDING_STEPS : ONBOARDING_STEPS.map((s) => (s.id === 'notch' ? NOTCH_ELSEWHERE : s));
}

/**
 * Builds the tour and auto-starts it once, for a person who has never finished it, as soon as the
 * first snapshot is in (so the targets exist). Later boots stay quiet.
 */
export function startOnboardingTour(ctx: Pick<AppContext, 'store' | 'now' | 'api'>, deps: TourDeps): TourHandle {
  const tour = createTour(ctx, deps);
  if (tour.completedBefore) return tour;
  const tryStart = (): void => {
    if (tour.completedBefore || tour.active) return;
    if (ctx.store.select('board') === null) return; // no snapshot yet
    off();
    tour.start(onboardingSteps(typeof document === 'undefined' ? null : document));
  };
  const off = ctx.store.subscribe('board', tryStart);
  tryStart();
  return tour;
}
