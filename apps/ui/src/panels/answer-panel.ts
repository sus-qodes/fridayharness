/**
 * The answer to a question a person asked (2026-11-18): the question as they typed it, who
 * answered and when, and the answer laid out for reading. While an agent is still at it the
 * dialog says so and fills in when the answer arrives; a question that got no answer says that,
 * with a way to ask again. Opening an answer that is ready marks it read, so it leaves what waits
 * for the person.
 */
import type { AnswerView } from '@friday/protocol';
import { visible } from '../model/text.js';
import { type AppContext, type Component, type ModalRequest, openDrawer } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { timeAgo } from '../ui/format.js';
import { prose } from '../ui/prose.js';
import { errorOf, linkButton, note, panel, plain, Teardown } from './common.js';

/** What stands where the answer will be, for each state before it is there. */
export function waitingWords(a: Pick<AnswerView, 'state' | 'agent_key'>): string {
  const who = a.agent_key ? visible(a.agent_key) : 'An agent';
  if (a.state === 'waiting') return 'No agent has taken the question yet. It starts as soon as one is free.';
  if (a.state === 'answering') return `${who} is reading the project and writing the answer.`;
  if (a.state === 'failed') return `${who} ended without an answer.`;
  if (a.state === 'cancelled') return 'This question was cancelled.';
  return '';
}

export function answerModal(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'md' } {
  const td = new Teardown();
  const goalId = request.id ?? '';
  let shown: AnswerView | null = null;
  let reading = false;
  let marked = false;

  const question = h('p', { class: 'pn-answer-question' });
  const meta = h('div', { class: 'pn-answer-meta muted' });
  const body = h('div', { class: 'pn-answer-body' }, h('div', { class: 'muted' }, 'Reading…'));
  const actions = h('div', { class: 'pn-actions' });

  async function copy(text: string) {
    const ok = await ctx.platform.copy(text);
    ctx.toast(
      ok
        ? { kind: 'success', text: 'Copied the answer' }
        : { kind: 'warn', text: 'This page may not copy; select the text and copy it' },
    );
  }

  /** The same question, asked again as a new one. */
  async function askAgain(text: string) {
    const r = await ctx.act(
      'Ask again',
      () =>
        ctx.api.createGoal({
          request: text,
          constraints: [],
          outcomes: [],
          priority: 'normal',
          plan: false,
          mode: 'ask',
        }),
      'Asked again',
    );
    if (!r) return;
    ctx.refresh();
    close();
  }

  function render(a: AnswerView) {
    shown = a;
    question.textContent = plain(a.question, 4000);
    if (a.state === 'ready') {
      replace(
        meta,
        `${a.agent_key ? visible(a.agent_key) : 'An agent'} answered${a.at ? ` ${timeAgo(a.at, ctx.now())}` : ''}. Nothing in your project was changed.`,
      );
      const text = a.answer ?? a.summary ?? '';
      replace(body, text.trim() ? prose(text) : note('The agent finished without writing an answer.'));
      replace(
        actions,
        text.trim() ? button('Copy the answer', () => void copy(text), { class: 'btn' }) : null,
        button('Close', () => close(), { class: 'btn btn-primary' }),
      );
      return;
    }
    replace(meta);
    replace(
      body,
      h('p', { class: a.state === 'answering' ? 'pn-answer-working' : 'muted', role: 'status' }, waitingWords(a)),
      a.state === 'failed'
        ? note('Nothing in your project was changed. You can ask again, or look at what the agent did.')
        : null,
    );
    replace(
      actions,
      a.state === 'failed' && a.task_id
        ? linkButton('See what the agent did', () => {
            close();
            ctx.store.patch('ui', { selectedTaskId: a.task_id });
            openDrawer(ctx, { kind: 'inspector', id: a.task_id as string });
          })
        : null,
      a.state === 'failed' || a.state === 'cancelled'
        ? button('Ask again', () => void askAgain(a.question), { class: 'btn' })
        : null,
      button('Close', () => close(), { class: 'btn btn-primary' }),
    );
  }

  async function read() {
    if (reading || td.done) return;
    reading = true;
    try {
      const a = await ctx.api.goalAnswer(goalId);
      if (td.done) return;
      render(a);
      // Opened, so read: it no longer waits for the person. Also one that got no answer.
      if ((a.state === 'ready' || a.state === 'failed') && !a.read && !marked) {
        marked = true;
        await ctx.api.markAnswerRead(goalId).catch(() => undefined);
        ctx.refresh();
      }
    } catch (e) {
      if (td.done) return;
      const err = errorOf(e);
      replace(
        body,
        h('div', { class: 'field-error' }, `Could not read the answer: ${plain(err.message, 300)}`),
        linkButton('Try again', () => void read()),
      );
      replace(
        actions,
        button('Close', () => close(), { class: 'btn' }),
      );
    } finally {
      reading = false;
    }
  }

  const el = panel('pn-answer', h('div', { class: 'field-label' }, 'You asked'), question, meta, body, actions);

  // The board says when the answer arrives, or the attempt ends: the dialog reads it then.
  td.add(
    ctx.store.subscribe('board', (b) => {
      const now = b?.answers?.[goalId]?.state;
      if (now && shown && now !== shown.state) void read();
    }),
  );
  void read();

  return {
    title: 'Your question',
    size: 'md',
    el,
    destroy() {
      td.run();
      el.remove();
    },
  };
}
