/**
 * "Raise the limit and continue" (2026-11-17): an agent's host stopped an attempt at the agent's own
 * spending limit per attempt. Friday keeps the work and asks; this dialog is the answer in one
 * step: it saves a higher limit (or none) on the agent Friday remembers, then lets the task
 * continue from the work the attempt left. The agent itself keeps running: its limit is read again
 * at each attempt.
 *
 * An agent started by hand (a terminal) has no remembered limit to change: the dialog says so and
 * offers only to let the task continue, once the person has started the agent with a higher limit.
 */
import type { AgentProfile, EscalationView } from '@friday/protocol';
import { visible } from '../model/text.js';
import type { AppContext, Component, ModalRequest } from '../shell/context.js';
import { button, h } from '../ui/dom.js';
import { cleanText, truncate } from '../ui/format.js';
import { actWithError, field, input, note, panel, select, Teardown } from './common.js';
import { BUDGET } from './start-agent.js';

/** A stop at an agent's own spending limit, as the question's details describe it. */
export interface CapStop {
  taskId: string;
  agentKey: string | null;
  capUsd: number | null;
  costUsd: number | null;
}

const amount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Dollars as a person writes them: `$5`, `$0.5`, `$5.03`; never the noise of a binary sum. */
export function dollars(n: number): string {
  return `$${Number(n.toFixed(4))}`;
}

/** The stop a question is about, or null for any other question (the task's own cap among them). */
export function capStopOf(e: Pick<EscalationView, 'kind' | 'details' | 'task_id'>): CapStop | null {
  if (e.kind !== 'recovery_needed' || !e.task_id) return null;
  const d = (e.details ?? {}) as Record<string, unknown>;
  if (d.reason !== 'budget_exceeded' || d.scope !== 'agent') return null;
  return {
    taskId: e.task_id,
    agentKey: typeof d.agent_key === 'string' && d.agent_key ? d.agent_key : null,
    capUsd: amount(d.cap_usd),
    costUsd: amount(d.cost_usd),
  };
}

/** The limit proposed: twice the one reached (and more than the attempt cost), within what is allowed. */
export function proposedLimit(stop: Pick<CapStop, 'capUsd' | 'costUsd'>): number {
  const cap = stop.capUsd ?? BUDGET.default;
  const cost = stop.costUsd ?? 0;
  const twice = cap * 2 > cost ? cap * 2 : cost * 2;
  return Math.min(BUDGET.max, Math.max(BUDGET.min, Math.ceil(twice * 100) / 100));
}

/** Why an amount cannot be the new limit; null when it can. */
export function limitError(text: string, stop: Pick<CapStop, 'capUsd'>): string | null {
  const n = Number(text);
  if (!text.trim() || !Number.isFinite(n) || n < BUDGET.min || n > BUDGET.max) {
    return `between ${BUDGET.min} and ${BUDGET.max} dollars`;
  }
  // The same limit, or a lower one, stops the next attempt at the same place.
  if (stop.capUsd !== null && n <= stop.capUsd) return `more than ${dollars(stop.capUsd)}, the limit it reached`;
  return null;
}

export function raiseLimitModal(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'md' } {
  const td = new Teardown();
  const taskId = request.id ?? '';
  const question = (ctx.store.select('board')?.escalations ?? []).find(
    (e) => e.status === 'pending' && e.task_id === taskId && capStopOf(e) !== null,
  );
  const stop = question ? capStopOf(question) : null;
  if (!stop) {
    const el = panel('pn-raise-limit', h('p', { class: 'empty' }, 'This task no longer waits at a spending limit.'));
    return { el, title: 'Raise the limit', size: 'md', destroy: () => el.remove() };
  }
  const who = stop.agentKey ? visible(stop.agentKey) : 'The agent';
  const task = ctx.store.select('board')?.tasks.find((t) => t.task_id === taskId);

  let profile: AgentProfile | null = null;
  /** `loading`, then what Friday remembers of the agent: `known`, `unknown` (started by hand), or `failed`. */
  let state: 'loading' | 'known' | 'unknown' | 'failed' = 'loading';
  let choice: 'set' | 'none' = 'set';
  let text = String(proposedLimit(stop));
  let busy = false;

  const what = h(
    'p',
    { class: 'pn-raise-what' },
    `${who} stopped`,
    task ? [' “', truncate(cleanText(task.summary), 120), '”'] : ' the task',
    stop.capUsd === null ? ' at its spending limit.' : ` at its spending limit of ${dollars(stop.capUsd)} per try.`,
    stop.costUsd === null ? '' : ` This try had cost ${dollars(stop.costUsd)}.`,
    ' The work so far is kept: the next try goes on from it.',
  );
  const amountInput = input({
    type: 'number',
    value: text,
    min: String(BUDGET.min),
    max: String(BUDGET.max),
    step: '0.01',
  });
  amountInput.setAttribute('aria-label', 'New limit in dollars');
  amountInput.addEventListener('input', () => {
    text = amountInput.value;
    update();
  });
  const limit = select<'set' | 'none'>(
    [
      { value: 'set', label: 'Stop a try at (USD)' },
      { value: 'none', label: 'No limit' },
    ],
    choice,
    (v) => {
      choice = v;
      update();
    },
  );
  const limitField = field('New spending limit per try', limit, {
    hint: 'It applies from the agent’s next try; the agent keeps running. You can change it again under Agents → Edit.',
  });
  limitField.el.append(h('div', { class: 'pn-limit-amount' }, amountInput));
  const body = h('div', { class: 'pn-raise-body' });
  const serverError = h('div', { class: 'field-error pn-server-error', role: 'alert', hidden: true });
  const go = button('Raise the limit and continue', () => void run(), { class: 'btn btn-primary' });
  const cancel = button('Not now', () => close(), { class: 'btn btn-ghost' });

  const errorNow = (): string | null => (choice === 'none' ? null : limitError(text, stop));

  function update() {
    amountInput.disabled = choice === 'none' || busy;
    limit.disabled = busy;
    limitField.setError(state === 'known' ? errorNow() : null);
    go.textContent = state === 'unknown' ? 'Continue the task' : 'Raise the limit and continue';
    go.disabled = busy || state === 'loading' || state === 'failed' || (state === 'known' && errorNow() !== null);
  }

  function render() {
    if (state === 'loading') {
      body.replaceChildren(h('p', { class: 'muted' }, `Reading what Friday remembers of ${who}…`));
    } else if (state === 'failed') {
      body.replaceChildren(
        note('Friday could not read its agents. Nothing was changed.'),
        button('Try again', () => load(), { class: 'btn' }),
      );
    } else if (state === 'unknown') {
      body.replaceChildren(
        note(
          `${who} was not started from Friday (or Friday no longer remembers it), so its limit cannot be changed here. `,
          'Start it again with a higher limit, then let the task continue.',
        ),
      );
    } else {
      body.replaceChildren(limitField.el);
    }
    update();
  }

  function load() {
    state = 'loading';
    render();
    ctx.api.agentProcesses().then(
      (view) => {
        if (td.done) return;
        profile = view.profiles.find((p) => p.agent_key === stop?.agentKey && p.host === 'claude-code') ?? null;
        state = profile ? 'known' : 'unknown';
        render();
      },
      () => {
        if (td.done) return;
        state = 'failed';
        render();
      },
    );
  }

  async function run() {
    if (busy || state === 'loading' || state === 'failed') return;
    if (state === 'known' && errorNow() !== null) return;
    const value = choice === 'none' ? null : Number(text);
    const was = profile;
    busy = true;
    serverError.hidden = true;
    update();
    let saved = false;
    const said = value === null ? 'no limit' : `a limit of ${dollars(value)}`;
    const done = await actWithError(
      ctx,
      was ? 'Raise the limit' : 'Continue the task',
      async () => {
        if (was && stop?.agentKey) {
          // Everything else the agent was made with is kept; only the limit changes.
          await ctx.api.updateAgent(stop.agentKey, { options: { ...was.options, max_budget_usd: value } });
          saved = true;
        }
        return ctx.api.recover(
          taskId,
          'reassign',
          was
            ? `the agent's spending limit per try was raised: ${said}`
            : 'continued after a stop at the spending limit',
        );
      },
      (e) => {
        if (td.done) return;
        serverError.hidden = false;
        // Said apart: a saved limit stays saved, and the task can still be continued from Recover.
        serverError.textContent = saved
          ? `The new limit is saved, but the task could not continue: ${e.message}`
          : e.message;
      },
      was ? `${who} now runs with ${said}; the task continues` : 'The task continues',
    );
    busy = false;
    if (td.done) return;
    if (done) {
      ctx.refresh();
      close();
      return;
    }
    update();
  }

  const el = panel('pn-raise-limit', what, body, serverError, h('div', { class: 'pn-actions' }, cancel, go));
  if (stop.agentKey) load();
  else {
    state = 'unknown';
    render();
  }

  return {
    el,
    title: 'Raise the limit',
    size: 'md',
    destroy() {
      td.run();
      el.remove();
    },
  };
}
