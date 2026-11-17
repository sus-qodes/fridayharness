/**
 * "Change this goal…" (2026-11-17): a goal whose plan is running could not be changed from the
 * app. A person who saw that a task was missing, or wanted one done another way, had the plan
 * editor's revision mode, which nothing on the goal's card led to, or a terminal.
 *
 * The dialog takes what should be different in the person's own words and either asks the planner
 * for a new version from it, or opens the editor to write the change. Either way the result is a
 * proposed version that is reviewed before anything starts: nothing running is touched here.
 */
import { visible } from '../model/text.js';
import { type AppContext, type Component, type ModalRequest, openModal } from '../shell/context.js';
import { button, h } from '../ui/dom.js';
import { cleanText, truncate } from '../ui/format.js';
import { actWithError, field, note, panel, plain, Teardown, textarea } from './common.js';

export const CHANGE_NOTE_MAX = 2000;

/** What the planner answered, as the toast that follows it. */
export function replanToast(result: unknown): { kind: 'success' | 'warn'; text: string; detail?: string } {
  const said = typeof result === 'string' ? result : '';
  if (said.startsWith('proposed')) {
    return { kind: 'success', text: 'The planner proposed a change: review it on the board' };
  }
  return {
    kind: 'warn',
    text: 'The planner proposed no change',
    ...(said ? { detail: truncate(cleanText(said), 300) } : {}),
  };
}

export function changeGoalModal(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'md' } {
  const td = new Teardown();
  const goalId = request.id ?? '';
  const board = ctx.store.select('board');
  const goal = board?.goals.find((g) => g.goal_id === goalId) ?? null;
  const plans = board?.plans[goalId] ?? null;
  if (!goal || !plans?.active) {
    const el = panel(
      'pn-change-goal',
      h('p', { class: 'empty' }, goal ? 'This goal has no running plan to change.' : 'This goal is not on the board.'),
    );
    return { el, title: 'Change this goal', size: 'md', destroy: () => el.remove() };
  }
  const plannerReady = board?.brain?.planner_available === true;
  let busy = false;

  const what = textarea({
    rows: 4,
    maxLength: CHANGE_NOTE_MAX,
    placeholder: 'For example: also add a test for the empty cart, and leave the checkout page as it is',
  });
  const whatField = field('What should be different?', what, {
    hint: plannerReady
      ? 'The planner reads this and proposes a new version of the plan.'
      : 'No planner is ready, so the change is yours to write in the plan editor.',
  });
  const serverError = h('div', { class: 'field-error pn-server-error', role: 'alert', hidden: true });
  const status = h('div', { class: 'muted pn-change-status', role: 'status', aria: { live: 'polite' } });
  const write = button(
    'Write the change myself',
    () => openModal(ctx, { kind: 'plan-editor', id: goalId, mode: 'revision' }),
    { class: plannerReady ? 'btn' : 'btn btn-primary' },
  );
  const ask = button('Ask the planner', () => void run(), { class: 'btn btn-primary' });
  ask.hidden = !plannerReady;

  function update() {
    ask.disabled = busy || !what.value.trim();
    write.disabled = busy;
    what.disabled = busy;
  }
  what.addEventListener('input', update);

  async function run() {
    const text = what.value.trim();
    if (busy || !text) return;
    busy = true;
    serverError.hidden = true;
    status.textContent = 'Asking the planner… (a model call can take a minute)';
    update();
    const r = await actWithError(
      ctx,
      'Ask the planner for a change',
      () => ctx.api.replan(goalId, text),
      (e) => {
        if (td.done) return;
        serverError.hidden = false;
        serverError.textContent = plain(e.message, 1000);
      },
    );
    busy = false;
    if (td.done) return;
    status.textContent = '';
    update();
    if (!r) return;
    ctx.refresh();
    ctx.toast(replanToast(r.result));
    close();
  }

  const el = panel(
    'pn-change-goal',
    h('div', { class: 'pn-goal-line' }, h('span', { class: 'muted' }, 'Goal: '), plain(goal.request, 300)),
    note(
      'The change becomes a new version of the plan, which you review before anything starts. Tasks that are finished stay as they are.',
    ),
    plans.proposed
      ? note(
          `Version ${visible(String(plans.proposed.version))} is already proposed and waits for your review; a new one replaces it.`,
        )
      : null,
    whatField.el,
    status,
    serverError,
    h(
      'div',
      { class: 'pn-actions' },
      button('Not now', () => close(), { class: 'btn btn-ghost' }),
      write,
      ask,
    ),
  );
  update();

  return {
    el,
    title: 'Change this goal',
    size: 'md',
    destroy() {
      td.run();
      el.remove();
    },
  };
}
