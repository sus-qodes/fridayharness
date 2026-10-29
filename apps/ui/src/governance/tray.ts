/**
 * The Studio's "Waiting for you" list (plan §7.5; review §4, owner decision 6): pending approvals
 * that have not expired, pending questions, agents waiting for a human (WAITING blocked or
 * human_approval), proposed plans, messages that wait for the human's reply, memories that need
 * review, and a policy loosening this clone has not trusted. The first three open their card in
 * place; a plan opens its review; the last three open the place where they are decided (the
 * Messages drawer, Project memory at Needs review, Settings → Policy). Rows and their cards are
 * kept by key across snapshot re-reads, so a card that did not change keeps its armed state and
 * its focus.
 *
 * The rows are `waitingItems` of `notch/derive.ts`, the list the header's count, the title, the
 * tray's line and the Notch's chip read too: the rail never lists what the header does not count.
 * The one difference is an approval whose decision is in flight, which leaves the rail at once.
 */
import type { SnapshotInboxItem, UiSnapshot } from '@friday/protocol';
import { classifyEscalation } from '../model/escalations.js';
import { visible } from '../model/text.js';
import { itemSignature, type WaitingItem, waitingItems } from '../notch/derive.js';
import { type AppContext, type Component, openDrawer, openModal } from '../shell/context.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { cleanText, plural, truncate } from '../ui/format.js';
import { type IconName, icon } from '../ui/svg.js';
import { type ApprovalCard, approvalCard } from './approval-card.js';
import { agentKeyOf, isExpired, nextId } from './common.js';
import { isDeciding } from './decisions.js';
import { questionCard } from './question-card.js';
import { waitingCard } from './waiting-card.js';

/** A waiting item with the signature of what its row and card show. */
export type TrayItem = WaitingItem & { sig: string };

/** Everything that waits for a human, in the order the tray shows it. */
export function decisionItems(board: UiSnapshot | null, now: number): TrayItem[] {
  return waitingItems(board, now)
    .filter((item) => item.kind !== 'approval' || !isDeciding(item.id))
    .map((item) => ({ ...item, sig: itemSignature(item) }));
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
  message: 'message',
  memory: 'memory',
  policy: 'shield',
};

/** Rows that open another place instead of a card under themselves. */
const OPENS_PLACE = new Set<TrayItem['kind']>(['plan', 'message', 'memory', 'policy']);

function senderOf(m: SnapshotInboxItem): string {
  if (m.from.kind === 'agent') return m.from.agent_key ?? m.from.id;
  if (m.from.kind === 'master_brain') return 'Master Brain';
  if (m.from.kind === 'system') return 'Friday';
  return m.from.kind;
}

export interface DecisionsTrayOptions {
  onCollapse?: () => void;
}

export function mountDecisionsTray(
  ctx: AppContext,
  container: HTMLElement,
  opts: DecisionsTrayOptions = {},
): Component {
  const titleId = nextId('tray-title');
  const count = h('span', { class: 'badge badge-warn gv-tray-count' }, '0');
  const list = h('ul', { class: 'gv-tray-list', aria: { labelledby: titleId } });
  const empty = h('p', { class: 'empty gv-tray-empty' }, 'Nothing waits for you.');
  const collapseBtn = opts.onCollapse
    ? button(
        icon('chevronRight', 16),
        opts.onCollapse,
        {
          class: 'sh-rail-collapse-btn',
          ariaLabel: 'Collapse panel',
          title: 'Collapse panel (Ctrl+\\)',
        },
      )
    : null;
  // Focusable, so the Notch's waiting chip and the header's count can hand it the keyboard.
  const el = h(
    'section',
    { class: 'gv-tray', tabIndex: -1, aria: { labelledby: titleId } },
    h(
      'header',
      { class: 'gv-tray-head' },
      h('h2', { class: 'gv-tray-title', id: titleId }, 'Waiting for you'),
      count,
      collapseBtn,
    ),
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
      case 'message': {
        const m = item.message;
        return {
          label: 'A message waits for your reply',
          sub: `${visible(senderOf(m))} · ${truncate(cleanText(m.subject ?? m.preview), 110)}`,
        };
      }
      case 'memory':
        return {
          label: `${plural(item.count, 'memory', 'memories')} ${item.count === 1 ? 'needs' : 'need'} review`,
          sub: 'Agents recorded them; approve or retract each in Project memory.',
        };
      case 'policy':
        return {
          label: 'Policy change not yet trusted',
          sub: "The project's files loosen Friday's defaults; nothing of it applies until you trust it.",
        };
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

  /** Where a row without a card is decided. */
  const openPlace = (item: TrayItem): void => {
    if (item.kind === 'plan') openModal(ctx, { kind: 'plan-review', id: item.goalId });
    else if (item.kind === 'message') openDrawer(ctx, { kind: 'inbox', id: item.message.delivery_id });
    else if (item.kind === 'memory') openDrawer(ctx, { kind: 'memory', tab: 'review' });
    else if (item.kind === 'policy') openDrawer(ctx, { kind: 'settings', tab: 'policy' });
  };

  const activate = (row: Row): void => {
    if (OPENS_PLACE.has(row.item.kind)) {
      openPlace(row.item);
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
        aria:
          item.kind === 'plan'
            ? { haspopup: 'dialog' }
            : OPENS_PLACE.has(item.kind)
              ? {}
              : { expanded: 'false', controls: slotId },
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
