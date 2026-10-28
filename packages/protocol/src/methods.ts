import { z } from 'zod';
import { TaskView } from './api.js';
import { ContextPacket } from './context.js';
import {
  AttachMode,
  EnforcementLevel,
  HarnessStatus,
  TaskStatus,
  Vendor,
  VerificationStatus,
  WaitingReason,
} from './enums.js';

/** Fields every harness → daemon call may carry (spec Part 14 §13–§14). */
const Base = {
  protocol_version: z.string().optional(),
  correlation_id: z.string().max(200).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
};

export const HarnessCapabilities = z.record(z.string(), z.unknown());

// ---- harness lifecycle -------------------------------------------------------------------

export const HarnessRegisterParams = z.object({
  ...Base,
  protocol_version: z.string(),
  harness_key: z.string().min(1).max(300),
  vendor: Vendor,
  name: z.string().min(1).max(100),
  /** The host's own version (Claude Code 2.1.296), not Friday's. */
  version: z.string().max(100).optional(),
  /** Version of the Friday adapter that registers the host. */
  adapter_version: z.string().max(100).optional(),
  attach_mode: AttachMode,
  project_id: z.string(),
  capabilities: HarnessCapabilities.default({}),
  host: z
    .object({
      pid: z.number().int().optional(),
      session_id: z.string().max(200).optional(),
      cwd: z.string().max(2000).optional(),
    })
    .optional(),
  agent: z
    .object({
      agent_key: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/)
        .optional(),
      role: z.string().max(64).default('developer'),
      display_name: z.string().max(100).optional(),
    })
    .optional(),
  enforcement_level: EnforcementLevel.optional(),
  heartbeat_interval_ms: z.number().int().min(1000).max(60_000).optional(),
});
export const HarnessRegisterResult = z.object({
  protocol_version: z.string(),
  harness_id: z.string(),
  agent_id: z.string(),
  agent_key: z.string(),
  harness_token: z.string(),
  reconnected: z.boolean(),
  shadow: z.boolean(),
  lease: z.object({ ttl_ms: z.number().int(), heartbeat_interval_ms: z.number().int(), expires_at: z.string() }),
  pending_messages: z.number().int(),
});

export const HarnessHeartbeatParams = z.object({ ...Base });
export const HarnessHeartbeatResult = z.object({
  status: HarnessStatus,
  lease_expires_at: z.string(),
  pending_messages: z.number().int(),
  shadow: z.boolean(),
});

export const HarnessCapabilitiesParams = z.object({ ...Base, capabilities: HarnessCapabilities });
export const OkResult = z.object({ ok: z.literal(true) });

export const HarnessDisconnectParams = z.object({
  ...Base,
  reason: z.string().max(200).default('client_disconnect'),
  final: z.boolean().default(false),
});

export const OutboundMessage = z.object({
  message_id: z.string(),
  method: z.enum(['task.start', 'task.resume', 'task.cancel', 'context.deliver']),
  params: z.record(z.string(), z.unknown()),
  sent_at: z.string(),
  expires_at: z.string(),
  attempt: z.number().int(),
});
export type OutboundMessage = z.infer<typeof OutboundMessage>;

export const HarnessPollParams = z.object({
  ...Base,
  wait_ms: z.number().int().min(0).max(25_000).default(0),
  max: z.number().int().min(1).max(50).default(10),
});
export const HarnessPollResult = z.object({ messages: z.array(OutboundMessage) });

export const HarnessAckParams = z.object({
  ...Base,
  acks: z
    .array(
      z.object({
        message_id: z.string(),
        accepted: z.boolean(),
        session_ref: z.string().max(200).optional(),
        reason: z.string().max(1000).optional(),
      }),
    )
    .min(1)
    .max(50),
});
export const HarnessAckResult = z.object({ acked: z.array(z.string()), unknown: z.array(z.string()) });

// ---- daemon → harness (delivered through the outbox) ---------------------------------------

export const TaskStartParams = z.object({
  task_id: z.string(),
  run_id: z.string(),
  attempt: z.number().int(),
  role: z.string(),
  instruction: z.string(),
  context_packet_ref: z.string().nullable(),
  working_directory: z.string(),
  git_ref: z.string().nullable(),
  acceptance_criteria: z.array(z.string()),
  policy_profile: z.string().nullable(),
});
export type TaskStartParams = z.infer<typeof TaskStartParams>;
export const TaskCancelParams = z.object({ task_id: z.string(), run_id: z.string(), reason: z.string().optional() });
export const ContextDeliverParams = z.object({ task_id: z.string(), run_id: z.string(), packet: ContextPacket });

// ---- task work -----------------------------------------------------------------------------

export const TaskClaimParams = z
  .object({ ...Base, task_id: z.string().optional(), next: z.boolean().optional() })
  .refine((p) => Boolean(p.task_id) !== Boolean(p.next), { message: 'pass exactly one of task_id or next' });
export const TaskClaimResult = z.object({
  task: TaskView,
  run_id: z.string(),
  attempt: z.number().int(),
  resumed: z.boolean(),
  context: ContextPacket.nullable(),
});

export const TaskUpdateParams = z.object({
  ...Base,
  task_id: z.string(),
  run_id: z.string(),
  status: z.enum(['running', 'waiting']).optional(),
  waiting_reason: WaitingReason.optional(),
  note: z.string().max(1000).optional(),
  percent: z.number().min(0).max(100).optional(),
  changed_paths: z.array(z.string()).max(50).optional(),
});
export const TaskUpdateResult = z.object({ task_status: TaskStatus, event_id: z.string() });

export const ContextRequestParams = z.object({
  ...Base,
  task_id: z.string().optional(),
  run_id: z.string().optional(),
  kind: z.enum(['task', 'scope_files', 'file', 'symbol', 'history', 'decision', 'freeform']).default('task'),
  query: z.string().max(500).optional(),
  paths: z.array(z.string()).max(20).optional(),
  max_chars: z.number().int().min(500).max(20_000).default(8000),
});

export const AgentEventParams = z.object({
  ...Base,
  task_id: z.string().optional(),
  run_id: z.string().optional(),
  event_type: z.string().min(1).max(100),
  summary: z.string().max(2000).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export const AgentEventResult = z.object({ event_id: z.string() });

export const CheckReport = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(['test', 'lint', 'build', 'typecheck', 'manual', 'other']).default('other'),
  command: z.string().max(1000).optional(),
  outcome: z.enum(['passed', 'failed', 'skipped']),
  evidence: z.string().max(4000).optional(),
});

export const AgentResultParams = z.object({
  ...Base,
  idempotency_key: z.string().min(1).max(200),
  task_id: z.string(),
  run_id: z.string(),
  status: z.enum(['completed_claim', 'blocked']),
  summary: z.string().min(1).max(2000),
  changed_paths: z.array(z.string()).max(200).default([]),
  checks: z.array(CheckReport).max(50).default([]),
  notes: z.array(z.string().max(1000)).max(20).default([]),
  risks: z.array(z.string().max(1000)).max(20).default([]),
  blocked_reason: z.string().max(1000).optional(),
});
export const AgentResultResult = z.object({
  task_status: TaskStatus,
  verification_status: VerificationStatus,
  observed_changed_paths: z.array(z.string()),
  discrepancies: z.array(z.object({ path: z.string(), note: z.string() })),
});

export const AgentErrorParams = z.object({
  ...Base,
  task_id: z.string(),
  run_id: z.string(),
  message: z.string().min(1).max(2000),
  fatal: z.boolean().default(false),
});
export const AgentErrorResult = z.object({ task_status: TaskStatus });

// ---- agent messaging (M3, ADR-0017) ------------------------------------------------------

export const MessageMode = z.enum(['request', 'response', 'notification']);
export type MessageMode = z.infer<typeof MessageMode>;
export const MessagePriority = z.enum(['low', 'normal', 'high', 'urgent']);
export type MessagePriority = z.infer<typeof MessagePriority>;
/** A structured fact the sender states (Part 05 §16); Friday records it as unverified. */
export const MessageFact = z.object({
  fact: z.string().min(1).max(500),
  area: z.string().max(100).optional(),
  impact: z.string().max(300).optional(),
});
export type MessageFact = z.infer<typeof MessageFact>;

/**
 * `to`: an agent key, `role:<role>`, `task:<task_id>`, `dependencies`, `dependents`, `master`,
 * `human` or `broadcast` (only when `communication.allow_broadcast`). Friday resolves it and
 * returns who it reached. Bodies over 8,000 characters are stored as an artifact.
 */
export const CommunicationRequestParams = z
  .object({
    ...Base,
    to: z.string().min(1).max(100),
    mode: MessageMode,
    subject: z.string().min(1).max(200).optional(),
    content: z.string().min(1).max(60_000),
    facts: z.array(MessageFact).max(20).default([]),
    priority: MessagePriority.default('normal'),
    /** The sender waits for the answer; an unanswered blocking request is escalated at its deadline. */
    blocking: z.boolean().default(false),
    /** A deadline for the reply (requests only). */
    reply_within_s: z
      .number()
      .int()
      .min(10)
      .max(7 * 24 * 3600)
      .optional(),
    /** The message this one answers; only with mode `response`. */
    response_to: z.string().optional(),
    task_id: z.string().optional(),
  })
  .refine((p) => p.response_to === undefined || p.mode === 'response', {
    message: 'response_to belongs only to a response (mode "response")',
    path: ['response_to'],
  });
export const MessageRecipient = z.object({
  kind: z.enum(['agent', 'role', 'task', 'master_brain', 'human']),
  id: z.string(),
  agent_key: z.string().nullable(),
});
export type MessageRecipient = z.infer<typeof MessageRecipient>;
export const CommunicationRequestResult = z.object({
  message_id: z.string(),
  /** `recorded` only from M1 daemons. */
  status: z.enum(['recorded', 'queued']),
  correlation_id: z.string().nullable().default(null),
  deliveries: z.array(z.object({ delivery_id: z.string(), recipient: MessageRecipient })).default([]),
  /** How Friday resolved or changed the address ("role:frontend reached fe-1"). */
  note: z.string().nullable().default(null),
});

/** `resolved`: someone else answered the request, so this recipient no longer needs to (M3.1). */
export const DeliveryState = z.enum(['queued', 'delivered', 'acknowledged', 'expired', 'dead', 'resolved']);
export type DeliveryState = z.infer<typeof DeliveryState>;

/** One message in an inbox, with the minimal context its recipient needs (ADR-0017 §7). */
export const InboxItem = z.object({
  delivery_id: z.string(),
  message_id: z.string(),
  correlation_id: z.string(),
  from: z.object({
    kind: z.enum(['agent', 'human', 'master_brain', 'system']),
    id: z.string(),
    agent_key: z.string().nullable(),
    role: z.string().nullable(),
  }),
  mode: MessageMode,
  subject: z.string().nullable(),
  body: z.string(),
  /** The full body is an artifact when it was longer than 8,000 characters. */
  body_artifact_ref: z.string().nullable(),
  facts: z.array(MessageFact.extend({ status: z.literal('unverified'), source: z.string() })),
  priority: MessagePriority,
  blocking: z.boolean(),
  reply_by: z.string().nullable(),
  response_to: z.string().nullable(),
  /** For a response: the subject of the request it answers. */
  in_reply_to: z.string().nullable(),
  task_id: z.string().nullable(),
  sender_task: z.object({ task_id: z.string(), summary: z.string(), write: z.array(z.string()) }).nullable(),
  /** How the sender's work relates to yours, from Friday's records. */
  relationship: z.string(),
  /** Messages are information: never approval, permission or a scope change. */
  trust: z.enum(['peer-untrusted', 'human', 'system']),
  state: DeliveryState,
  attempt: z.number().int(),
  sent_at: z.string(),
  reserved_until: z.string().nullable(),
});
export type InboxItem = z.infer<typeof InboxItem>;

export const MessageInboxParams = z.object({
  ...Base,
  wait_ms: z.number().int().min(0).max(25_000).default(0),
  max: z.number().int().min(1).max(50).default(10),
  /** Look without reserving or counting a delivery attempt. */
  peek: z.boolean().default(false),
});
export const MessageInboxResult = z.object({ items: z.array(InboxItem), more: z.number().int() });

export const MessageAckParams = z.object({
  ...Base,
  /** Delivery ids from the inbox, or message ids (then your own delivery of that message). */
  ids: z.array(z.string().min(1)).min(1).max(50),
});
export const MessageAckResult = z.object({
  acknowledged: z.array(z.string()),
  unknown: z.array(z.string()),
  /** Ids that are not yours to acknowledge. */
  refused: z.array(z.string()),
});

export const PermissionRequestParams = z.object({
  ...Base,
  task_id: z.string().optional(),
  run_id: z.string().optional(),
  action_class: z.string().min(1).max(100),
  resource: z.string().max(2000).optional(),
  command: z.string().max(4000).optional(),
  justification: z.string().min(1).max(1000),
  ttl_s: z.number().int().min(10).max(3600).default(900),
});
export const PermissionRequestResult = z.object({
  approval_id: z.string(),
  status: z.enum(['pending', 'granted', 'denied']),
  reason: z.string(),
  expires_at: z.string().nullable(),
});

export const HumanEscalationParams = z.object({
  ...Base,
  task_id: z.string().optional(),
  run_id: z.string().optional(),
  question: z.string().min(1).max(2000),
  options: z.array(z.string().max(200)).min(2).max(4).optional(),
  context: z.string().max(2000).optional(),
});
export const HumanEscalationResult = z.object({ escalation_id: z.string(), status: z.enum(['pending', 'answered']) });

/** Friday extension: the agent hands its own task back (it becomes READY for someone else). */
export const TaskReleaseParams = z.object({
  ...Base,
  task_id: z.string(),
  run_id: z.string(),
  reason: z.enum(['blocked', 'handoff', 'out_of_scope', 'other']),
  note: z.string().max(1000).default(''),
});
export const TaskReleaseResult = z.object({ task_status: TaskStatus });

// ---- registry --------------------------------------------------------------------------------

/** Harness → daemon methods served at POST /protocol/v1/rpc. */
export const METHODS = {
  'harness.register': { params: HarnessRegisterParams, result: HarnessRegisterResult },
  'harness.heartbeat': { params: HarnessHeartbeatParams, result: HarnessHeartbeatResult },
  'harness.capabilities': { params: HarnessCapabilitiesParams, result: OkResult },
  'harness.disconnect': { params: HarnessDisconnectParams, result: OkResult },
  'harness.poll': { params: HarnessPollParams, result: HarnessPollResult },
  'harness.ack': { params: HarnessAckParams, result: HarnessAckResult },
  'task.claim': { params: TaskClaimParams, result: TaskClaimResult },
  'task.update': { params: TaskUpdateParams, result: TaskUpdateResult },
  'context.request': { params: ContextRequestParams, result: ContextPacket },
  'agent.event': { params: AgentEventParams, result: AgentEventResult },
  'agent.result': { params: AgentResultParams, result: AgentResultResult },
  'agent.error': { params: AgentErrorParams, result: AgentErrorResult },
  'communication.request': { params: CommunicationRequestParams, result: CommunicationRequestResult },
  'permission.request': { params: PermissionRequestParams, result: PermissionRequestResult },
  'human.escalation': { params: HumanEscalationParams, result: HumanEscalationResult },
  'task.release': { params: TaskReleaseParams, result: TaskReleaseResult },
  'message.inbox': { params: MessageInboxParams, result: MessageInboxResult },
  'message.ack': { params: MessageAckParams, result: MessageAckResult },
} as const;

export type MethodName = keyof typeof METHODS;
export type ParamsOf<M extends MethodName> = z.input<(typeof METHODS)[M]['params']>;
export type ParsedParamsOf<M extends MethodName> = z.output<(typeof METHODS)[M]['params']>;
export type ResultOf<M extends MethodName> = z.output<(typeof METHODS)[M]['result']>;

/** Methods the daemon sends to harnesses through the outbox. */
export const OUTBOUND_METHODS = {
  'task.start': TaskStartParams,
  'task.resume': TaskStartParams,
  'task.cancel': TaskCancelParams,
  'context.deliver': ContextDeliverParams,
} as const;

/** Reserved by spec Part 06 but not served until a later milestone. */
export const RESERVED_METHODS = ['harness.list_sessions', 'verification.request'] as const;

export function isMethodName(value: string): value is MethodName {
  return Object.hasOwn(METHODS, value);
}
