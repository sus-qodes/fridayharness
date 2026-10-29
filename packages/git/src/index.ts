/**
 * @friday/git
 * The Git state of one execution root (ADR-0014, ADR-0019): status, refs, log, diff, the
 * dirty-content identity used as a source version, and a watcher.
 */
export const PACKAGE_NAME = '@friday/git';

export {
  agentIdentity,
  type CommitIdentity,
  checkoutForVerification,
  commitAll,
  commitTree,
  FRIDAY_IDENTITY,
  goalBranch,
  isAncestor,
  type MergeResult,
  mergeCommits,
  moveRef,
  resolveCommit,
} from './integrate.js';
export {
  commitsSince,
  listRefs,
  preserveCommit,
  preservedPrefix,
  resetWorktree,
  snapshotWorktree,
} from './recover.js';
export {
  type ChangedPath,
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
  taskBranch,
  worktreesDir,
} from './worktree.js';
