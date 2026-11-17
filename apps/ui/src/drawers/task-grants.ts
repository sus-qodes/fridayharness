/**
 * What a person allowed for a task, and taking it back (2026-11-17).
 *
 * "Allow for this task" lets an agent do the same thing again without asking, until the task ends.
 * Once given, such an allowance was nowhere in the app: seeing it, or taking it back, was a
 * terminal command. The task inspector lists the ones still in force (for this task, or for the
 * current attempt), each as the act it allows and exactly what, with **Take back**, which revokes it
 * (`POST approvals/:aid/revoke`): the agent asks again the next time.
 */
import type { ApprovalRow } from '@friday/protocol';
import { capabilityWords } from '../model/capability-words.js';
import { visible } from '../model/text.js';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { timeUntil, truncate } from '../ui/format.js';

/** The allowances still in force: given for more than once, and not past their time. */
export function standingGrants(rows: readonly ApprovalRow[], now: number): ApprovalRow[] {
  return rows.filter(
    (a) =>
      a.status === 'granted' &&
      a.reuse !== 'once' &&
      !(a.expires_at && Number.isFinite(Date.parse(a.expires_at)) && Date.parse(a.expires_at) <= now),
  );
}

/** How long an allowance holds, in words. */
export function grantReach(a: Pick<ApprovalRow, 'reuse' | 'expires_at'>, now: number): string {
  const reach = a.reuse === 'task' ? 'until the task ends' : 'for the current attempt';
  return a.expires_at ? `${reach} (lapses ${timeUntil(a.expires_at, now)})` : reach;
}

/**
 * The section's content: empty and hidden while there is nothing in force (the usual case), so the
 * inspector shows no heading for it. `onChange` is told whether there is something to show.
 */
export function taskGrants(
  ctx: AppContext,
  taskId: string,
  onChange: (count: number) => void = () => undefined,
): { el: HTMLElement; destroy(): void } {
  const el = h('div', { class: 'dr-grants' });
  let gone = false;

  async function load() {
    let rows: ApprovalRow[] = [];
    try {
      rows = standingGrants((await ctx.api.taskGrants(taskId)).approvals ?? [], ctx.now());
    } catch {
      // A list that cannot be read shows nothing: the inspector's other parts say when Friday is away.
      rows = [];
    }
    if (gone) return;
    replace(
      el,
      rows.length
        ? h(
            'ul',
            { class: 'dr-grant-list' },
            rows.map((a) => {
              const back = button(
                'Take back',
                () => {
                  back.disabled = true;
                  void ctx
                    .act(
                      'Take the allowance back',
                      () => ctx.api.revoke(a.approval_id, 'taken back in the task inspector'),
                      'Taken back: the agent asks again next time',
                    )
                    .then((r) => {
                      if (gone) return;
                      back.disabled = false;
                      if (r) void load();
                    });
                },
                { class: 'btn btn-ghost', ariaLabel: `Take back: ${capabilityWords(a.capability)}` },
              );
              return h(
                'li',
                { class: 'dr-grant' },
                h(
                  'div',
                  { class: 'dr-grant-what' },
                  h('span', { class: 'dr-grant-act', title: visible(a.capability) }, capabilityWords(a.capability)),
                  a.target ? h('span', { class: 'dr-mono dr-grant-target' }, truncate(visible(a.target), 300)) : null,
                  h('span', { class: 'muted' }, grantReach(a, ctx.now())),
                ),
                back,
              );
            }),
          )
        : null,
    );
    onChange(rows.length);
  }

  void load();
  return {
    el,
    destroy() {
      gone = true;
    },
  };
}
