/**
 * A waiting agent (plan §7.5, FD-22): a task WAITING(blocked) or WAITING(human_approval) shows
 * what the agent said it needs, with Answer and continue (the note reaches the agent and a spawned
 * run resumes in the same session), Continue, Release and Cancel. An attached session in an
 * editor cannot be resumed by Friday: the answer then says to prompt it there.
 */
import type { SnapshotTask } from '@friday/protocol';
import { visible } from '../model/text.js';
import type { AppContext, Component } from '../shell/context.js';
import { button, h, setText } from '../ui/dom.js';
import { cleanText, timeAgo } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { ARMING_TEXT, armDecisions, type Clock } from './arming.js';
import { agentText, nextId, taskLine } from './common.js';
import { pendingApprovals } from './decisions.js';

export interface WaitingCardOptions {
  compact?: boolean;
  onDone?: () => void;
  clock?: Clock;
}

/** Shown when Friday cannot continue the session itself. */
export const ATTACHED_HINT = 'Sessions attached in VS Code need a prompt there to continue.';

export function waitingCard(ctx: AppContext, task: SnapshotTask, opts: WaitingCardOptions = {}): Component {
  const board = ctx.store.select('board');
  const titleId = nextId('waiting-title');
  const blocked = task.waiting_reason === 'blocked';
  const hint = h('div', { class: 'gv-arming-hint', aria: { live: 'polite' } }, ARMING_TEXT);
  const status = h('div', { class: 'gv-status', role: 'status', aria: { live: 'polite' } });
  const reasonBox = h('div', { class: 'gv-continue-reason', role: 'note', hidden: true });
  const noteId = nextId('continue-note');
  const note = h('textarea', {
    class: 'textarea',
    id: noteId,
    rows: 2,
    maxLength: 2000,
    placeholder: 'Your answer for the agent…',
  });
  let busy = false;

  const pendingApproval = pendingApprovals(board, ctx.now()).find((a) => a.task_id === task.task_id) ?? null;

  const run = async (b: HTMLButtonElement, withNote: boolean): Promise<void> => {
    if (busy) return;
    const text = note.value.trim();
    if (withNote && !text) {
      setText(status, 'Write the answer first.');
      note.focus();
      return;
    }
    busy = true;
    b.disabled = true;
    setText(status, 'Continuing…');
    const r = await ctx.act('Continue the agent', () =>
      ctx.api.continueTask(task.task_id, withNote ? text : undefined),
    );
    busy = false;
    b.disabled = false;
    if (!r) {
      setText(status, '');
      return;
    }
    if (r.continued) {
      setText(status, withNote ? 'Sent; the agent continues with your answer' : 'The agent continues');
      reasonBox.hidden = true;
      ctx.refresh();
      opts.onDone?.();
    } else {
      setText(status, withNote ? 'Your answer reached the agent as a message.' : '');
      reasonBox.hidden = false;
      reasonBox.replaceChildren(
        h('strong', null, 'Friday could not continue it: '),
        cleanText(r.reason ?? 'its session cannot be resumed from here'),
        h('br'),
        ATTACHED_HINT,
      );
      ctx.refresh();
    }
  };

  const confirmed = async (
    b: HTMLButtonElement,
    action: 'release' | 'cancel',
    confirm: { title: string; body: string[]; confirmLabel: string },
  ): Promise<void> => {
    if (busy) return;
    const ok = await ctx.confirm({ ...confirm, cancelLabel: 'Keep it', danger: true });
    if (!ok) return;
    busy = true;
    b.disabled = true;
    const r = await ctx.act(
      action === 'release' ? 'Release the task' : 'Cancel the task',
      () => ctx.api.taskAction(task.task_id, action),
      action === 'release' ? 'Task released to READY' : 'Task cancelled',
    );
    busy = false;
    b.disabled = false;
    if (r) {
      ctx.refresh();
      opts.onDone?.();
    }
  };

  const answerBtn = button('Answer and continue', () => undefined, { class: 'btn btn-primary gv-decide' });
  const continueBtn = button('Continue', () => undefined, { class: 'btn gv-decide' });
  const releaseBtn = button('Release', () => undefined, { class: 'btn gv-decide' });
  const cancelBtn = button('Cancel task', () => undefined, { class: 'btn btn-danger gv-decide' });

  const el = h(
    'section',
    {
      class: ['gv-card', 'gv-waiting', opts.compact && 'gv-compact'],
      role: 'group',
      aria: { labelledby: titleId },
      dataset: { taskId: task.task_id },
    },
    h(
      'header',
      { class: 'gv-card-head' },
      h('span', { class: 'gv-card-icon gv-tone-waiting' }, icon('hourglass', 16)),
      h(
        'h3',
        { class: 'gv-card-title', id: titleId },
        blocked ? 'An agent waits for you' : 'An agent waits for an approval',
      ),
      h('span', { class: 'spacer' }),
      h('span', { class: 'gv-age muted' }, timeAgo(task.updated_at, ctx.now())),
    ),
    h(
      'p',
      { class: 'gv-from' },
      h('strong', { class: 'mono' }, visible(task.agent_key ?? 'an agent')),
      ' · ',
      taskLine(board, task.task_id),
    ),
    agentText('What the agent needs', task.waiting_note, 'gv-waiting-note'),
    pendingApproval
      ? h('p', { class: 'field-hint' }, 'Its approval request waits in the list: deciding it lets the agent continue.')
      : null,
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: noteId }, 'Answer'), note),
    h('div', { class: 'gv-actions' }, answerBtn, continueBtn, releaseBtn, cancelBtn),
    reasonBox,
    hint,
    status,
  );

  const arming = armDecisions(el, {
    key: JSON.stringify([task.task_id, task.waiting_reason, task.waiting_note]),
    hint,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  for (const b of [answerBtn, continueBtn, releaseBtn, cancelBtn]) arming.register(b);
  answerBtn.addEventListener(
    'click',
    arming.guard(() => void run(answerBtn, true)),
  );
  continueBtn.addEventListener(
    'click',
    arming.guard(() => void run(continueBtn, false)),
  );
  releaseBtn.addEventListener(
    'click',
    arming.guard(
      () =>
        void confirmed(releaseBtn, 'release', {
          title: 'Release this task?',
          body: [
            'The agent’s attempt ends and the task goes back to READY for any agent.',
            'Its worktree and commits are kept for the next attempt.',
          ],
          confirmLabel: 'Release',
        }),
    ),
  );
  cancelBtn.addEventListener(
    'click',
    arming.guard(
      () =>
        void confirmed(cancelBtn, 'cancel', {
          title: 'Cancel this task?',
          body: [taskLine(board, task.task_id), 'A cancelled task does not run again.'],
          confirmLabel: 'Cancel task',
        }),
    ),
  );

  return {
    el,
    destroy(): void {
      arming.destroy();
      el.remove();
    },
  };
}
