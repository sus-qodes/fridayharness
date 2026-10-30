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
  // ADR-0034: project intent versions and learning proposals.
  'intent',
  'learning',
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
