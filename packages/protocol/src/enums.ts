import { z } from 'zod';

/** Task lifecycle (spec Part 14 §4 + ADR-0003). */
export const TaskStatus = z.enum([
  'PROPOSED',
  'READY',
  'ASSIGNED',
  'RUNNING',
  'WAITING',
  'READY_FOR_VERIFICATION',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'REWORK',
  'HARNESS_LOST',
  'CANCELLED',
  'ABANDONED',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'CANCELLED', 'ABANDONED'];

export const WaitingReason = z.enum([
  'blocked',
  'context_required',
  'human_approval',
  'dependency_wait',
  'agent_error',
]);
export type WaitingReason = z.infer<typeof WaitingReason>;

export const AgentStatus = z.enum([
  'REGISTERED',
  'AVAILABLE',
  'ASSIGNED',
  'BUSY',
  'WAITING',
  'DISCONNECTED',
  'UNHEALTHY',
  'TERMINATED',
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const HarnessStatus = z.enum([
  'DISCOVERING',
  'REGISTERED',
  'READY',
  'BUSY',
  'DEGRADED',
  'DISCONNECTED',
  'RECONNECTING',
  'TERMINATED',
]);
export type HarnessStatus = z.infer<typeof HarnessStatus>;

export const RunStatus = z.enum(['STARTING', 'ACTIVE', 'DECLINED', 'SUSPENDED', 'ENDED']);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunOutcome = z.enum(['completed_claim', 'failed', 'cancelled', 'released', 'declined']);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const VerificationStatus = z.enum([
  'NOT_REQUESTED',
  'QUEUED',
  'RUNNING',
  'PASSED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

export const ActorKind = z.enum(['human', 'system', 'agent', 'harness', 'master_brain']);
export type ActorKind = z.infer<typeof ActorKind>;

export const Sensitivity = z.enum(['public', 'internal', 'sensitive', 'secret']);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const Priority = z.enum(['low', 'normal', 'high', 'urgent']);
export type Priority = z.infer<typeof Priority>;

export const RiskLevel = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const TaskKind = z.enum(['implementation', 'verification', 'review', 'research', 'docs', 'chore']);
export type TaskKind = z.infer<typeof TaskKind>;

export const Vendor = z.enum(['claude-code', 'codex', 'cursor', 'october', 'generic']);
export type Vendor = z.infer<typeof Vendor>;

export const AttachMode = z.enum(['attach', 'spawn']);
export type AttachMode = z.infer<typeof AttachMode>;

/** ADR-0010. */
export const EnforcementLevel = z.enum(['L0', 'L1', 'L2']);
export type EnforcementLevel = z.infer<typeof EnforcementLevel>;

/** ADR-0008. */
export const TokenClass = z.enum(['operator', 'bootstrap', 'harness']);
export type TokenClass = z.infer<typeof TokenClass>;

export const PolicyDecision = z.enum(['allow', 'deny', 'ask']);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const ApprovalStatus = z.enum(['pending', 'granted', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;
