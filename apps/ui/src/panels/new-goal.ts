/**
 * New goal (plan §7.7): the request, the human's constraints and outcomes, a priority, then
 * either "Let the Master Brain plan" (only while a planner is ready; otherwise the reason in
 * interface words and a way to Settings → Planner) or "Write the plan myself", which opens the
 * plan editor on the new goal.
 */
import type { BrainStatusView } from '@friday/protocol';
import { type DraftPriority, PRIORITIES } from '../model/plan-draft.js';
import { PRIORITY } from '../model/status.js';
import {
  type AppContext,
  type Component,
  closeModal,
  type ModalRequest,
  openDrawer,
  openModal,
} from '../shell/context.js';
import { button, h } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { field, input, linkButton, note, panel, plannerState, select, Teardown, textarea } from './common.js';

export const GOAL_LIMITS = { requestMin: 3, requestMax: 4000, items: 12, itemMax: 300 } as const;

export interface GoalForm {
  request: string;
  constraints: string[];
  outcomes: string[];
  priority: DraftPriority;
}

export interface GoalFormState {
  /** The form can be sent ("Write the plan myself"). */
  valid: boolean;
  /** "Let the Master Brain plan" is enabled. */
  canPlan: boolean;
  errors: { request?: string; constraints?: string; outcomes?: string };
  /** Why the Master Brain cannot plan, in interface words (null when it can). */
  plannerText: string | null;
}

function listError(items: readonly string[], what: string): string | undefined {
  const filled = items.map((s) => s.trim()).filter(Boolean);
  if (filled.length > GOAL_LIMITS.items) return `at most ${GOAL_LIMITS.items} ${what}`;
  if (filled.some((s) => Array.from(s).length > GOAL_LIMITS.itemMax))
    return `each has at most ${GOAL_LIMITS.itemMax} characters`;
  return undefined;
}

/** The enabling rules of the new-goal form (pure). */
export function goalFormState(form: GoalForm, brain: BrainStatusView | null | undefined): GoalFormState {
  const errors: GoalFormState['errors'] = {};
  const n = Array.from(form.request.trim()).length;
  if (n < GOAL_LIMITS.requestMin) errors.request = `describe the goal in at least ${GOAL_LIMITS.requestMin} characters`;
  else if (n > GOAL_LIMITS.requestMax) errors.request = `at most ${GOAL_LIMITS.requestMax} characters`;
  const c = listError(form.constraints, 'constraints');
  if (c) errors.constraints = c;
  const o = listError(form.outcomes, 'outcomes');
  if (o) errors.outcomes = o;
  const valid = Object.keys(errors).length === 0;
  const planner = plannerState(brain);
  return { valid, canPlan: valid && planner.ready, errors, plannerText: planner.ready ? null : planner.text };
}

/** How a request is taken up: planned first, done at once as one task, or asked as a question. */
export type GoalMode = 'plan' | 'do' | 'ask';

/** The request body `POST goals` takes. */
export function goalBody(form: GoalForm, plan: boolean, mode: GoalMode = 'plan') {
  return {
    request: form.request.trim(),
    constraints: form.constraints.map((s) => s.trim()).filter(Boolean),
    outcomes: form.outcomes.map((s) => s.trim()).filter(Boolean),
    priority: form.priority,
    // A question and a single task need no plan.
    plan: mode === 'plan' ? plan : false,
    ...(mode === 'plan' ? {} : { mode }),
  };
}

/** An editable list of short lines with Add and Remove. */
export function lineList(opts: {
  label: string;
  items: string[];
  placeholder: string;
  max: number;
  onChange: (items: string[]) => void;
}): { el: HTMLElement; setError(message: string | null): void; focus(): void } {
  const items = [...opts.items];
  const rows = h('ul', { class: 'pn-lines' });
  const error = h('div', { class: 'field-error', hidden: true, role: 'alert' });
  const addBtn = button(
    [icon('plus', 14), `Add ${opts.label.toLowerCase().replace(/s$/, '')}`],
    () => {
      items.push('');
      render();
      const inputs = rows.querySelectorAll('input');
      (inputs[inputs.length - 1] as HTMLInputElement | undefined)?.focus();
      opts.onChange([...items]);
    },
    { class: 'btn btn-ghost pn-lines-add' },
  );
  function render() {
    addBtn.disabled = items.length >= opts.max;
    rows.replaceChildren(
      ...items.map((value, i) => {
        const box = input({
          value,
          placeholder: opts.placeholder,
          maxLength: 300,
          aria: { label: `${opts.label} ${i + 1}` },
        });
        box.addEventListener('input', () => {
          items[i] = box.value;
          opts.onChange([...items]);
        });
        return h(
          'li',
          { class: 'pn-line' },
          box,
          button(
            icon('close', 12),
            () => {
              items.splice(i, 1);
              render();
              opts.onChange([...items]);
            },
            { class: 'btn btn-ghost btn-icon', ariaLabel: `Remove ${opts.label.toLowerCase()} ${i + 1}` },
          ),
        );
      }),
    );
  }
  render();
  const el = h('div', { class: 'pn-linelist' }, h('div', { class: 'field-label' }, opts.label), rows, addBtn, error);
  return {
    el,
    setError(message) {
      error.hidden = !message;
      error.textContent = message ?? '';
    },
    focus() {
      const first = rows.querySelector('input');
      if (first) first.focus();
      else addBtn.focus();
    },
  };
}

export function newGoalModal(
  ctx: AppContext,
  _request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'md' } {
  const td = new Teardown();
  const form: GoalForm = { request: '', constraints: [], outcomes: [], priority: 'normal' };
  let busy = false;

  const request = textarea({
    rows: 4,
    maxLength: GOAL_LIMITS.requestMax,
    placeholder: 'What should be done? For example: Add Stripe subscriptions and keep one-time checkout working',
  });
  const requestField = field('Request', request, {
    hint: 'Say what you want, in your words. Friday keeps it as you wrote it.',
  });
  request.addEventListener('input', () => {
    form.request = request.value;
    update();
  });

  const constraints = lineList({
    label: 'Constraints',
    items: [],
    placeholder: 'keep one-time checkout working',
    max: GOAL_LIMITS.items,
    onChange: (v) => {
      form.constraints = v;
      update();
    },
  });
  const outcomes = lineList({
    label: 'Outcomes',
    items: [],
    placeholder: 'the tests pass',
    max: GOAL_LIMITS.items,
    onChange: (v) => {
      form.outcomes = v;
      update();
    },
  });

  const priority = select(
    PRIORITIES.map((p) => ({ value: p, label: PRIORITY[p]?.label ?? p })),
    form.priority,
    (v) => {
      form.priority = v;
    },
  );

  const planBtn = button([icon('bolt', 14), 'Let Friday plan'], () => void submit(true), {
    class: 'btn btn-primary',
  });
  const writeBtn = button([icon('goal', 14), 'Write the plan myself'], () => void submit(false), { class: 'btn' });
  // Without a plan (2026-11-18): a question is answered and nothing changed; one task starts at once.
  const askBtn = button([icon('question', 14), 'Just answer this'], () => void submit(false, 'ask'), {
    class: 'btn',
    title: 'One agent reads the project and answers. Nothing is changed, checked or landed',
  });
  const doBtn = button([icon('play', 14), 'Do it now, one agent'], () => void submit(false, 'do'), {
    class: 'btn',
    title: 'One agent starts on this at once: no plan to wait for or approve. Its work is checked and landed as usual',
  });
  const plannerLine = h('div', { class: 'pn-planner-why' });

  const el = panel(
    'pn-new-goal',
    requestField.el,
    h('div', { class: 'pn-grid2' }, constraints.el, outcomes.el),
    field('Priority', priority).el,
    plannerLine,
    note(
      'A plan splits the work into tasks you approve first. For a question, or something small enough for one agent, skip it.',
    ),
    h('div', { class: 'pn-actions' }, askBtn, doBtn, writeBtn, planBtn),
  );

  function update() {
    const board = ctx.store.select('board');
    const state = goalFormState(form, board?.brain);
    requestField.setError(form.request.length > 0 ? (state.errors.request ?? null) : null);
    constraints.setError(state.errors.constraints ?? null);
    outcomes.setError(state.errors.outcomes ?? null);
    planBtn.disabled = busy || !state.canPlan;
    writeBtn.disabled = busy || !state.valid;
    askBtn.disabled = busy || !state.valid;
    doBtn.disabled = busy || !state.valid;
    if (state.plannerText) {
      plannerLine.hidden = false;
      plannerLine.replaceChildren(
        note(state.plannerText, ' You can always write the plan yourself.'),
        linkButton('Open Settings → Planner', () => {
          closeModal(ctx);
          openDrawer(ctx, { kind: 'settings', tab: 'planner' });
        }),
      );
    } else {
      plannerLine.hidden = true;
      plannerLine.replaceChildren();
    }
  }

  async function submit(plan: boolean, mode: GoalMode = 'plan') {
    const state = goalFormState(form, ctx.store.select('board')?.brain);
    if (!state.valid || (plan && !state.canPlan) || busy) {
      requestField.setError(state.errors.request ?? null);
      if (state.errors.request) request.focus();
      return;
    }
    busy = true;
    update();
    const goal = await ctx.act(
      mode === 'ask' ? 'Ask the question' : mode === 'do' ? 'Start the task' : 'Create the goal',
      () => ctx.api.createGoal(goalBody(form, plan, mode)),
      mode === 'ask'
        ? 'Asked: the answer appears here when it is ready'
        : mode === 'do'
          ? 'Started: one agent takes it now'
          : plan
            ? 'Goal created: Friday is planning it'
            : 'Goal created: write its plan',
    );
    busy = false;
    if (td.done) return;
    update();
    if (!goal) return;
    ctx.refresh();
    if (plan || mode !== 'plan') close();
    else openModal(ctx, { kind: 'plan-editor', id: goal.goal_id, mode: 'first' });
  }

  td.add(ctx.store.subscribe('board', () => update()));
  update();
  queueMicrotask(() => {
    if (!td.done) request.focus();
  });

  return {
    title: 'New goal',
    size: 'md',
    el,
    destroy() {
      td.run();
      el.remove();
    },
  };
}
