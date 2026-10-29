/**
 * The recovery dialog (plan §7.5): `GET tasks/:tid/recovery` assesses the task's last attempt and
 * lists every recovery action with whether it is available, whether Friday recommends it and why;
 * performing one is `POST tasks/:tid/recover {action, reason}`. The assessment holds the request
 * while it inspects the worktree, so the dialog shows progress and never blocks the page.
 */
import type { RecoveryAssessment } from '@friday/protocol';
import type { RecoveryActionName } from '../api/client.js';
import { visible } from '../model/text.js';
import type { AppContext, Component, ModalRequest } from '../shell/context.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { cleanText, plural } from '../ui/format.js';
import { ARMING_TEXT, armDecisions, type Clock } from './arming.js';
import { errorText, nextId, taskLine } from './common.js';

export const RECOVERY_ACTIONS: Record<string, { label: string; explain: string }> = {
  reconnect: { label: 'Wait for the session', explain: 'The agent’s session may still come back and resume.' },
  reassign: { label: 'Reassign', explain: 'Give the task to another agent; it continues from the preserved work.' },
  restart: { label: 'Restart', explain: 'Start a new attempt; the earlier work is preserved first.' },
  rebind: { label: 'Rebind', explain: 'Attach the task to the agent’s new session.' },
  needs_human: { label: 'Ask a human', explain: 'Leave the task waiting with a question for a person.' },
  cancel: { label: 'Cancel the task', explain: 'The task does not run again; its work stays preserved.' },
};

const PERFORMABLE = new Set<string>(['reassign', 'restart', 'rebind', 'needs_human', 'cancel']);

export interface RecoverDialogOptions {
  clock?: Clock;
}

export function recoverDialog(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
  opts: RecoverDialogOptions = {},
): Component & { title: string; size: 'md' } {
  const taskId = request.id ?? '';
  const hint = h('div', { class: 'gv-arming-hint', aria: { live: 'polite' } }, ARMING_TEXT);
  const status = h('div', { class: 'gv-status', role: 'status', aria: { live: 'polite' } });
  const content = h(
    'div',
    { class: 'gv-recover-body' },
    h('p', { class: 'muted' }, 'Assessing the task’s last attempt…'),
  );
  const reasonId = nextId('recover-reason');
  const reason = h('input', {
    class: 'input',
    id: reasonId,
    type: 'text',
    maxLength: 500,
    placeholder: 'Why (recorded with the recovery; optional)',
  });
  const el = h(
    'div',
    { class: 'gv-modal gv-recover' },
    h('p', { class: 'gv-from' }, taskLine(ctx.store.select('board'), taskId)),
    content,
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: reasonId }, 'Reason'), reason),
    hint,
    status,
  );
  const arming = armDecisions(el, { key: `recover:${taskId}`, hint, ...(opts.clock ? { clock: opts.clock } : {}) });
  let disposed = false;
  let busy = false;

  const perform = async (action: RecoveryActionName, b: HTMLButtonElement): Promise<void> => {
    if (busy) return;
    const look = RECOVERY_ACTIONS[action];
    if (action === 'cancel') {
      const ok = await ctx.confirm({
        title: 'Cancel this task?',
        body: [taskLine(ctx.store.select('board'), taskId), 'A cancelled task does not run again.'],
        confirmLabel: 'Cancel task',
        cancelLabel: 'Keep it',
        danger: true,
      });
      if (!ok) return;
    }
    busy = true;
    b.disabled = true;
    setText(status, `${look?.label ?? action}…`);
    const r = await ctx.act(
      `Recover: ${look?.label ?? action}`,
      () => ctx.api.recover(taskId, action, reason.value.trim() || undefined),
      (x) => `${look?.label ?? action} done${x.preserved_ref ? `; work kept at ${x.preserved_ref}` : ''}`,
    );
    busy = false;
    b.disabled = false;
    if (disposed) return;
    if (r) {
      ctx.refresh();
      close();
    } else setText(status, '');
  };

  const render = (a: RecoveryAssessment): void => {
    const facts = h(
      'dl',
      { class: 'gv-meta' },
      h(
        'div',
        { class: 'gv-meta-row' },
        h('dt', null, 'Status'),
        h('dd', null, `${a.task_status}${a.waiting_reason ? ` (${a.waiting_reason})` : ''}`),
      ),
      h('div', { class: 'gv-meta-row' }, h('dt', null, 'Attempts'), h('dd', null, String(a.attempts))),
      a.harness
        ? h(
            'div',
            { class: 'gv-meta-row' },
            h('dt', null, 'Session'),
            h(
              'dd',
              null,
              `${visible(a.harness.agent_key ?? a.harness.harness_id)} · ${a.harness.status}`,
              a.harness.process_alive === false ? ' · its process has ended' : '',
            ),
          )
        : null,
      a.worktree
        ? h(
            'div',
            { class: 'gv-meta-row' },
            h('dt', null, 'Worktree'),
            h(
              'dd',
              { class: 'mono' },
              visible(a.worktree.path),
              ` · ${plural(a.worktree.uncommitted.length, 'uncommitted file')}`,
              a.worktree.commits_since_base !== null ? ` · ${plural(a.worktree.commits_since_base, 'commit')}` : '',
            ),
          )
        : null,
      a.errors.last
        ? h('div', { class: 'gv-meta-row' }, h('dt', null, 'Last error'), h('dd', null, cleanText(a.errors.last)))
        : null,
    );
    const options = h(
      'ul',
      { class: 'gv-options' },
      ...a.options.map((o) => {
        const look = RECOVERY_ACTIONS[o.action] ?? { label: o.action, explain: '' };
        const can = o.available && PERFORMABLE.has(o.action);
        let perf: HTMLButtonElement | null = null;
        if (can) {
          perf = button(look.label, () => undefined, {
            class: ['btn', 'gv-decide', o.recommended ? 'btn-primary' : '', o.action === 'cancel' ? 'btn-danger' : ''],
          });
          const b = perf;
          perf.addEventListener(
            'click',
            arming.guard(() => void perform(o.action as RecoveryActionName, b)),
          );
          arming.register(perf);
        }
        return h(
          'li',
          { class: ['gv-option', !o.available && 'gv-option-off'], dataset: { action: o.action } },
          h(
            'div',
            { class: 'gv-option-head' },
            h('strong', null, look.label),
            o.recommended ? h('span', { class: 'badge badge-good' }, 'recommended') : null,
            !o.available ? h('span', { class: 'badge badge-muted' }, 'not available') : null,
          ),
          look.explain ? h('p', { class: 'field-hint' }, look.explain) : null,
          h('p', { class: 'gv-option-reason' }, cleanText(o.reason)),
          perf,
        );
      }),
    );
    replace(
      content,
      facts,
      a.missing_code ? h('p', { class: 'hidden-warning' }, cleanText(a.missing_code)) : null,
      a.preserved.length
        ? h(
            'p',
            { class: 'field-hint' },
            'Earlier work is kept at ',
            h('span', { class: 'mono' }, visible(a.preserved.join(', '))),
          )
        : null,
      h('h4', { class: 'section-title' }, 'What Friday can do'),
      options,
    );
    arming.check();
  };

  const load = (): void => {
    replace(content, h('p', { class: 'muted' }, 'Assessing the task’s last attempt…'));
    ctx.api.recovery(taskId).then(
      (r) => {
        if (!disposed) render(r.assessment);
      },
      (e: unknown) => {
        if (disposed) return;
        replace(
          content,
          h('p', { class: 'muted' }, `The task could not be assessed (${errorText(e)}).`),
          button('Try again', () => load(), { class: 'btn' }),
        );
      },
    );
  };
  if (taskId) load();
  else replace(content, h('p', { class: 'empty' }, 'No task was named.'));

  return {
    el,
    title: 'Recover the task',
    size: 'md',
    destroy(): void {
      disposed = true;
      arming.destroy();
      el.remove();
    },
  };
}
