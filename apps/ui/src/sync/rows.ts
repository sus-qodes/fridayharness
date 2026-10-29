/**
 * The pending rows an event payload describes (plan §7.2): an approval or a question shown from its
 * event in the same tick, before the snapshot is read again. Each is the row the daemon's projector
 * writes from the same payload, so the board shows the same thing before and after the re-read.
 * No DOM and no store: Node tests check these against the daemon's snapshot.
 */
import type { ApprovalRow, DomainEvent, EscalationView } from '@friday/protocol';

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

export function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The pending approval row an `approval.requested` payload describes, or null when it is not one. */
export function approvalFromEvent(event: DomainEvent): ApprovalRow | null {
  const a = record(record(event.payload).approval);
  const id = str(a.approval_id);
  if (!id || (a.status !== undefined && a.status !== 'pending')) return null;
  const risk = a.risk === 'low' || a.risk === 'medium' || a.risk === 'high' ? a.risk : null;
  const reuse = a.reuse === 'run' || a.reuse === 'task' ? a.reuse : 'once';
  return {
    approval_id: id,
    project_id: event.project_id,
    task_id: str(a.task_id),
    run_id: str(a.run_id),
    requested_by_kind: event.actor?.kind ?? 'agent',
    requested_by_id: event.actor?.id ?? '',
    capability: str(a.capability) ?? 'unknown',
    target: typeof a.target === 'string' ? a.target : null,
    purpose: typeof a.purpose === 'string' ? a.purpose : null,
    risk,
    status: 'pending',
    decided_by_kind: null,
    decided_by_id: null,
    decided_at: null,
    expires_at: str(a.expires_at),
    created_at: event.occurred_at,
    reuse,
    policy_version: str(a.policy_version),
    uses: 0,
    last_used_at: null,
    note: null,
    decided_via: null,
    expired: false,
  };
}

/**
 * The pending question an `escalation.requested` payload describes, or null when it is not one (an
 * agent's `context` is not kept in the row, so it is not shown here either).
 */
export function escalationFromEvent(event: DomainEvent): EscalationView | null {
  const x = record(record(event.payload).escalation);
  const id = str(x.escalation_id);
  if (!id || typeof x.question !== 'string') return null;
  const details = x.details && typeof x.details === 'object' && !Array.isArray(x.details) ? record(x.details) : null;
  return {
    escalation_id: id,
    project_id: event.project_id,
    task_id: str(x.task_id),
    run_id: str(x.run_id),
    goal_id: str(x.goal_id),
    kind: str(x.kind),
    question: x.question,
    status: 'pending',
    answer: null,
    requested_by_id: event.actor?.id ?? '',
    requested_by_kind: event.actor?.kind ?? 'agent',
    created_at: event.occurred_at,
    answered_at: null,
    options: Array.isArray(x.options) ? strings(x.options) : null,
    details,
  };
}
