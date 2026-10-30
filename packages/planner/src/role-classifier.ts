import {
  parseRoleDecision,
  type RoleDecision,
  type RoleDecisionInput,
  type RoleRegistry,
  roleDecisionBlockReason,
  roleRegistryRoles,
} from '@friday/routing';
import { type ParseResult, type PlannerOutcome, runPlanner } from './model.js';
import type { ModelRequest, PlannerModel } from './providers/types.js';

export const ROLE_CLASSIFIER_PROMPT_VERSION = 'role-classifier-1';

export interface RoleClassifierPolicy {
  allowRemote: boolean;
  remoteRefusal?: string;
  spentTodayUsd: number;
  dailyBudgetUsd: number;
  prices?: Parameters<typeof runPlanner>[3]['prices'];
}

export interface RoleClassifierSettings {
  model: string;
  maxTokens: number;
  minimumConfidence?: number;
}

function requestText(input: RoleDecisionInput): string {
  return JSON.stringify(
    {
      objective: input.objective,
      constraints: input.constraints,
      outcomes: input.outcomes,
      non_goals: input.non_goals,
      definition_of_done: input.definition_of_done,
      task: {
        summary: input.task_summary,
        description: input.task_description,
        kind: input.kind,
        risk_level: input.risk_level,
        scope: input.scope,
      },
    },
    null,
    2,
  );
}

/**
 * One bounded, structured role-classification call. It cannot choose a model or harness; the static
 * role registry remains the only dispatch authority. A low-confidence single role is an invalid
 * result that gets the one repair attempt; a clarification is valid so its questions can be stored
 * as the blocked role contract.
 */
export async function classifyTaskRoles(
  model: PlannerModel,
  registry: RoleRegistry,
  input: RoleDecisionInput,
  policy: RoleClassifierPolicy,
  settings: RoleClassifierSettings,
  signal?: AbortSignal,
  opts: {
    onCall?: (request: ModelRequest) => void;
    outbound?: (request: ModelRequest) => ModelRequest;
  } = {},
): Promise<PlannerOutcome<RoleDecision>> {
  const parse = (output: unknown): ParseResult<RoleDecision> => {
    try {
      const decision = parseRoleDecision(output, roleRegistryRoles(registry));
      // A clarification is a valid decision: the caller persists its questions and blocks the task.
      // Low confidence on a real classification is retried, then blocked by the caller.
      if (decision.status === 'classified') {
        const blocked = roleDecisionBlockReason(decision, settings.minimumConfidence ?? 0.7);
        if (blocked) return { ok: false, errors: [blocked] };
      }
      return { ok: true, value: decision };
    } catch (error) {
      return { ok: false, errors: [(error as Error).message] };
    }
  };
  return runPlanner(
    model,
    {
      purpose: 'role',
      model: settings.model,
      system:
        "You are Friday's role classifier. Return only the requested JSON shape. Choose roles, never models or harnesses. If facts are insufficient, return clarification_required.",
      context: `Known roles: ${Object.keys(registry.roles).join(', ')}`,
      instructions:
        'Classify the task into one or more known roles. Use role names as dependency labels when a later role depends on an earlier role. Do not invent roles.',
      prompt: requestText(input),
      schema: {
        type: 'object',
        oneOf: [
          {
            required: ['status', 'roles', 'assumptions'],
            properties: { status: { const: 'classified' }, roles: { type: 'array' }, assumptions: { type: 'array' } },
          },
          {
            required: ['status', 'missing_facts', 'questions'],
            properties: {
              status: { const: 'clarification_required' },
              missing_facts: { type: 'array' },
              questions: { type: 'array' },
            },
          },
        ],
      },
      schemaName: 'friday_role_decision',
      maxTokens: settings.maxTokens,
    },
    parse,
    policy,
    { promptVersion: ROLE_CLASSIFIER_PROMPT_VERSION, signal, ...opts },
  );
}
