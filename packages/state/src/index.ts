/**
 * @friday/state
 * Command bus, projector, idempotency, queries and every state operation (M1 tasks and harnesses, M2 goals and plans).
 */
export const PACKAGE_NAME = '@friday/state';

export { CommandBus, type CommandContext, type CommandMeta, type CommandOutcome, stableStringify } from './bus.js';
export {
  decayWeight,
  ftsQuery,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryActor,
  type MemoryAuthority,
  type MemoryInput,
  type MemoryKind,
  type MemoryScope,
  MemoryService,
  type MemoryView,
  type RecordResult,
  type SearchHit,
  type SearchQuery,
  subjectKey,
} from './memory.js';
export {
  ALL_MIGRATIONS,
  CONSUMER_MIGRATIONS,
  DOMAIN_TABLES,
  MASTER_BRAIN_MIGRATIONS,
  MESSAGING_MIGRATIONS,
  STABILIZATION_MIGRATIONS,
  STATE_MIGRATIONS,
} from './migrations.js';
export { StateProjector } from './projector.js';
export { type HarnessRecord, type LayaAnswerRecord, type LayaCalibrationRecord, Queries } from './queries.js';
export {
  achievedEnforcement,
  type BrainJob,
  type BrainJobInput,
  type Caller,
  DEFAULT_STATE_CONFIG,
  FridayState,
  hostCohort,
  INSPECTION_MARKER,
  isInspectionCopy,
  type ModelCallInput,
  normalizePath,
  type PlanApproval,
  type PlanProposal,
  type PlanTaskInput,
  type RunRouter,
  type RunRouting,
  type StateConfig,
  type TokenInfo,
  type VerificationRevision,
  type Workspace,
} from './service.js';
export {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  type BackupArtifact,
  type BackupCode,
  type BackupReport,
  backupTo,
  createSnapshot,
  listSnapshots,
  type ReplayReport,
  replayInto,
  SNAPSHOT_DIR,
  SNAPSHOT_FORMAT,
  SNAPSHOT_FORMAT_VERSION,
  type SnapshotHeader,
  type SnapshotInfo,
  snapshotPath,
  verifySnapshot,
} from './snapshot.js';
