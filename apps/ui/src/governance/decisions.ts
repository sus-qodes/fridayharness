/**
 * Deciding approvals (plan FD-15, §7.2). One click only for `low` and `medium` risk with reach
 * `once` or `run` and a target that fits the card; `high` risk, reach `task`, or a target too long
 * to show in full opens the macro modal instead, where high risk and task reach need the hold.
 *
 * A decision is optimistic: the approval leaves `board.approvals` at once (both surfaces), the
 * daemon call follows with an explicit `reuse` (the client adds `via: 'ui'`), and a failure puts
 * it back, unless the daemon says it was already decided (409, `COS-2002`), which keeps it removed.
 */
import type { ApprovalRow, UiSnapshot } from '@friday/protocol';
import type { Reach } from '../api/client.js';
import { fits } from '../model/text.js';
import type { AppContext } from '../shell/context.js';
import { isAlreadyDecided, isExpired, riskOf } from './common.js';

export type ApprovalDecision = { allow: true; reuse: Reach } | { allow: false; note?: string };

export type DecisionOutcome = 'done' | 'already' | 'failed' | 'busy';

export const REACH_LABEL: Record<Reach, string> = {
  once: 'once',
  run: 'for this attempt',
  task: 'for this task',
};

/**
 * Why a grant at `reuse` cannot be one click (FD-15, FD-28), or null when it can. An unknown risk
 * counts as high.
 */
export function modalReason(a: Pick<ApprovalRow, 'risk' | 'target'>, reuse: Reach): string | null {
  if (riskOf(a) === 'high') return a.risk ? 'High risk needs the full view and a hold to authorize.' : 'Unknown risk.';
  if (reuse === 'task') return 'A grant for the whole task needs the full view and a hold to authorize.';
  if (!fits(a.target ?? '')) return 'The target is too long to decide from the card.';
  return null;
}

/** `one-click` when the card may grant it directly; `modal` otherwise. */
export function grantPath(a: Pick<ApprovalRow, 'risk' | 'target'>, reuse: Reach): 'one-click' | 'modal' {
  return modalReason(a, reuse) === null ? 'one-click' : 'modal';
}

/** High risk or a whole-task grant: the modal's Approve is a hold button. */
export function needsHold(a: Pick<ApprovalRow, 'risk'>, reuse: Reach): boolean {
  return riskOf(a) === 'high' || reuse === 'task';
}

/** Approvals being decided right now (their call is in flight). */
const deciding = new Set<string>();

export function isDeciding(approvalId: string): boolean {
  return deciding.has(approvalId);
}

/** Pending approvals a human can still decide: not expired, not being decided; oldest first. */
export function pendingApprovals(board: UiSnapshot | null, now: number): ApprovalRow[] {
  return (board?.approvals ?? [])
    .filter((a) => a.status === 'pending' && !isExpired(a, now) && !deciding.has(a.approval_id))
    .sort((x, y) => x.created_at.localeCompare(y.created_at));
}

function removeApproval(ctx: Pick<AppContext, 'store' | 'now'>, approvalId: string): number {
  const ui = ctx.store.select('ui');
  ctx.store.patch('ui', { decided: { ...ui.decided, [approvalId]: ctx.now() } });
  const board = ctx.store.select('board');
  if (!board) return -1;
  const index = board.approvals.findIndex((a) => a.approval_id === approvalId);
  if (index < 0) return -1;
  ctx.store.setState({ board: { ...board, approvals: board.approvals.filter((a) => a.approval_id !== approvalId) } });
  return index;
}

function restoreApproval(ctx: Pick<AppContext, 'store'>, approval: ApprovalRow, index: number): void {
  const { [approval.approval_id]: _gone, ...decided } = ctx.store.select('ui').decided;
  ctx.store.patch('ui', { decided });
  const board = ctx.store.select('board');
  if (!board) return;
  // A snapshot read while the call was in flight may already have brought it back.
  if (board.approvals.some((a) => a.approval_id === approval.approval_id)) return;
  const approvals = [...board.approvals];
  approvals.splice(index < 0 ? approvals.length : Math.min(index, approvals.length), 0, approval);
  ctx.store.setState({ board: { ...board, approvals } });
}

const ALREADY: unique symbol = Symbol('already decided');

/**
 * Grants or denies one approval. Resolves `done` on success, `already` when someone else decided
 * it first, `failed` when the call failed (the approval is back in the list and a toast says why),
 * `busy` when a decision of it is already in flight.
 */
export async function decideApproval(
  ctx: AppContext,
  approval: ApprovalRow,
  decision: ApprovalDecision,
): Promise<DecisionOutcome> {
  const id = approval.approval_id;
  if (deciding.has(id)) return 'busy';
  deciding.add(id);
  const index = removeApproval(ctx, id);
  try {
    const label = decision.allow ? `Allow ${approval.capability}` : `Deny ${approval.capability}`;
    const result = await ctx.act<unknown>(label, async () => {
      try {
        if (decision.allow) return await ctx.api.approve(id, decision.reuse);
        const note = decision.note?.trim();
        return await ctx.api.reject(id, note ? note : undefined);
      } catch (e) {
        if (isAlreadyDecided(e)) return ALREADY;
        throw e;
      }
    });
    if (result === undefined) {
      restoreApproval(ctx, approval, index);
      return 'failed';
    }
    if (result === ALREADY) {
      ctx.toast({ kind: 'info', text: 'This approval was already decided', detail: 'Someone decided it elsewhere.' });
      ctx.refresh();
      return 'already';
    }
    ctx.toast({
      kind: 'success',
      text: decision.allow ? `Allowed ${REACH_LABEL[decision.reuse]}` : 'Denied',
      detail: approval.capability,
      timeoutMs: 3000,
    });
    ctx.react(decision.allow ? 'approved' : 'denied', approval.capability);
    ctx.refresh();
    return 'done';
  } finally {
    deciding.delete(id);
  }
}

/** The reach the modal opens with, when the card opened it for a reach (Allow for this task). */
const requestedReach = new Map<string, Reach>();

export function requestReach(approvalId: string, reach: Reach): void {
  requestedReach.set(approvalId, reach);
}

export function takeRequestedReach(approvalId: string): Reach | null {
  const r = requestedReach.get(approvalId) ?? null;
  requestedReach.delete(approvalId);
  return r;
}
