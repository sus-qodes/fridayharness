import { z } from 'zod';
import {
  AgentView,
  AssignmentView,
  GoalCreateRequest,
  GoalSummary,
  GoalView,
  HarnessView,
  HumanMessageRequest,
  MessageView,
  ModelCallView,
  PlanVersionView,
  RunView,
  TaskCreateRequest,
  TaskView,
  UsageReport,
  UsageRowView,
  VerificationView,
} from './api.js';
import { ContextPacket } from './context.js';
import { DomainEvent } from './envelope.js';
import { METHODS, OUTBOUND_METHODS } from './methods.js';

type JsonObject = Record<string, unknown>;

function toSchema(schema: z.ZodType, id: string): JsonObject {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) as JsonObject;
  return { $id: id, ...json };
}

/**
 * Every generated JSON Schema, keyed by its path under the repository's `schemas/` directory.
 * `pnpm --filter @friday/protocol gen:schemas` writes them; a test fails when the files drift.
 */
export function buildSchemas(): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = {};
  for (const [method, def] of Object.entries(METHODS)) {
    out[`protocol/v1/${method}.params.json`] = toSchema(def.params, `urn:friday:protocol:v1:${method}:params`);
    out[`protocol/v1/${method}.result.json`] = toSchema(def.result, `urn:friday:protocol:v1:${method}:result`);
  }
  for (const [method, schema] of Object.entries(OUTBOUND_METHODS)) {
    out[`protocol/v1/outbound/${method}.params.json`] = toSchema(schema, `urn:friday:protocol:v1:outbound:${method}`);
  }
  out['events/v1/envelope.json'] = toSchema(DomainEvent, 'urn:friday:events:v1:envelope');
  out['context/v1/packet.json'] = toSchema(ContextPacket, 'urn:friday:context:v1:packet');
  const api: Record<string, z.ZodType> = {
    'task-create-request': TaskCreateRequest,
    task: TaskView,
    run: RunView,
    harness: HarnessView,
    agent: AgentView,
    verification: VerificationView,
    'goal-create-request': GoalCreateRequest,
    goal: GoalView,
    'goal-summary': GoalSummary,
    'plan-version': PlanVersionView,
    'model-call': ModelCallView,
    assignment: AssignmentView,
    message: MessageView,
    'human-message-request': HumanMessageRequest,
    'usage-row': UsageRowView,
    'usage-report': UsageReport,
  };
  for (const [name, schema] of Object.entries(api)) {
    out[`api/v1/${name}.json`] = toSchema(schema, `urn:friday:api:v1:${name}`);
  }
  return out;
}

/** Stable serialization used for both writing and the drift test. */
export function serializeSchema(schema: JsonObject): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
