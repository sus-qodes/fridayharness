import { z } from 'zod';
import { ActorKind, Sensitivity } from './enums.js';
import { idSchema } from './ids.js';

export const Actor = z.object({ kind: ActorKind, id: z.string().min(1).max(200) });
export type Actor = z.infer<typeof Actor>;

/** Carried by every state-transition event (plan B16). */
export const Transition = z.object({
  from: z.string(),
  to: z.string(),
  trigger: z.string(),
  reason: z.string().optional(),
});
export type Transition = z.infer<typeof Transition>;

export const RefKind = z.enum([
  'task',
  'run',
  'harness',
  'agent',
  'approval',
  'verification',
  'context',
  'escalation',
  // M2: the Master Brain's objects.
  'goal',
  'plan',
  'call',
  // M3: agent messages.
  'message',
  // M4: scoped memory.
  'memory',
  // M5: task worktrees, file reservations.
  'worktree',
  'reservation',
  'integration',
  // M6c: runs of operations by the gateway.
  'operation',
  // M7: routing decisions and pins.
  'routing',
]);
export type RefKind = z.infer<typeof RefKind>;

/** Canonical domain event envelope (spec Part 14 §2). */
export const DomainEvent = z.object({
  event_id: idSchema('evt'),
  sequence: z.number().int().positive(),
  schema_version: z.number().int().positive(),
  type: z.string().min(1),
  project_id: idSchema('proj'),
  actor: Actor,
  caused_by: z.array(z.string()),
  correlation_id: z.string().nullable(),
  occurred_at: z.string(),
  recorded_at: z.string(),
  payload: z.record(z.string(), z.unknown()),
  sensitivity: Sensitivity,
  redaction_status: z.enum(['none', 'redacted']),
  artifact_refs: z.array(z.string()),
});
export type DomainEvent = z.infer<typeof DomainEvent>;

/**
 * Event types emitted in M1. Transition events carry `payload.transition`.
 * Kept as documentation and for schema generation; the store accepts any non-empty type.
 */
export const EVENT_TYPES = [
  'project.created',
  'project.relocated',
  'daemon.started',
  'daemon.stopped',
  'task.created',
  'task.ready',
  'task.assigned',
  'task.started',
  'task.waiting',
  'task.resumed',
  'task.released',
  'task.completion_claimed',
  'task.verification_started',
  'task.verification_interrupted',
  'task.completed',
  'task.failed',
  'task.rework',
  'task.harness_lost',
  'task.cancelled',
  'run.created',
  'run.accepted',
  'run.declined',
  'run.suspended',
  'run.resumed',
  'run.ended',
  'run.paths_observed',
  'harness.registered',
  'harness.status_changed',
  'harness.session_bound',
  'agent.registered',
  'agent.status_changed',
  'agent.event',
  'verification.started',
  'verification.check_completed',
  'verification.finished',
  'verification.interrupted',
  'policy.evaluated',
  'context.compiled',
  'context.requested',
  'approval.requested',
  'approval.decided',
  'communication.recorded',
  'communication.sent',
  'communication.delivered',
  'communication.acknowledged',
  'communication.settled',
  'communication.expired',
  'communication.dead_lettered',
  'communication.escalated',
  'communication.resolved',
  'memory.recorded',
  'run.workspace_ready',
  // M7.1 (review R05): a run's claimed work brought into a worktree of this clone.
  'run.rebound',
  'worktree.allocated',
  'worktree.released',
  'worktree.removed',
  // M5c: file reservations (ADR-0025).
  'file.reserved',
  'file.reservation_ended',
  'ownership.conflict',
  // M5c: integration into goal branches (ADR-0025).
  'integration.completed',
  'integration.conflicted',
  'integration.failed',
  'integration.not_needed',
  // M5d: recovery of lost or failed attempts (ADR-0026).
  'recovery.performed',
  // M6a: bound approvals (ADR-0027).
  'approval.used',
  'approval.revoked',
  // M6c: operations run by the gateway (ADR-0029).
  'operation.started',
  'operation.finished',
  'operation.interrupted',
  // M7: model routing (ADR-0031).
  'routing.decided',
  'routing.blocked',
  'routing.violated',
  'routing.pinned',
  'routing.unpinned',
  'routing.outcome_recorded',
  'run.model_observed',
  'harness.model_observed',
  // M7c: Laya (ADR-0031 §10).
  'laya.answered',
  'laya.calibrated',
  'laya.unavailable',
  'memory.superseded',
  'memory.approved',
  'memory.retracted',
  'escalation.requested',
  'command.rejected',
] as const;
export type KnownEventType = (typeof EVENT_TYPES)[number];
