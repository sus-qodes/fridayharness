import { type CommitIdentity, commitTree, FRIDAY_IDENTITY, moveRef, resolveCommit } from './integrate.js';
import { GitRoot } from './root.js';
import { runGit } from './run.js';

/**
 * Recovery plumbing (ADR-0026 §3–§4): the full state of a checkout recorded as a commit under a ref,
 * through a temporary index so neither the checkout nor its own index changes.
 */

/** Where the preserved states of a task's attempts live. */
export const preservedPrefix = (taskId: string) => `refs/friday/preserved/${taskId}/`;

/**
 * Records every file git sees in `dir` (tracked, and untracked but not ignored) as a commit on top
 * of HEAD. The worktree, its index and its branch stay exactly as they were. Returns null when
 * there is nothing beyond HEAD to keep.
 */
export async function snapshotWorktree(
  dir: string,
  message: string,
  author: CommitIdentity = FRIDAY_IDENTITY,
): Promise<string | null> {
  const root = await GitRoot.open(dir);
  if (!(await root.identity()).dirty) return null;
  const { head, tree } = await root.contentTree();
  return commitTree(root.root, tree, head ? [head] : [], message, author);
}

/** Stores `commit` under `<prefix><name>`, adding a suffix when that name is taken. */
export async function preserveCommit(mainRoot: string, prefix: string, name: string, commit: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const ref = `${prefix}${name}${i ? `-${i + 1}` : ''}`;
    if (await resolveCommit(mainRoot, ref)) continue;
    await moveRef(mainRoot, ref, commit, null);
    return ref;
  }
  throw new Error(`too many preserved states under ${prefix}${name}`);
}

/** The refs under a prefix, oldest name first. */
export async function listRefs(mainRoot: string, prefix: string): Promise<string[]> {
  const out = (await runGit(mainRoot, ['for-each-ref', '--format=%(refname)', prefix])).stdout;
  return out.split('\n').filter(Boolean).sort();
}

/** Commits on HEAD that `base` does not have (null when either is unknown). */
export async function commitsSince(dir: string, base: string | null): Promise<number | null> {
  if (!base) return null;
  const r = await runGit(dir, ['rev-list', '--count', `${base}..HEAD`], { okCodes: [128] });
  return r.code === 0 ? Number(r.stdout.trim()) : null;
}

/**
 * Writes a recorded state (a commit made by `snapshotWorktree` on top of the checkout's HEAD) into a
 * clean checkout as uncommitted changes: files it adds, changes or removes are added, changed or
 * removed, and the index stays at HEAD, as it was when the state was recorded (review F16).
 */
export async function applyState(dir: string, commit: string): Promise<void> {
  await runGit(dir, ['read-tree', '-m', '-u', 'HEAD', commit], { timeoutMs: 300_000 });
  await runGit(dir, ['reset', '-q'], { timeoutMs: 300_000 });
}

/** The parent of a commit, or null for a root commit or an unknown one. */
export async function parentOf(dir: string, commit: string): Promise<string | null> {
  const r = await runGit(dir, ['rev-parse', '--verify', '--quiet', `${commit}^1`], { okCodes: [1, 128] });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/**
 * Puts a checkout back at its last commit: tracked files restored, untracked ones removed, ignored
 * ones (installed dependencies, build output) kept. Only for a checkout whose state was preserved.
 */
export async function resetWorktree(dir: string): Promise<void> {
  await runGit(dir, ['reset', '-q', '--hard', 'HEAD'], { timeoutMs: 300_000 });
  await runGit(dir, ['clean', '-q', '-fd'], { timeoutMs: 300_000 });
}
