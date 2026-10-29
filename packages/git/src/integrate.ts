import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { GitRoot } from './root.js';
import { runGit } from './run.js';
import { rootKey } from './worktree.js';

/**
 * Integration of verified task branches (ADR-0025 §2–§4). Plumbing only: `git merge-tree
 * --write-tree` (git 2.38 or later) merges two commits without any checkout, `commit-tree` records
 * the result, and `update-ref` moves a branch only from the value Friday last saw.
 */

/** Who a commit Friday makes names. Never the user: these commits are not theirs. */
export interface CommitIdentity {
  name: string;
  email: string;
}

/** `.invalid` is reserved (RFC 2606): the address can never reach anyone. */
export const FRIDAY_IDENTITY: CommitIdentity = { name: 'Friday', email: 'friday@friday.invalid' };

/** The identity of an agent's work that Friday commits for it. */
export const agentIdentity = (agentKey: string): CommitIdentity => ({
  name: `${agentKey} (via Friday)`,
  email: `${agentKey.replace(/[^A-Za-z0-9._-]/g, '-')}@agents.friday.invalid`,
});

/** Environment that makes git record `author` and `committer` on a commit. */
export const identityEnv = (author: CommitIdentity, committer: CommitIdentity = FRIDAY_IDENTITY) => ({
  GIT_AUTHOR_NAME: author.name,
  GIT_AUTHOR_EMAIL: author.email,
  GIT_COMMITTER_NAME: committer.name,
  GIT_COMMITTER_EMAIL: committer.email,
});

export const goalBranch = (goalId: string) => `friday/goal-${goalId}`;

/** The commit a revision names, or null when there is none. */
export async function resolveCommit(root: string, rev: string): Promise<string | null> {
  const r = await runGit(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { okCodes: [1, 128] });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** Whether `ancestor` is reachable from `commit` (equal counts). */
export async function isAncestor(root: string, ancestor: string, commit: string): Promise<boolean> {
  const r = await runGit(root, ['merge-base', '--is-ancestor', ancestor, commit], { okCodes: [1] });
  return r.code === 0;
}

export interface MergeResult {
  /** The merged tree. With conflicts it holds conflict markers and is never committed. */
  tree: string;
  /** Paths that conflict; empty for a clean merge. */
  conflicts: string[];
}

/** Merges two commits without touching any checkout. */
export async function mergeCommits(root: string, ours: string, theirs: string): Promise<MergeResult> {
  const r = await runGit(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs], {
    okCodes: [1],
    timeoutMs: 300_000,
  });
  const [tree = '', ...rest] = r.stdout.split('\0');
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new FridayError('git_conflict', `git merge-tree gave no tree: ${r.stderr.trim() || r.stdout.slice(0, 200)}`);
  }
  return { tree, conflicts: r.code === 1 ? [...new Set(rest.filter(Boolean))] : [] };
}

/** Records a commit of `tree` on top of `parents`. */
export async function commitTree(
  root: string,
  tree: string,
  parents: readonly string[],
  message: string,
  author: CommitIdentity = FRIDAY_IDENTITY,
): Promise<string> {
  const r = await runGit(root, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'], {
    input: message,
    env: identityEnv(author),
  });
  return r.stdout.trim();
}

/**
 * Moves `ref` to `value` only if it still points at `expected` (null: only if it does not exist
 * yet), so a ref someone moved meanwhile is never overwritten.
 */
export async function moveRef(root: string, ref: string, value: string, expected: string | null): Promise<void> {
  const r = await runGit(root, ['update-ref', '-m', 'friday: integrate', ref, value, expected ?? ''], {
    okCodes: [1, 128],
  });
  if (r.code !== 0) {
    throw new FridayError('git_conflict', `${ref} moved while Friday integrated into it: ${r.stderr.trim()}`);
  }
}

/** The tree a commit holds, or null when there is no such commit. */
export async function treeOf(root: string, rev: string): Promise<string | null> {
  const r = await runGit(root, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], { okCodes: [1, 128] });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** The paths whose content differs between two trees. */
export async function changedBetween(root: string, a: string, b: string): Promise<string[]> {
  const r = await runGit(root, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', a, b]);
  return r.stdout.split('\0').filter(Boolean);
}

/**
 * Commits exactly `tree`, content Friday verified, on top of `parent` in a checkout, and moves the
 * checkout's HEAD there only while it still names `parent` (review F04). The commit is built from
 * the tree, never from the files: a change made after the tree was taken stays an uncommitted change
 * in the checkout and never enters the commit. No hooks run. The index is then set to the new commit
 * when git lets it (a command of the agent's may hold it); the files are not touched.
 */
export async function commitContent(
  dir: string,
  tree: string,
  parent: string | null,
  message: string,
  author: CommitIdentity,
): Promise<string> {
  const commit = await commitTree(dir, tree, parent ? [parent] : [], message, author);
  const r = await runGit(dir, ['update-ref', '-m', 'friday: commit the verified work', 'HEAD', commit, parent ?? ''], {
    okCodes: [1, 128],
  });
  if (r.code !== 0) {
    throw new FridayError('git_conflict', `HEAD moved while Friday committed the verified work: ${r.stderr.trim()}`);
  }
  await runGit(dir, ['reset', '-q'], { timeoutMs: 300_000 }).catch(() => undefined);
  return commit;
}

/**
 * Friday's own checkout of a commit, detached, beside the task worktrees (`<key>/<name>`): where an
 * integrated revision is verified. Nobody else works in it, so checking out discards what checks
 * left behind, in tracked and in untracked files; ignored files (installed dependencies) stay.
 */
export async function checkoutForVerification(
  mainRoot: string,
  worktreesDir: string,
  name: string,
  commit: string,
): Promise<string> {
  const main = await GitRoot.open(mainRoot);
  const dir = path.join(worktreesDir, rootKey(main.root), name);
  const registered = (await main.worktrees()).some((w) =>
    process.platform === 'win32' ? w.path.toLowerCase() === dir.toLowerCase() : w.path === dir,
  );
  if (registered && existsSync(dir)) {
    await runGit(dir, ['checkout', '-q', '--detach', '--force', commit], { timeoutMs: 600_000 });
    await runGit(dir, ['clean', '-q', '-fd'], { timeoutMs: 300_000 });
  } else {
    await runGit(main.root, ['worktree', 'prune']);
    mkdirSync(path.dirname(dir), { recursive: true });
    await runGit(main.root, ['worktree', 'add', '-q', '--detach', dir, commit], { timeoutMs: 600_000 });
  }
  return dir;
}
