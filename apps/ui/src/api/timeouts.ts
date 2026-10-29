/**
 * Per-route timeouts (plan §2): routes that hold the request until their work is done get at least
 * the time the CLI gives them, so the interface never gives up on work that is still running.
 */
export const TIMEOUTS = {
  /** Ordinary reads and commands. */
  default: 30_000,
  /** Verify, integrate, backup: as long as the slowest check may run. */
  long: 3_700_000,
  /** Replan, recover, halt, worktree creation. */
  medium: 600_000,
  /** Task and goal diffs read git. */
  diff: 60_000,
  /** `GET graph`, `graph/query` rebuild the main checkout's graph; `context/compile`. */
  graph: 120_000,
  /** `GET worktrees`, `worktrees/prune`. */
  worktrees: 300_000,
  /** Claude Code setup runs `harness config` and `harness doctor`. */
  setup: 120_000,
} as const;
