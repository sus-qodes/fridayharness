/**
 * @friday/git
 * The Git state of one execution root (ADR-0014, ADR-0019): status, refs, log, diff, the
 * dirty-content identity used as a source version, and a watcher.
 */
export const PACKAGE_NAME = '@friday/git';

export {
  BACKUP_PREFIX,
  BACKUP_REF_PREFIXES,
  type BundleRef,
  checkedOutBranches,
  isFridayRef,
  placeRef,
  RESTORED_PREFIX,
  type RefPlacement,
  readBundle,
  restoredRef,
  unbundle,
  writeBundle,
} from './bundle.js';
export {
  agentIdentity,
  type CommitIdentity,
  changedBetween,
  checkoutForVerification,
  commitContent,
  commitTree,
  FRIDAY_IDENTITY,
  goalBranch,
  isAncestor,
  type MergeResult,
  mergeCommits,
  moveRef,
  resolveCommit,
  treeOf,
} from './integrate.js';
export {
  applyState,
  commitsSince,
  listRefs,
  parentOf,
  preserveCommit,
  preservedPrefix,
  resetWorktree,
  snapshotWorktree,
} from './recover.js';
export {
  type ChangedPath,
  type ContentTree,
  type DiffEntry,
  GitRoot,
  type LogEntry,
  type Refs,
  type SourceIdentity,
  type WatchChange,
  type Worktree,
} from './root.js';
export { type RunOptions, type RunResult, runGit } from './run.js';
export { type EntryKind, parseStatusV2, type Status, type StatusEntry, type StatusHead } from './status.js';
export {
  type AllocateOptions,
  type Allocation,
  allocateWorktree,
  removeWorktree,
  rootKey,
  sameRepository,
  taskBranch,
  worktreesDir,
} from './worktree.js';
