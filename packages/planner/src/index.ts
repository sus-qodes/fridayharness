/**
 * @friday/planner
 * The Master Brain (spec Part 03): goals become versioned plans of tasks, delegated by a
 * deterministic policy, revised on failure, escalated to humans when needed. Model calls go
 * through a provider interface (ADR-0013).
 */
export const PACKAGE_NAME = '@friday/planner';

export {
  type BrainDeps,
  type BrainReport,
  type BrainSettings,
  type BrainStep,
  MASTER_BRAIN,
  MasterBrain,
  type RemotePolicy,
  redactRequest,
} from './brain.js';
export { CONSOLIDATE_MAX_TASKS, type Consolidation, consolidatePlan } from './consolidate.js';
export {
  DELEGATION_WEIGHTS,
  type DelegationCandidate,
  type DelegationDecision,
  type DelegationTask,
  delegate,
  scoreCandidate,
} from './delegate.js';
export { diffPlanVersions, type PlanDiff, type PlanVersionTask } from './diff.js';
export { buildEscalation, type Escalation, type EscalationDetails, type EscalationReason } from './escalate.js';
export {
  draftProjectIntent,
  FEEDBACK_SOURCE,
  INTENT_DRAFTER_PROMPT_VERSION,
  INTENT_FEEDBACK_MAX_CHARS,
  type IntentRevision,
  type IntentSource,
  type ProjectIntentDraft,
  parseIntentDraft,
} from './intent-drafter.js';
export {
  budgetedCost,
  formatIssues,
  type ParseResult,
  type PlannerCall,
  type PlannerOutcome,
  type PlannerPolicy,
  requestEstimate,
  runPlanner,
} from './model.js';
export { parsePlanDraft, parseReplanDraft } from './parse.js';
export { costOf, DEFAULT_PRICES, type ModelPrice, type PriceTable, priceEntry, worstCaseCost } from './pricing.js';
export {
  type GoalForPrompt,
  goalBlock,
  PLAN_INSTRUCTIONS,
  PLANNER_SYSTEM,
  PROMPT_VERSIONS,
  planPrompt,
  REPLAN_INSTRUCTIONS,
  repairPrompt,
  replanPrompt,
} from './prompts.js';
export { existingTasks, type ProposalMeta, proposalFromDraft, proposalFromReplan, taskInput } from './proposals.js';
export {
  AnthropicPlannerModel,
  type AnthropicPlannerOptions,
  DEFAULT_PLANNER_MODEL,
  type Effort,
  structuredOutputSchema,
  wrapProjectContext,
} from './providers/anthropic.js';
export { FakePlannerModel, type FakeResponse } from './providers/fake.js';
export {
  DEFAULT_LOCAL_BASE_URL,
  jsonModeInstructions,
  localEndpoint,
  localOutputSchema,
  type OpenAICompatibleOptions,
  OpenAICompatiblePlannerModel,
  usageFrom,
} from './providers/openai-compatible.js';
export {
  type Billed,
  ModelError,
  type ModelErrorCode,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type PlannerModel,
  ZERO_USAGE,
} from './providers/types.js';
export {
  classifyTaskRoles,
  ROLE_CLASSIFIER_PROMPT_VERSION,
  type RoleClassifierPolicy,
  type RoleClassifierSettings,
} from './role-classifier.js';
export {
  draftJsonSchema,
  NeedsHuman,
  PLAN_LIMITS,
  PlanDraft,
  type PlanDraftInput,
  PlanKey,
  PlanTaskDraft,
  ReplanDraft,
  type ReplanDraftInput,
  ScopeGlob,
} from './schemas.js';
export { type BrainAction, failureAction, type TriggerEvent, type TriggerFacts, triggersFor } from './triggers.js';
export {
  type ExistingTask,
  isReadOnly,
  type PlanTaskBounder,
  type ValidationResult,
  validatePlanDraft,
  validateReplanDraft,
} from './validate.js';
