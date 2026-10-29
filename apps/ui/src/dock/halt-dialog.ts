/**
 * The halt dialog (plan §7.6, FD-09, ERRATA F12): says exactly what halt does and does not do,
 * takes a reason, arms its Confirm button after a 3-second countdown, confirms with `Enter` once
 * armed and cancels with `Esc`; then shows what the daemon reported, per task, without claiming more
 * than it did ("stop sent", not "stopped").
 */
import type { ControlResult, ControlTaskStop, UiSnapshot } from '@friday/protocol';
import { visible } from '../model/text.js';
import type { AppContext, Component } from '../shell/context.js';
import { button, h, replace, setVar } from '../ui/dom.js';
import { cleanText, plural, shortId, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { ATTACHED_NOTE, attachedSessions } from './actions.js';

export const HALT_COUNTDOWN_S = 3;
export const HALT_REASON_MAX = 500;

let dialogs = 0;

export const HALT_DOES = [
  'Pauses Friday: nothing new is assigned, delivered or started, and every change an agent tries is refused until you resume.',
  "Preserves each running attempt's work under refs/friday/preserved/… before it stops the attempt.",
  'Releases each of those tasks to READY, so it starts again after you resume, in the same worktree.',
  'Sends the stop to the agents Friday started; each stops when its adapter takes the stop.',
  'Stops running operations.',
];

export const HALT_DOES_NOT = [
  'Stop sessions attached in an editor (Claude Code in VS Code): they keep running, but cannot change anything while Friday is paused.',
  'Cancel any task, remove any worktree, or interrupt a verification.',
];

/** How one stopped attempt is described. */
export function stopLabel(t: Pick<ControlTaskStop, 'host' | 'stop'>): string {
  if (t.stop === 'sent') return 'stop sent';
  if (t.stop === 'not_possible') return 'cannot be stopped (held by the pause)';
  if (t.host === 'none') return 'released (no agent was running it)';
  return 'released';
}

export const HOST_LABEL: Record<ControlTaskStop['host'], string> = {
  spawned: 'Agents Friday started',
  attached: 'Sessions attached in an editor',
  none: 'Without an agent',
};

export interface HaltSummary {
  heading: string;
  groups: { host: ControlTaskStop['host']; label: string; stop: string; count: number }[];
  tasks: { taskId: string; title: string; host: string; stop: string; preservedRef: string | null }[];
  operations: string;
  notes: string[];
}

/** What a halt did, from its `ControlResult` (pure). */
export function haltSummary(result: ControlResult, board: UiSnapshot | null): HaltSummary {
  const tasks = result.tasks ?? [];
  const byKey = new Map<string, HaltSummary['groups'][number]>();
  for (const t of tasks) {
    const stop = stopLabel(t);
    const key = `${t.host}\u0000${stop}`;
    const g = byKey.get(key);
    if (g) g.count += 1;
    else byKey.set(key, { host: t.host, label: HOST_LABEL[t.host] ?? t.host, stop, count: 1 });
  }
  const order: ControlTaskStop['host'][] = ['spawned', 'attached', 'none'];
  const groups = [...byKey.values()].sort((a, b) => order.indexOf(a.host) - order.indexOf(b.host));
  const summaries = new Map((board?.tasks ?? []).map((t) => [t.task_id, t.summary]));
  const notes: string[] = [];
  if (tasks.length > 0) notes.push('Every task keeps its worktree; resume Friday to start them again.');
  if (tasks.some((t) => t.host === 'attached') || attachedSessions(board) > 0) notes.push(ATTACHED_NOTE);
  return {
    heading: result.control?.paused
      ? `Friday is halted and paused. ${tasks.length ? `${plural(tasks.length, 'task')} released.` : 'No task was running.'}`
      : 'Halt finished.',
    groups,
    tasks: tasks.map((t) => {
      const summary = summaries.get(t.task_id);
      return {
        taskId: t.task_id,
        title: summary ? truncate(cleanText(summary), 120) : shortId(t.task_id),
        host: HOST_LABEL[t.host] ?? t.host,
        stop: stopLabel(t),
        preservedRef: t.preserved_ref ? visible(t.preserved_ref) : null,
      };
    }),
    operations: `${plural(result.operations_stopped ?? 0, 'operation')} stopped`,
    notes,
  };
}

function list(items: readonly string[], kind: 'does' | 'not'): HTMLElement {
  return h(
    'ul',
    { class: `dk-halt-list dk-halt-${kind}` },
    items.map((text) =>
      h(
        'li',
        null,
        h('span', { class: 'dk-halt-bullet' }, icon(kind === 'does' ? 'check' : 'cross', 14)),
        h('span', null, text),
      ),
    ),
  );
}

export function renderHaltSummary(summary: HaltSummary): HTMLElement {
  return h(
    'div',
    { class: 'dk-halt-summary' },
    h('p', { class: 'dk-halt-heading' }, summary.heading),
    summary.groups.length
      ? h(
          'ul',
          { class: 'dk-halt-groups' },
          summary.groups.map((g) =>
            h(
              'li',
              { class: `dk-halt-group dk-halt-group-${g.host}` },
              h('span', { class: 'dk-halt-group-label' }, `${g.label}: ${plural(g.count, 'task')}`),
              h('span', { class: 'dk-halt-group-stop' }, g.stop),
            ),
          ),
        )
      : '',
    summary.tasks.length
      ? h(
          'ul',
          { class: 'dk-halt-tasks' },
          summary.tasks.map((t) =>
            h(
              'li',
              { class: 'dk-halt-task' },
              h('span', { class: 'dk-halt-task-title' }, t.title),
              h('span', { class: 'muted' }, ` · ${t.host} · ${t.stop}`),
              t.preservedRef ? h('code', { class: 'dk-halt-ref' }, t.preservedRef) : '',
            ),
          ),
        )
      : '',
    h('p', { class: 'muted' }, summary.operations),
    summary.notes.map((n) => h('p', { class: 'dk-halt-note' }, n)),
  );
}

/** The dialog's body; the shell's modal host shows it with its title. */
export function haltDialog(
  ctx: AppContext,
  close: () => void,
): Component & { title: string; size: 'sm' | 'md' | 'lg' } {
  const reasonId = `dk-halt-reason-${++dialogs}`;
  let remaining = HALT_COUNTDOWN_S;
  let armed = false;
  let busy = false;
  let result: ControlResult | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let focusTimer: ReturnType<typeof setTimeout> | null = null;

  const reason = h('input', {
    class: 'input dk-halt-reason',
    id: reasonId,
    type: 'text',
    maxLength: HALT_REASON_MAX,
    autocomplete: 'off',
    placeholder: 'Why you halt (optional, recorded with the halt)',
  });
  const announce = h('div', { class: 'visually-hidden', role: 'status', aria: { live: 'polite' } });
  const meter = h(
    'div',
    { class: 'dk-halt-meter', aria: { hidden: 'true' } },
    h('div', { class: 'dk-halt-meter-fill' }),
  );
  const confirmBtn = button('', () => void confirm(), { class: 'btn btn-danger dk-halt-confirm', disabled: true });
  const cancelBtn = button('Cancel', () => cancel(), { class: 'btn btn-ghost dk-halt-cancel' });
  const actions = h('div', { class: 'dk-halt-actions' }, cancelBtn, confirmBtn);

  const form = h(
    'div',
    { class: 'dk-halt-form' },
    h(
      'p',
      { class: 'dk-halt-lead' },
      h('span', { class: 'dk-halt-icon' }, icon('halt', 18)),
      'Halt stops the work in progress and pauses Friday.',
    ),
    h('div', { class: 'section-title' }, 'What halt does'),
    list(HALT_DOES, 'does'),
    h('div', { class: 'section-title' }, 'What halt does not do'),
    list(HALT_DOES_NOT, 'not'),
    h('div', { class: 'field dk-halt-field' }, h('label', { class: 'field-label', for: reasonId }, 'Reason'), reason),
    meter,
  );
  const body = h('div', { class: 'dk-halt-body' }, form);
  const el = h('div', { class: 'dk-halt', role: 'group', aria: { label: 'Halt Friday' } }, body, actions, announce);

  function render(): void {
    if (result) return;
    confirmBtn.disabled = !armed || busy;
    replace(
      confirmBtn,
      icon('halt', 14),
      busy ? 'Halting…' : armed ? 'Halt now' : `Halt (ready in ${remaining} s)`,
      armed && !busy ? h('span', { class: 'kbd' }, 'Enter') : '',
    );
    cancelBtn.disabled = busy;
    reason.disabled = busy;
    setVar(meter, '--dk-halt-left', String(armed ? 0 : remaining / HALT_COUNTDOWN_S));
    el.classList.toggle('dk-halt-armed', armed);
  }

  function tick(): void {
    timer = null;
    remaining -= 1;
    if (remaining <= 0) {
      remaining = 0;
      armed = true;
      announce.textContent = 'Halt is ready: press Enter to confirm, or Escape to cancel.';
    } else {
      timer = setTimeout(tick, 1000);
    }
    render();
  }

  function cancel(): void {
    if (busy) return;
    close();
  }

  async function confirm(): Promise<void> {
    if (!armed || busy || result) return;
    busy = true;
    render();
    const why = reason.value.trim();
    const r = await ctx.act('Halt Friday', () => ctx.api.halt(why || undefined));
    busy = false;
    if (!r) {
      render();
      return;
    }
    result = r;
    ctx.refresh();
    showSummary(r);
  }

  function showSummary(r: ControlResult): void {
    replace(body, renderHaltSummary(haltSummary(r, ctx.store.select('board'))));
    const closeBtn = button('Close', () => close(), { class: 'btn btn-primary dk-halt-close' });
    replace(actions, closeBtn);
    announce.textContent = 'Friday is halted.';
    el.classList.add('dk-halt-done');
    closeBtn.focus();
  }

  /** The dialog's keys: `Enter` confirms once armed, `Esc` cancels; after the halt both close. */
  function onKey(event: KeyboardEvent, fromScope: boolean): boolean {
    if (event.isComposing) return false;
    if (event.key === 'Escape') {
      if (result) close();
      else cancel();
      return true;
    }
    if (event.key !== 'Enter' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
    const target = event.target;
    if (target instanceof HTMLButtonElement && target !== confirmBtn) {
      // Enter on another focused button activates that button only: natively when the key reaches
      // no binding, by a click when the page's keyboard took it (and so prevented the default).
      if (fromScope) target.click();
      return fromScope;
    }
    if (result) close();
    else void confirm();
    return true;
  }

  const onElementKey = (event: KeyboardEvent): void => {
    if (onKey(event, false)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  el.addEventListener('keydown', onElementKey);

  const popScope = ctx.keys.push({
    name: 'halt-dialog',
    exclusive: true,
    bindings: [
      { key: 'Enter', inFields: true, run: (e) => onKey(e, true), description: 'Confirm the halt once armed' },
      { key: 'Escape', inFields: true, run: (e) => onKey(e, true), description: 'Cancel' },
    ],
  });

  render();
  timer = setTimeout(tick, 1000);
  focusTimer = setTimeout(() => {
    focusTimer = null;
    if (el.isConnected && !result) reason.focus();
  }, 0);

  return {
    el,
    title: 'Halt Friday',
    size: 'md',
    destroy() {
      if (timer) clearTimeout(timer);
      if (focusTimer) clearTimeout(focusTimer);
      timer = null;
      focusTimer = null;
      el.removeEventListener('keydown', onElementKey);
      popScope();
      el.remove();
    },
  };
}
