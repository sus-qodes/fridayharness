/**
 * Governance (plan §7.5): approvals, questions by kind, waiting agents, plan review and the
 * human's inbox. Other areas use the cards (the Notch shows them compact) and the tray; main.ts
 * calls `registerGovernance` once to add the modals and the inbox drawer.
 */
import type { AppContext } from '../shell/context.js';
import { h } from '../ui/dom.js';
import { approvalModal } from './approval-modal.js';
import { inboxDrawer } from './inbox.js';
import { planReview } from './plan-review.js';
import { questionCard } from './question-card.js';
import { recoverDialog } from './recover-dialog.js';

export type { ApprovalCard, ApprovalCardOptions } from './approval-card.js';
export { approvalCard } from './approval-card.js';
export { ARM_DELAY_MS, armDecisions } from './arming.js';
export {
  type ApprovalDecision,
  decideApproval,
  grantPath,
  isDeciding,
  needsHold,
  pendingApprovals,
} from './decisions.js';
export { HOLD_MS, holdButton } from './hold-button.js';
export type { QuestionCardOptions } from './question-card.js';
export { questionCard } from './question-card.js';
export { decisionItems, mountDecisionsTray, type TrayItem } from './tray.js';
export type { WaitingCardOptions } from './waiting-card.js';
export { waitingCard } from './waiting-card.js';

/** Registers the modals `approval`, `question`, `recover`, `plan-review` and the drawer `inbox`. */
export function registerGovernance(ctx: AppContext): void {
  const { registry } = ctx;
  registry.modal('approval', (c, request, close) => approvalModal(c, request, close));
  registry.modal('question', (c, request, close) => {
    const escalation = c.store.select('board')?.escalations.find((e) => e.escalation_id === request.id) ?? null;
    if (escalation?.status !== 'pending') {
      const el = h('p', { class: 'empty' }, 'This question is no longer pending.');
      return { el, title: 'Question', size: 'md' as const, destroy: () => el.remove() };
    }
    const card = questionCard(c, escalation, { onLater: close, onDone: close });
    return { el: card.el, title: 'Question', size: 'md' as const, destroy: () => card.destroy() };
  });
  registry.modal('recover', (c, request, close) => recoverDialog(c, request, close));
  registry.modal('plan-review', (c, request, close) => planReview(c, request, close));
  registry.drawer('inbox', (c, request) => inboxDrawer(c, request));
}
