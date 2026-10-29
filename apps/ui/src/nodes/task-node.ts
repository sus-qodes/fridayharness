/**
 * The task card (handoff Part 04 §3, plan §7.3): kind, id, priority and risk; summary; agent,
 * write scope and worktree branch; acceptance criteria as a plain list; checks "passed of run";
 * reservations and a conflict badge; duration, tool calls, changed files and `+N −M`; a status bar
 * coloured by status with the waiting reason, and the agent's note while it is blocked. Hover (or
 * focus) reveals the actions that apply to the task's state.
 */
import type {
  FileReservationView,
  HarnessEntry,
  IntegrationView,
  RunView,
  SnapshotTask,
  VerificationView,
} from '@friday/protocol';
import { assignableAgents, CRITERIA_SHOWN, checksSummary, conflictOf, TERMINAL_STATUSES } from '../model/board.js';
import { notStartedText, PRIORITY, RISK, statusLook, TASK_KIND, WAITING_REASON } from '../model/status.js';
import { visible } from '../model/text.js';
import { type AppContext, openDrawer, openModal } from '../shell/context.js';
import { button, h, replace, setVar, toggleClass } from '../ui/dom.js';
import { cleanText, duration, plural, shortId, truncate } from '../ui/format.js';
import type { IconName } from '../ui/svg.js';
import {
  actionButton,
  badge,
  fingerprint,
  fromControl,
  type LocalIcon,
  type NodeView,
  nodeIcon,
  pill,
  pills,
  type Tone,
} from './common.js';

export interface TaskCardModel {
  task: SnapshotTask;
  run: RunView | null;
  /** The harness of the task's run (spawned or attached). */
  harness: HarnessEntry | null;
  verification: VerificationView | null;
  integration: IntegrationView | null;
  reservations: readonly FileReservationView[];
  /** `+N −M` from `tasks/:tid/diff?stat=1`; null until it answers. */
  stats: { added: number; removed: number } | null;
  /** Changed files from the same answer, else the paths Friday observed. */
  files: number | null;
  /** A pending `recovery_needed` question names the task. */
  recoveryQuestion: boolean;
  /** The proposed plan version drops the task. */
  dropped: boolean;
  proposedVersion: number | null;
  selected: boolean;
  now: number;
}

export type TaskActionId =
  | 'inspect'
  | 'verify'
  | 'continue'
  | 'rework'
  | 'reassign'
  | 'recover'
  | 'integrate'
  | 'cancel';

/** The hover actions that apply (plan §7.3), in display order. */
export function taskActions(
  m: Pick<TaskCardModel, 'task' | 'run' | 'harness' | 'integration' | 'recoveryQuestion'>,
): TaskActionId[] {
  const t = m.task;
  const out: TaskActionId[] = ['inspect'];
  if (t.status === 'READY_FOR_VERIFICATION') out.push('verify');
  if (t.status === 'WAITING' && m.run?.status === 'ACTIVE' && m.harness?.attach_mode === 'spawn') out.push('continue');
  if (t.status === 'FAILED') out.push('rework');
  if (t.status === 'READY' || t.status === 'ASSIGNED') out.push('reassign');
  if (t.status === 'HARNESS_LOST' || t.waiting_reason === 'agent_error' || m.recoveryQuestion) out.push('recover');
  if (conflictOf(m.integration) && t.status !== 'CANCELLED') out.push('integrate');
  if (!TERMINAL_STATUSES.has(t.status)) out.push('cancel');
  return out;
}

/** Started → completed (or cancelled, or now while it is still open). */
export function taskDuration(
  task: Pick<SnapshotTask, 'started_at' | 'completed_at' | 'cancelled_at' | 'status'>,
  now: number,
): number | null {
  if (!task.started_at) return null;
  const start = Date.parse(task.started_at);
  if (Number.isNaN(start)) return null;
  const endIso = task.completed_at ?? task.cancelled_at;
  const end = endIso ? Date.parse(endIso) : TERMINAL_STATUSES.has(task.status) ? Number.NaN : now;
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** "+14 −2", or "—" until the line counts are known. */
export function statText(stats: { added: number; removed: number } | null | undefined): string {
  return stats ? `+${stats.added} −${stats.removed}` : '—';
}

const STATUS_ICON: Record<string, IconName | LocalIcon> = {
  PROPOSED: 'dot',
  READY: 'dot',
  ASSIGNED: 'robot',
  RUNNING: 'bolt',
  WAITING: 'hourglass',
  READY_FOR_VERIFICATION: 'search',
  VERIFYING: 'gear',
  COMPLETED: 'check',
  FAILED: 'cross',
  REWORK: 'rework',
  HARNESS_LOST: 'unlink',
  CANCELLED: 'cross',
  ABANDONED: 'cross',
};

/** What the card's tool count is (`tool_calls` in the snapshot, counted from the event log). */
const TOOL_CALLS_TITLE =
  'Tool calls the agent’s host reported finishing for this task, over every attempt (calls Friday refused never ran)';

const PRIORITY_TONE: Record<string, Tone> = { urgent: 'danger', high: 'warn', normal: 'muted', low: 'muted' };
const RISK_TONE: Record<string, Tone> = { low: 'good', medium: 'warn', high: 'danger' };

/** The card's status colour: model/status.ts, except HARNESS_LOST, which plan §7.3 makes amber. */
export function statusColor(status: string): string {
  return status === 'HARNESS_LOST' ? 'var(--color-amber)' : statusLook(status).color;
}

export function statusIcon(status: string): IconName | LocalIcon {
  return STATUS_ICON[status] ?? 'dot';
}

export function createTaskNode(ctx: AppContext, initial: TaskCardModel): NodeView<TaskCardModel> {
  let model = initial;
  let printed = '';
  let menu: HTMLElement | null = null;
  let offOutside: (() => void) | null = null;

  const actions = h('div', { class: 'nd-actions', role: 'toolbar', aria: { label: 'Task actions' } });
  const body = h('div', { class: 'nd-body' });
  const foot = h('div', { class: 'nd-foot' });
  const el = h(
    'div',
    {
      class: ['nd-card', 'nd-task'],
      role: 'group',
      tabIndex: 0,
      dataset: { id: initial.task.task_id, kind: 'task' },
      on: {
        keydown: (e) => {
          if (e.target === el && e.key === 'Enter') {
            e.preventDefault();
            inspect();
          }
        },
        click: (e) => {
          if (fromControl(e)) return;
          ctx.store.patch('ui', { selectedTaskId: model.task.task_id });
        },
        dblclick: (e) => {
          if (!fromControl(e)) inspect();
        },
      },
    },
    actions,
    body,
    foot,
  );

  const id = () => model.task.task_id;
  const inspect = () => openDrawer(ctx, { kind: 'inspector', id: id() });

  function closeMenu(): void {
    offOutside?.();
    offOutside = null;
    menu?.remove();
    menu = null;
  }

  function openMenu(anchor: HTMLElement): void {
    if (menu) {
      closeMenu();
      return;
    }
    const t = model.task;
    const agents = assignableAgents(ctx.store.select('board'), t);
    const items: HTMLElement[] = agents.map((a) =>
      button(
        [h('span', { class: 'mono' }, visible(a.agent_key)), h('span', { class: 'muted' }, ` ${visible(a.role)}`)],
        () => {
          closeMenu();
          void ctx
            .act('Assign the task', () => ctx.api.assign(t.task_id, a.agent_key), `Given to ${a.agent_key}`)
            .then(() => ctx.refresh());
        },
        { class: 'nd-menu-item', role: 'menuitem', dataset: { agent: a.agent_key } },
      ),
    );
    if (!agents.length) items.push(h('div', { class: 'nd-menu-empty' }, 'No other agent is connected'));
    if (t.status === 'ASSIGNED') {
      items.push(
        button(
          'Release to the queue',
          () => {
            closeMenu();
            void ctx
              .act('Release the task', () => ctx.api.taskAction(t.task_id, 'release'), 'Released to the queue')
              .then(() => ctx.refresh());
          },
          { class: 'nd-menu-item', role: 'menuitem', dataset: { action: 'release' } },
        ),
      );
    }
    if (t.status === 'READY' && t.reserved_for_agent_key) {
      items.push(
        button(
          `Remove the reservation for ${visible(t.reserved_for_agent_key)}`,
          () => {
            closeMenu();
            void ctx
              .act('Remove the reservation', () => ctx.api.taskAction(t.task_id, 'unreserve'), 'Reservation removed')
              .then(() => ctx.refresh());
          },
          { class: 'nd-menu-item', role: 'menuitem', dataset: { action: 'unreserve' } },
        ),
      );
    }
    menu = h(
      'div',
      {
        class: 'nd-menu',
        role: 'menu',
        aria: { label: 'Give the task to' },
        on: {
          keydown: (e) => {
            const list = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
            const i = list.indexOf(document.activeElement as HTMLElement);
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              closeMenu();
              anchor.focus();
            } else if (e.key === 'ArrowDown' && list.length) {
              e.preventDefault();
              list[(i + 1) % list.length]?.focus();
            } else if (e.key === 'ArrowUp' && list.length) {
              e.preventDefault();
              list[(i - 1 + list.length) % list.length]?.focus();
            }
          },
        },
      },
      h('div', { class: 'nd-menu-title' }, 'Give to'),
      items,
    );
    el.append(menu);
    const outside = (e: PointerEvent) => {
      if (menu && !menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMenu();
    };
    document.addEventListener('pointerdown', outside, true);
    offOutside = () => document.removeEventListener('pointerdown', outside, true);
    (menu.querySelector('[role="menuitem"]') as HTMLElement | null)?.focus();
  }

  function renderActions(): void {
    const t = model.task;
    const list = taskActions(model);
    const buttons: HTMLElement[] = [];
    for (const a of list) {
      switch (a) {
        case 'inspect':
          buttons.push(actionButton('Inspect', 'eye', inspect, { action: a, title: 'Open the task inspector' }));
          break;
        case 'verify':
          buttons.push(
            actionButton('Verify', 'check', () => openModal(ctx, { kind: 'verify', id: t.task_id }), {
              action: a,
              title: 'Open the verification panel',
            }),
          );
          break;
        case 'continue':
          buttons.push(
            actionButton(
              'Continue',
              'play',
              () =>
                ctx
                  .act(
                    'Continue the task',
                    () => ctx.api.continueTask(t.task_id),
                    (r) =>
                      r.continued
                        ? 'The agent continues in the same session'
                        : (r.reason ?? 'The agent was not continued'),
                  )
                  .then(() => ctx.refresh()),
              { action: a, busyLabel: 'Continuing…', title: 'Restart the agent in the same run' },
            ),
          );
          break;
        case 'rework':
          buttons.push(
            actionButton(
              'Rework',
              'rework',
              () =>
                ctx
                  .act(
                    'Send the task back for rework',
                    () => ctx.api.taskAction(t.task_id, 'rework'),
                    'Sent back for rework',
                  )
                  .then(() => ctx.refresh()),
              { action: a, busyLabel: 'Sending…' },
            ),
          );
          break;
        case 'reassign': {
          const b = actionButton('Reassign', 'swap', () => openMenu(b), {
            action: a,
            title: 'Give the task to another agent',
          });
          b.setAttribute('aria-haspopup', 'menu');
          buttons.push(b);
          break;
        }
        case 'recover':
          buttons.push(
            actionButton('Recover', 'rework', () => openModal(ctx, { kind: 'recover', id: t.task_id }), {
              action: a,
              title: 'Open the recovery dialog',
            }),
          );
          break;
        case 'integrate':
          buttons.push(
            actionButton(
              'Integrate',
              'branch',
              () =>
                ctx
                  .act(
                    'Integrate the task',
                    () => ctx.api.integrate(t.task_id),
                    (r) => `Integration: ${r.integration?.status ?? 'done'}`,
                  )
                  .then(() => ctx.refresh()),
              { action: a, busyLabel: 'Integrating…', title: 'Integrate the verified work into the goal branch again' },
            ),
          );
          break;
        case 'cancel':
          buttons.push(
            actionButton(
              'Cancel',
              'cross',
              async () => {
                const ok = await ctx.confirm({
                  title: 'Cancel this task?',
                  body: [
                    truncate(cleanText(t.summary), 200),
                    'The task stops for good; its worktree and branch are kept.',
                  ],
                  confirmLabel: 'Cancel the task',
                  cancelLabel: 'Keep it',
                  danger: true,
                });
                if (!ok) return;
                await ctx.act('Cancel the task', () => ctx.api.taskAction(t.task_id, 'cancel'), 'Task cancelled');
                ctx.refresh();
              },
              { action: a, cls: 'nd-act-danger', busyLabel: 'Cancelling…' },
            ),
          );
          break;
      }
    }
    replace(actions, buttons);
    if (menu && !list.includes('reassign')) closeMenu();
  }

  function renderBody(): void {
    const m = model;
    const t = m.task;
    const look = statusLook(t.status);
    const kind = TASK_KIND[t.kind] ?? { label: t.kind, color: 'var(--color-slate-400)' };
    const priority = PRIORITY[t.priority]?.label ?? t.priority;
    const risk = RISK[t.risk_level]?.label ?? t.risk_level;

    const head = h(
      'div',
      { class: 'nd-head', dataset: { dragHandle: '' } },
      h('span', { class: 'pill nd-kind', ref: (k) => setVar(k, '--nd-kind', kind.color) }, kind.label),
      h('span', { class: 'nd-id mono', title: t.task_id }, shortId(t.task_id)),
      h('span', { class: 'spacer' }),
      badge(priority, PRIORITY_TONE[t.priority] ?? 'muted'),
      h('span', { class: `badge badge-${RISK_TONE[t.risk_level] ?? 'muted'} nd-risk` }, nodeIcon('shield', 10), risk),
    );

    const summary = h(
      'p',
      { class: ['nd-summary', t.status === 'CANCELLED' && 'nd-struck'], title: truncate(cleanText(t.summary), 1000) },
      truncate(cleanText(t.summary), 240),
    );

    const agent = t.agent_key
      ? h('span', { class: 'nd-agent' }, nodeIcon('robot', 12), h('span', { class: 'mono' }, visible(t.agent_key)))
      : t.reserved_for_agent_key
        ? h(
            'span',
            { class: 'nd-agent muted' },
            nodeIcon('robot', 12),
            'for ',
            h('span', { class: 'mono' }, visible(t.reserved_for_agent_key)),
          )
        : h('span', { class: 'nd-agent muted' }, 'unassigned');
    const branch = m.run?.branch_ref
      ? h(
          'span',
          { class: 'nd-branch mono', title: visible(m.run.branch_ref) },
          nodeIcon('branch', 12),
          visible(m.run.branch_ref),
        )
      : null;
    const meta = h('div', { class: 'nd-meta' }, agent, branch);

    const write = t.scope?.write ?? [];
    const scope = write.length
      ? h(
          'div',
          { class: 'nd-scope' },
          h('span', { class: 'nd-label' }, 'writes'),
          pills(write, 3, (g) => pill(visible(g), 'mono', visible(g))),
        )
      : null;

    const criteria = t.acceptance_criteria.length
      ? h(
          'ul',
          { class: 'nd-criteria', aria: { label: 'Acceptance criteria' } },
          t.acceptance_criteria
            .slice(0, CRITERIA_SHOWN)
            .map((c) => h('li', { title: truncate(cleanText(c), 1000) }, truncate(cleanText(c), 140))),
          t.acceptance_criteria.length > CRITERIA_SHOWN
            ? h('li', { class: 'nd-more' }, `+${t.acceptance_criteria.length - CRITERIA_SHOWN} more`)
            : null,
        )
      : null;

    let note: HTMLElement | null = null;
    if (t.status === 'WAITING' && t.waiting_note) {
      note = h(
        'div',
        { class: 'nd-note', role: 'note' },
        h('span', { class: 'nd-note-label' }, t.waiting_reason === 'blocked' ? 'The agent needs you' : 'Waiting'),
        h('span', { class: 'nd-note-text' }, truncate(cleanText(t.waiting_note), 400)),
      );
    } else if (t.status === 'READY' && t.delegation_note) {
      note = h('div', { class: 'nd-note nd-note-quiet' }, truncate(notStartedText(cleanText(t.delegation_note)), 160));
    }

    const badgeRow: HTMLElement[] = [];
    const checks = checksSummary(m.verification);
    if (checks) {
      const failed = m.verification?.status === 'FAILED';
      const tone: Tone = failed ? 'danger' : checks.run > 0 && checks.passed === checks.run ? 'good' : 'warn';
      badgeRow.push(
        badge(`Checks ${checks.passed} of ${checks.run} passed`, tone, m.verification?.summary ?? undefined),
      );
    }
    for (const r of m.reservations.slice(0, 2)) {
      badgeRow.push(
        pill([nodeIcon('lock', 10), visible(r.pattern)], 'nd-reservation mono', `Reserved: ${visible(r.pattern)}`),
      );
    }
    if (m.reservations.length > 2) badgeRow.push(pill(`+${m.reservations.length - 2}`, 'nd-pill-more'));
    const conflict = conflictOf(m.integration);
    if (conflict) {
      badgeRow.push(
        badge(
          conflict === 'conflicted' ? `Conflict (${m.integration?.conflicts.length ?? 0})` : 'Integration failed',
          'danger',
          m.integration?.conflicts.map(visible).join('\n') || (m.integration?.summary ?? undefined),
        ),
      );
    }
    if (m.dropped) badgeRow.push(badge(`Dropped in plan v${m.proposedVersion ?? '?'}`, 'warn'));
    const badges = badgeRow.length ? h('div', { class: 'nd-badges' }, badgeRow) : null;

    replace(body, head, summary, meta, scope, criteria, note, badges);

    const ms = taskDuration(t, m.now);
    const stats = h(
      'div',
      { class: 'nd-stats' },
      h('span', { title: 'Started → completed' }, nodeIcon('hourglass', 11), ms === null ? '—' : duration(ms)),
      h(
        'span',
        { class: 'nd-tools', title: TOOL_CALLS_TITLE },
        nodeIcon('terminal', 11),
        typeof t.tool_calls === 'number' ? plural(t.tool_calls, 'tool') : '—',
      ),
      h('span', { title: 'Changed files' }, nodeIcon('file', 11), m.files === null ? '—' : plural(m.files, 'file')),
      h('span', { class: 'nd-lines mono', title: 'Lines added and removed' }, statText(m.stats)),
    );
    const reason =
      t.status === 'WAITING' && t.waiting_reason ? (WAITING_REASON[t.waiting_reason] ?? t.waiting_reason) : null;
    const bar = h(
      'div',
      { class: 'nd-status' },
      nodeIcon(statusIcon(t.status), 13),
      h('span', { class: 'nd-status-label' }, look.label),
      reason ? h('span', { class: 'nd-status-reason' }, `· ${reason}`) : null,
    );
    replace(foot, stats, bar);

    el.dataset.status = t.status;
    setVar(el, '--nd-status', statusColor(t.status));
    el.setAttribute('aria-label', `${look.label} task: ${truncate(cleanText(t.summary), 120)}`);
  }

  function render(force = false): void {
    const m = model;
    const ms = taskDuration(m.task, m.now);
    const print = fingerprint([
      m.task,
      m.run?.run_id,
      m.run?.status,
      m.run?.branch_ref,
      m.harness?.attach_mode,
      m.verification?.verification_id,
      m.verification?.status,
      m.verification?.checks.map((c) => c.status),
      m.integration?.integration_id,
      m.integration?.status,
      m.reservations.map((r) => r.pattern),
      m.stats,
      m.files,
      m.recoveryQuestion,
      m.dropped,
      m.proposedVersion,
      ms === null ? null : duration(ms),
    ]);
    toggleClass(el, 'nd-selected', m.selected);
    if (!force && print === printed) return;
    printed = print;
    renderBody();
    renderActions();
  }

  render(true);

  return {
    el,
    update(next) {
      model = next;
      render();
    },
    destroy() {
      closeMenu();
      el.remove();
    },
  };
}
