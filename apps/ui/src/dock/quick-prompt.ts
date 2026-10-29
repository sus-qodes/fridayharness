/**
 * The desktop Notch's goal line (plan FD-14 as amended by the product review, M9k.7; ERRATA F21):
 * one field, "Describe a goal…". `Enter` offers "Create a goal: <text>? Press Enter"; a second
 * `Enter` on the unchanged line creates the goal, planned by the Master Brain when it can plan,
 * otherwise with its plan editor opened, as the New goal dialog does. It understands no command
 * words: pausing, halting, approving and the rest are buttons in the same card or one click away.
 */
import { GOAL_LIMITS } from '../panels/new-goal.js';
import { type AppContext, type Component, openModal } from '../shell/context.js';
import { h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { EMPTY_HINT, goalLine } from './quick-prompt-parse.js';

type Tone = 'hint' | 'ok' | 'error' | 'ask';

export interface QuickPromptOptions {
  /** Called after a goal was created (the Notch folds the card); not while the offer waits for Enter. */
  onDone?: () => void;
}

let counter = 0;

export const GOAL_PLACEHOLDER = 'Describe a goal…';

export function quickPrompt(ctx: AppContext, opts: QuickPromptOptions = {}): Component {
  const feedbackId = `dk-qp-feedback-${++counter}`;
  const input = h('input', {
    class: 'input dk-qp-input',
    type: 'text',
    placeholder: GOAL_PLACEHOLDER,
    autocomplete: 'off',
    spellcheck: true,
    // The line is one goal's request: the length the New goal dialog allows.
    maxLength: GOAL_LIMITS.requestMax,
    aria: { label: 'Describe a goal', describedby: feedbackId },
  });
  const feedback = h('div', { class: 'dk-qp-feedback', id: feedbackId, role: 'status', aria: { live: 'polite' } });
  const el = h(
    'div',
    { class: 'dk-qp' },
    h('div', { class: 'dk-qp-row' }, h('span', { class: 'dk-qp-mark' }, icon('goal', 14)), input),
    feedback,
  );

  /** The goal offered by the last Enter, and the line as it was then: only that line creates it. */
  let pending: { text: string; line: string } | null = null;
  let busy = false;
  let destroyed = false;

  function show(tone: Tone, ...content: (Node | string)[]): void {
    feedback.className = `dk-qp-feedback dk-qp-${tone}`;
    replace(feedback, ...content);
  }

  function clearFeedback(): void {
    feedback.className = 'dk-qp-feedback';
    replace(feedback);
  }

  async function createGoal(text: string): Promise<void> {
    const board = ctx.store.select('board');
    const plan = board?.brain?.planner_available ?? false;
    const r = await ctx.act(
      'Create a goal',
      () => ctx.api.createGoal({ request: text, constraints: [], outcomes: [], priority: 'normal', plan }),
      plan ? 'Goal created: the Master Brain plans it' : 'Goal created: write its plan',
    );
    if (destroyed) return;
    if (!r) {
      show('error', 'The goal was not created.');
      return;
    }
    ctx.refresh();
    // Without a planner nobody else writes the plan: its editor opens on the new goal.
    if (!plan && r.goal_id) openModal(ctx, { kind: 'plan-editor', id: r.goal_id, mode: 'first' });
    input.value = '';
    show('ok', plan ? 'Goal created.' : 'Goal created: write its plan in the editor.');
    opts.onDone?.();
  }

  async function submit(): Promise<void> {
    const line = input.value;
    if (pending && line === pending.line) {
      const text = pending.text;
      pending = null;
      await createGoal(text);
      return;
    }
    pending = null;
    const parsed = goalLine(line);
    if (parsed.kind === 'empty') {
      show('hint', EMPTY_HINT);
      return;
    }
    if (parsed.kind === 'invalid') {
      show('error', parsed.message);
      return;
    }
    pending = { text: parsed.text, line };
    // The human's own words: shown as text, in full.
    show(
      'ask',
      h(
        'span',
        { class: 'dk-qp-ask' },
        'Create a goal: ',
        h('span', { class: 'dk-qp-goal' }, parsed.text),
        '? ',
        h('strong', null, 'Press Enter'),
      ),
    );
  }

  async function onEnter(): Promise<void> {
    if (busy) return;
    busy = true;
    el.classList.add('dk-qp-busy');
    try {
      await submit();
    } finally {
      busy = false;
      el.classList.remove('dk-qp-busy');
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      // The line owns Enter: it never reaches an approval card's keys (plan FD-28).
      event.preventDefault();
      event.stopPropagation();
      // A held-down Enter repeats: only a new press may confirm what the first one offered (review M9i).
      if (event.repeat) return;
      void onEnter();
    } else if (event.key === 'Escape' && (input.value || pending)) {
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      pending = null;
      clearFeedback();
    }
  }

  function onInput(): void {
    if (pending && input.value !== pending.line) {
      pending = null;
      clearFeedback();
    }
  }

  input.addEventListener('keydown', onKey);
  input.addEventListener('input', onInput);

  return {
    el,
    destroy() {
      destroyed = true;
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('input', onInput);
      el.remove();
    },
  };
}
