/**
 * The Studio's "Waiting for you" list (plan §7.5): pending approvals that have not expired,
 * pending questions, agents waiting for a human (WAITING blocked or human_approval), and proposed
 * plans. Each row opens its card in place, or the plan review. Rows and their cards are kept by
 * key across snapshot re-reads, so a card that did not change keeps its armed state and its focus.
 */
import type { ApprovalRow, EscalationView, SnapshotTask, UiSnapshot } from '@friday/protocol';
import { classifyEscalation } from '../model/escalations.js';
import { waitsForHuman } from '../model/status.js';
import { visible } from '../model/text.js';
import { type AppContext, type Component, openModal } from '../shell/context.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { cleanText, truncate } from '../ui/format.js';
import { type IconName, icon } from '../ui/svg.js';
import { type ApprovalCard, approvalCard } from './approval-card.js';
import { agentKeyOf, isExpired, nextId } from './common.js';
import { pendingApprovals } from './decisions.js';
import { questionCard } from './question-card.js';
import { waitingCard } from './waiting-card.js';

export type TrayItem =
  | { kind: 'approval'; key: string; sig: string; approval: ApprovalRow }
  | { kind: 'question'; key: string; sig: string; escalation: EscalationView }
  | { kind: 'waiting'; key: string; sig: string; task: SnapshotTask }
  | { kind: 'plan'; key: string; sig: string; goalId: string; version: number; request: string };

/** Everything that waits for a human, in the order the tray shows it. */
export function decisionItems(board: UiSnapshot | null, now: number): TrayItem[] {
  if (!board) return [];
  const approvals = pendingApprovals(board, now);
  const out: TrayItem[] = approvals.map((a) => ({
    kind: 'approval',
    key: `approval:${a.approval_id}`,
    sig: JSON.stringify([a.capability, a.target, a.purpose, a.risk, a.expires_at]),
    approval: a,
  }));
  for (const e of board.escalations) {
    if (e.status !== 'pending') continue;
    out.push({
      kind: 'question',
      key: `question:${e.escalation_id}`,
      sig: JSON.stringify([e.question, e.options, e.kind, e.details]),
      escalation: e,
    });
  }
  const approvalTasks = new Set(approvals.map((a) => a.task_id).filter(Boolean));
  for (const t of board.tasks) {
    if (!waitsForHuman(t)) continue;
    // A task waiting for an approval that is in the list is decided through that approval.
    if (t.waiting_reason === 'human_approval' && approvalTasks.has(t.task_id)) continue;
    out.push({
      kind: 'waiting',
      key: `waiting:${t.task_id}`,
      sig: JSON.stringify([t.waiting_reason, t.waiting_note, t.current_run_id]),
      task: t,
    });
  }
  for (const g of board.goals) {
    const proposed = board.plans[g.goal_id]?.proposed;
    if (!proposed || g.status === 'CANCELLED' || g.status === 'COMPLETED') continue;
    out.push({
      kind: 'plan',
      key: `plan:${g.goal_id}`,
      sig: JSON.stringify([proposed.plan_id, proposed.version]),
      goalId: g.goal_id,
      version: proposed.version,
      request: g.request,
    });
  }
  return out;
}

/** The earliest moment a listed approval expires, to re-read the list then. */
function nextExpiry(board: UiSnapshot | null, now: number): number | null {
  let next: number | null = null;
  for (const a of board?.approvals ?? []) {
    if (a.status !== 'pending' || isExpired(a, now) || !a.expires_at) continue;
    const t = Date.parse(a.expires_at);
    if (Number.isFinite(t) && (next === null || t < next)) next = t;
  }
  return next;
}

interface Row {
  item: TrayItem;
  el: HTMLLIElement;
  toggle: HTMLButtonElement;
  label: HTMLElement;
  sub: HTMLElement;
  slot: HTMLElement;
  card: Component | null;
}

const ICONS: Record<TrayItem['kind'], IconName> = {
  approval: 'shield',
  question: 'question',
  waiting: 'hourglass',
  plan: 'goal',
};

export function mountDecisionsTray(ctx: AppContext, container: HTMLElement): Component {
  const titleId = nextId('tray-title');
  const count = h('span', { class: 'badge badge-warn gv-tray-count' }, '0');
  const list = h('ul', { class: 'gv-tray-list', aria: { labelledby: titleId } });
  const empty = h('p', { class: 'empty gv-tray-empty' }, 'Nothing waits for you.');
  const el = h(
    'section',
    { class: 'gv-tray', aria: { labelledby: titleId } },
    h('header', { class: 'gv-tray-head' }, h('h2', { class: 'gv-tray-title', id: titleId }, 'Waiting for you'), count),
    list,
    empty,
  );
  container.appendChild(el);

  const rows = new Map<string, Row>();
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const describe = (item: TrayItem): { label: string; sub: string } => {
    const board = ctx.store.select('board');
    switch (item.kind) {
      case 'approval': {
        const a = item.approval;
        const who = agentKeyOf(board, a.requested_by_id) ?? a.requested_by_kind;
        return {
          label: `Approval: ${visible(a.capability)}`,
          sub: `${visible(who)} · ${truncate(visible(a.target ?? 'no target'), 90)}`,
        };
      }
      case 'question': {
        const spec = classifyEscalation(item.escalation, { plannerAvailable: !!board?.brain?.planner_available });
        return { label: spec.title, sub: truncate(cleanText(item.escalation.question), 110) };
      }
      case 'waiting':
        return {
          label: `${visible(item.task.agent_key ?? 'An agent')} waits`,
          sub: truncate(cleanText(item.task.waiting_note ?? item.task.summary), 110),
        };
      case 'plan':
        return { label: `Proposed plan v${item.version}`, sub: truncate(cleanText(item.request), 110) };
    }
  };

  const collapse = (row: Row): void => {
    row.card?.destroy();
    row.card = null;
    row.slot.hidden = true;
    row.toggle.setAttribute('aria-expanded', 'false');
    row.el.classList.remove('gv-tray-open');
  };

  const mountCard = (row: Row): void => {
    const item = row.item;
    const later = () => {
      collapse(row);
      row.toggle.focus();
    };
    let card: Component | null = null;
    if (item.kind === 'approval') card = approvalCard(ctx, item.approval);
    else if (item.kind === 'question') card = questionCard(ctx, item.escalation, { onLater: later });
    else if (item.kind === 'waiting') card = waitingCard(ctx, item.task);
    if (!card) return;
    row.card = card;
    replace(row.slot, card.el);
    row.slot.hidden = false;
    row.toggle.setAttribute('aria-expanded', 'true');
    row.el.classList.add('gv-tray-open');
  };

  const activate = (row: Row): void => {
    if (row.item.kind === 'plan') {
      openModal(ctx, { kind: 'plan-review', id: row.item.goalId });
      return;
    }
    if (row.card) collapse(row);
    else mountCard(row);
  };

  const makeRow = (item: TrayItem): Row => {
    const slotId = nextId('tray-slot');
    const label = h('span', { class: 'gv-tray-label' });
    const sub = h('span', { class: 'gv-tray-sub muted' });
    const toggle = button(
      [
        h('span', { class: `gv-tray-icon gv-tone-${item.kind}` }, icon(ICONS[item.kind], 14)),
        h('span', { class: 'gv-tray-text' }, label, sub),
      ],
      () => activate(row),
      {
        class: 'gv-tray-row',
        aria: item.kind === 'plan' ? { haspopup: 'dialog' } : { expanded: 'false', controls: slotId },
      },
    );
    const extra =
      item.kind === 'approval'
        ? button(icon('expand', 14), () => openModal(ctx, { kind: 'approval', id: item.approval.approval_id }), {
            class: 'btn btn-ghost btn-icon gv-tray-full',
            ariaLabel: 'Open the full view of this approval',
          })
        : null;
    const slot = h('div', { class: 'gv-tray-slot', id: slotId, hidden: true });
    const el = h(
      'li',
      { class: ['gv-tray-item', `gv-tray-${item.kind}`], dataset: { key: item.key } },
      h('div', { class: 'gv-tray-line' }, toggle, extra),
      slot,
    );
    const row: Row = { item, el, toggle, label, sub, slot, card: null };
    const d = describe(item);
    setText(label, d.label);
    setText(sub, d.sub);
    return row;
  };

  const update = (row: Row, item: TrayItem): void => {
    const changed = row.item.sig !== item.sig;
    row.item = item;
    const d = describe(item);
    setText(row.label, d.label);
    setText(row.sub, d.sub);
    if (!changed || !row.card) return;
    if (item.kind === 'approval') (row.card as ApprovalCard).update(item.approval);
    else {
      // The question or the waiting note changed: show the new one (it arms again).
      row.card.destroy();
      row.card = null;
      mountCard(row);
    }
  };

  const render = (): void => {
    if (disposed) return;
    const board = ctx.store.select('board');
    const now = ctx.now();
    const items = decisionItems(board, now);
    const keep = new Set(items.map((i) => i.key));
    for (const [key, row] of rows) {
      if (keep.has(key)) continue;
      row.card?.destroy();
      row.el.remove();
      rows.delete(key);
    }
    items.forEach((item, index) => {
      let row = rows.get(item.key);
      if (row) update(row, item);
      else {
        row = makeRow(item);
        rows.set(item.key, row);
      }
      // Move a row only when it is out of place: moving the focused card would drop its focus.
      const at = list.children[index];
      if (at !== row.el) list.insertBefore(row.el, at ?? null);
    });
    setText(count, String(items.length));
    count.hidden = items.length === 0;
    empty.hidden = items.length > 0;
    list.hidden = items.length === 0;
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    const next = nextExpiry(board, now);
    if (next !== null) expiryTimer = setTimeout(render, Math.max(250, next - now + 50));
  };

  render();
  const unsubscribe = ctx.store.subscribe('board', render);

  return {
    el,
    destroy(): void {
      disposed = true;
      unsubscribe();
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      expiryTimer = null;
      for (const row of rows.values()) row.card?.destroy();
      rows.clear();
      el.remove();
    },
  };
}
