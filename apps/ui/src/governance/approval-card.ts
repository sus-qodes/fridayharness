/**
 * The approval card (micro; plan §7.5, handoff Part 06 §3, Part 01 §5.2): who asks, for which
 * task, the capability, and the target and purpose in full with visible escapes; a risk badge and
 * the expiry. Allow once (1), Allow for this task (2, always the modal), Deny (3, an optional
 * reason sent as the decision note). The keys act only while focus is inside the card and no text
 * field has focus; `Enter` only activates the focused button; `Esc` never denies (FD-28).
 */
import type { ApprovalRow } from '@friday/protocol';
import { hasHidden, visible } from '../model/text.js';
import { type AppContext, type Component, openModal } from '../shell/context.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { timeUntil } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { ARMING_TEXT, armDecisions, type Clock } from './arming.js';
import { agentKeyOf, agentText, HIDDEN_WARNING, isExpired, nextId, riskBadge, riskOf, taskLine } from './common.js';
import { type DecisionOutcome, decideApproval, grantPath, modalReason, requestReach } from './decisions.js';

export interface ApprovalCardOptions {
  /** The Notch's smaller card. */
  compact?: boolean;
  /** Called after a decision from this card settled (or the modal was opened for it). */
  onDecided?: (outcome: DecisionOutcome | 'modal') => void;
  /** Timers for arming (tests). */
  clock?: Clock;
}

export interface ApprovalCard extends Component {
  /** Shows another approval (or a changed one) in the same card: decisions wait again. */
  update(approval: ApprovalRow): void;
  readonly approvalId: string;
}

function contentKey(a: ApprovalRow): string {
  return JSON.stringify([a.approval_id, a.capability, a.target, a.purpose, a.risk, a.task_id, a.requested_by_id]);
}

export function approvalCard(ctx: AppContext, approval: ApprovalRow, opts: ApprovalCardOptions = {}): ApprovalCard {
  let a = approval;
  let settled = false;
  let countdown: ReturnType<typeof setTimeout> | null = null;
  let popScope: (() => void) | null = null;
  const titleId = nextId('approval-title');

  const expiry = h('span', { class: 'gv-expiry' });
  const head = h(
    'header',
    { class: 'gv-card-head' },
    h('span', { class: 'gv-card-icon gv-tone-approval' }, icon('shield', 16)),
    h('h3', { class: 'gv-card-title', id: titleId }, 'Approval request'),
    h('span', { class: 'spacer' }),
  );
  const riskSlot = h('span', { class: 'gv-risk-slot' });
  head.append(riskSlot, expiry);

  const meta = h('dl', { class: 'gv-meta' });
  const body = h('div', { class: 'gv-card-body' });
  const pathNote = h('p', { class: 'gv-path-note', hidden: true });
  const hint = h('div', { class: 'gv-arming-hint', aria: { live: 'polite' } }, ARMING_TEXT);
  const status = h('div', { class: 'gv-status', role: 'status', aria: { live: 'polite' } });

  const allowOnce = button(
    [h('span', null, 'Allow once'), h('span', { class: 'kbd', aria: { hidden: 'true' } }, '1')],
    () => undefined,
    { class: 'btn btn-primary gv-decide', aria: { keyshortcuts: '1' } },
  );
  const allowTask = button(
    [h('span', null, 'Allow for this task'), h('span', { class: 'kbd', aria: { hidden: 'true' } }, '2')],
    () => undefined,
    { class: 'btn gv-decide', aria: { keyshortcuts: '2' } },
  );
  const deny = button(
    [h('span', null, 'Deny'), h('span', { class: 'kbd', aria: { hidden: 'true' } }, '3')],
    () => undefined,
    { class: 'btn btn-danger gv-decide', aria: { keyshortcuts: '3' } },
  );
  const actions = h('div', { class: 'gv-actions' }, allowOnce, allowTask, deny);

  const reasonId = nextId('deny-reason');
  const reason = h('input', {
    class: 'input gv-deny-input',
    id: reasonId,
    type: 'text',
    placeholder: 'Reason for the agent (optional)',
    maxLength: 2000,
    autocomplete: 'off',
  });
  const sendDeny = button('Send denial', () => undefined, { class: 'btn btn-danger gv-decide' });
  const backDeny = button('Back', () => closeDeny(), { class: 'btn btn-ghost' });
  const denyPanel = h(
    'div',
    { class: 'gv-deny', hidden: true },
    h('label', { class: 'field-label', for: reasonId }, 'Deny with a reason'),
    reason,
    h('div', { class: 'gv-actions' }, sendDeny, backDeny),
  );
  const expiredNote = h(
    'p',
    { class: 'gv-expired-note', hidden: true },
    'This request expired. The agent has to ask again.',
  );

  const el = h(
    'section',
    {
      class: ['gv-card', 'gv-approval', opts.compact && 'gv-compact'],
      role: 'group',
      aria: { labelledby: titleId },
      dataset: { approvalId: a.approval_id },
    },
    head,
    meta,
    body,
    pathNote,
    actions,
    denyPanel,
    expiredNote,
    hint,
    status,
  );

  const arming = armDecisions(el, { key: contentKey(a), hint, ...(opts.clock ? { clock: opts.clock } : {}) });
  for (const b of [allowOnce, allowTask, deny, sendDeny]) arming.register(b);

  const finish = (outcome: DecisionOutcome | 'modal'): void => {
    if (outcome === 'done' || outcome === 'already') {
      settled = true;
      for (const b of [allowOnce, allowTask, deny, sendDeny]) b.disabled = true;
    }
    opts.onDecided?.(outcome);
  };

  const openFull = (reach: 'once' | 'task'): void => {
    requestReach(a.approval_id, reach);
    openModal(ctx, { kind: 'approval', id: a.approval_id });
    finish('modal');
  };

  const doAllowOnce = async (): Promise<void> => {
    if (settled || isExpired(a, ctx.now())) return;
    if (grantPath(a, 'once') === 'modal') return openFull('once');
    setText(status, 'Allowing once…');
    const outcome = await decideApproval(ctx, a, { allow: true, reuse: 'once' });
    setText(status, outcome === 'done' ? 'Allowed once' : outcome === 'already' ? 'Already decided' : '');
    finish(outcome);
  };

  const doAllowTask = (): void => {
    if (settled || isExpired(a, ctx.now())) return;
    openFull('task');
  };

  const openDeny = (): void => {
    if (settled || isExpired(a, ctx.now())) return;
    denyPanel.hidden = false;
    actions.hidden = true;
    reason.focus();
  };

  const closeDeny = (): void => {
    denyPanel.hidden = true;
    actions.hidden = false;
    deny.focus();
  };

  const doDeny = async (): Promise<void> => {
    if (settled || isExpired(a, ctx.now())) return;
    setText(status, 'Denying…');
    const outcome = await decideApproval(ctx, a, { allow: false, note: reason.value });
    setText(status, outcome === 'done' ? 'Denied' : outcome === 'already' ? 'Already decided' : '');
    finish(outcome);
  };

  allowOnce.addEventListener(
    'click',
    arming.guard(() => void doAllowOnce()),
  );
  allowTask.addEventListener(
    'click',
    arming.guard(() => doAllowTask()),
  );
  deny.addEventListener(
    'click',
    arming.guard(() => openDeny()),
  );
  sendDeny.addEventListener(
    'click',
    arming.guard(() => void doDeny()),
  );

  // Keys 1 / 2 / 3, only while focus is inside the card (the scope exists only then) and never in
  // a text field (the keyboard skips bindings there).
  const keyed = (fn: () => void) => () => {
    if (!arming.isArmed() || !actions.isConnected || actions.hidden) return;
    fn();
  };
  const onFocusIn = (): void => {
    if (popScope) return;
    popScope = ctx.keys.push({
      name: 'approval-card',
      bindings: [
        { key: '1', run: keyed(() => void doAllowOnce()), description: 'Allow once' },
        { key: '2', run: keyed(doAllowTask), description: 'Allow for this task' },
        { key: '3', run: keyed(openDeny), description: 'Deny' },
      ],
    });
  };
  const onFocusOut = (e: FocusEvent): void => {
    const next = e.relatedTarget as Node | null;
    if (next && el.contains(next)) return;
    popScope?.();
    popScope = null;
  };
  el.addEventListener('focusin', onFocusIn);
  el.addEventListener('focusout', onFocusOut as EventListener);

  const renderExpiry = (): void => {
    if (countdown !== null) clearTimeout(countdown);
    countdown = null;
    const now = ctx.now();
    const expired = isExpired(a, now);
    if (expired) {
      setText(expiry, 'expired');
      expiry.classList.add('gv-expired');
    } else {
      expiry.classList.remove('gv-expired');
      setText(expiry, a.expires_at ? `expires ${timeUntil(a.expires_at, now)}` : 'no expiry');
    }
    actions.hidden = expired || !denyPanel.hidden;
    if (expired) denyPanel.hidden = true;
    expiredNote.hidden = !expired;
    el.classList.toggle('gv-is-expired', expired);
    if (!expired && a.expires_at) {
      const left = Date.parse(a.expires_at) - now;
      const step = left <= 60_000 ? 1000 : left <= 3_600_000 ? 15_000 : 60_000;
      countdown = setTimeout(renderExpiry, Math.max(250, Math.min(step, left)));
    }
  };

  const render = (): void => {
    replace(riskSlot, riskBadge(a));
    const agent = agentKeyOf(ctx.store.select('board'), a.requested_by_id) ?? a.requested_by_kind;
    replace(
      meta,
      h('div', { class: 'gv-meta-row' }, h('dt', null, 'Agent'), h('dd', { class: 'mono' }, visible(agent))),
      h(
        'div',
        { class: 'gv-meta-row' },
        h('dt', null, 'Task'),
        h('dd', null, taskLine(ctx.store.select('board'), a.task_id)),
      ),
      h(
        'div',
        { class: 'gv-meta-row' },
        h('dt', null, 'Capability'),
        h('dd', { class: 'mono' }, visible(a.capability)),
      ),
    );
    replace(
      body,
      agentText('Target', a.target, 'gv-target'),
      agentText('Purpose', a.purpose, 'gv-purpose'),
      hasHidden(a.capability) ? h('div', { class: 'hidden-warning' }, `Capability: ${HIDDEN_WARNING}`) : null,
    );
    const why = modalReason(a, 'once');
    pathNote.hidden = why === null;
    setText(pathNote, why ? `Allow once opens the full view. ${why}` : '');
    el.dataset.approvalId = a.approval_id;
    el.classList.toggle('gv-high', riskOf(a) === 'high');
    renderExpiry();
  };

  render();

  return {
    el,
    get approvalId() {
      return a.approval_id;
    },
    update(next: ApprovalRow): void {
      const changed = contentKey(next) !== contentKey(a);
      a = next;
      if (changed) {
        settled = false;
        for (const b of [allowOnce, allowTask, deny, sendDeny]) b.disabled = false;
        reason.value = '';
        denyPanel.hidden = true;
        setText(status, '');
      }
      render();
      if (changed) arming.changed(contentKey(a));
    },
    destroy(): void {
      if (countdown !== null) clearTimeout(countdown);
      countdown = null;
      popScope?.();
      popScope = null;
      arming.destroy();
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut as EventListener);
      el.remove();
    },
  };
}
