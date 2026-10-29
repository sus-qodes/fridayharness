/**
 * @friday/policy
 * Sensitive paths, task scopes, command classes, autonomy and policy evaluation (spec Part 07).
 * Pure functions: the daemon and the dependency-free hook launcher share them.
 */
export const PACKAGE_NAME = '@friday/policy';

export {
  CAPABILITIES,
  type Capability,
  type CapabilityDecision,
  type CapabilityRequest,
  CLASS_CAPABILITY,
  capabilityOf,
  DEFAULT_RISK,
  evaluateCapability,
  type Risk,
} from './capabilities.js';
export {
  type Autonomy,
  type CommandClass,
  type CommandClassification,
  classifyCommand,
  classifySegment,
  DEFAULT_AUTONOMY,
  splitSegments,
} from './commands.js';
export {
  type ActionKind,
  type Decision,
  evaluate,
  evaluateSensitive,
  type OtherWriter,
  type PolicyAction,
  type PolicyInput,
  type PolicyResult,
  type PolicyTask,
} from './evaluate.js';
export {
  type CanonicalPath,
  canonicalize,
  globsOverlap,
  isInside,
  matchesAny,
  type PathContext,
  patternsOverlap,
  realDirectory,
} from './paths.js';
export {
  DEFAULT_BINARIES,
  describeOperation,
  type EffectiveOperation,
  type Loosening,
  type OperationDefinition,
  operationRisk,
  type PolicySource,
  type ProjectPolicy,
  projectPolicy,
} from './project-policy.js';
export {
  type SensitiveClass,
  type SensitiveHit,
  sensitiveClassOf,
  sensitiveInText,
  sensitivePattern,
} from './sensitive.js';
