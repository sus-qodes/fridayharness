import { FridayError } from '@friday/protocol';
import { isAncestor, resolveCommit } from './integrate.js';
import { GitRoot } from './root.js';
import { runGit } from './run.js';

/**
 * The code a backup holds (review F16): Friday's branches, the preserved states of earlier
 * attempts and the uncommitted work of task worktrees, in one git bundle with its full history, so
 * it restores into any clone of the repository, also one that never had these refs.
 */

/** Where a backup names a task worktree's uncommitted work while it writes the bundle. */
export const BACKUP_PREFIX = 'refs/friday/backup/';
/** Where a restore keeps a task worktree's uncommitted work from a backup, until recovery brings it back. */
export const RESTORED_PREFIX = 'refs/friday/restored/';
export const restoredRef = (taskId: string) => `${RESTORED_PREFIX}${taskId}`;
/** The refs a backup carries besides the uncommitted work it records. */
export const BACKUP_REF_PREFIXES = ['refs/heads/friday/', 'refs/friday/preserved/', RESTORED_PREFIX];

/** Whether a restore may write this ref: only Friday's own namespaces, never a branch of yours. */
export const isFridayRef = (ref: string) => ref.startsWith('refs/heads/friday/') || ref.startsWith('refs/friday/');

export interface BundleRef {
  ref: string;
  commit: string;
}

const heads = (out: string): BundleRef[] =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(' ');
      return { commit: l.slice(0, i), ref: l.slice(i + 1) };
    });

/** Writes the named refs, and every object they reach, into a bundle file. */
export async function writeBundle(root: string, file: string, refs: string[]): Promise<BundleRef[]> {
  if (!refs.length) throw new FridayError('invalid_request', 'a bundle needs at least one ref');
  await runGit(root, ['bundle', 'create', '-q', file, '--stdin'], {
    input: `${refs.join('\n')}\n`,
    timeoutMs: 600_000,
  });
  return readBundle(root, file);
}

/**
 * Checks a bundle against this repository and lists its refs. Throws with git's reason when the
 * bundle needs commits the repository does not have. Git checks the objects themselves only when
 * they are stored (`unbundle`); a backup's manifest also holds the bundle's sha256.
 */
export async function readBundle(root: string, file: string): Promise<BundleRef[]> {
  const v = await runGit(root, ['bundle', 'verify', '-q', file], { okCodes: [1, 128], timeoutMs: 600_000 });
  if (v.code !== 0) {
    throw new FridayError(
      'invalid_request',
      `the code bundle ${file} cannot be used here: ${v.stderr.trim() || v.stdout.trim()}`,
    );
  }
  return heads((await runGit(root, ['bundle', 'list-heads', file], { timeoutMs: 600_000 })).stdout);
}

/** Stores a bundle's objects in the repository, checking each. No ref changes. */
export async function unbundle(root: string, file: string): Promise<void> {
  const r = await runGit(root, ['bundle', 'unbundle', file], { okCodes: [1, 128], timeoutMs: 600_000 });
  if (r.code !== 0) {
    throw new FridayError('invalid_request', `the code bundle ${file} is damaged: ${r.stderr.trim().split('\n')[0]}`);
  }
}

export interface RefPlacement {
  ref: string;
  /** The backup's commit. */
  commit: string;
  /**
   * `created`: the ref was missing; `unchanged`: it already pointed there; `advanced`: it moved
   * forward to the backup's commit; `kept`: it stays where it is.
   */
  outcome: 'created' | 'unchanged' | 'advanced' | 'kept';
  /** For `kept`: the commit the ref still points at. */
  here?: string;
  /** For `kept` when the ref does not contain the backup's commit: where that commit is kept. */
  stored_at?: string;
}

async function setRef(root: string, ref: string, value: string, expected: string | null): Promise<void> {
  const r = await runGit(root, ['update-ref', '-m', 'friday: restore', ref, value, expected ?? ''], {
    okCodes: [1, 128],
  });
  if (r.code !== 0) throw new FridayError('git_conflict', `${ref} could not be restored: ${r.stderr.trim()}`);
}

/** The branches some checkout of this repository has (the main checkout and every worktree). */
export async function checkedOutBranches(root: string): Promise<Set<string>> {
  const trees = await (await GitRoot.open(root)).worktrees();
  return new Set(trees.map((w) => w.branch).filter((b): b is string => b !== null));
}

/**
 * Puts one of a backup's refs into this repository without losing anything (review F16): a
 * missing ref is created; one the backup's commit extends moves forward, unless a checkout has
 * it; any other stays as it is, and when it does not already contain the backup's commit, that
 * commit is kept beside it under `refs/friday/restored/kept/<stamp>/`.
 */
export async function placeRef(
  root: string,
  ref: string,
  commit: string,
  opts: { checkedOut: Set<string>; stamp: string },
): Promise<RefPlacement> {
  if (!isFridayRef(ref)) throw new FridayError('invalid_request', `${ref} is not one of Friday's refs`);
  const here = await resolveCommit(root, ref);
  if (!here) {
    await setRef(root, ref, commit, null);
    return { ref, commit, outcome: 'created' };
  }
  if (here === commit) return { ref, commit, outcome: 'unchanged' };
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
  if (!(branch && opts.checkedOut.has(branch)) && (await isAncestor(root, here, commit))) {
    await setRef(root, ref, commit, here);
    return { ref, commit, outcome: 'advanced' };
  }
  if (await isAncestor(root, commit, here)) return { ref, commit, outcome: 'kept', here };
  const stored = `${RESTORED_PREFIX}kept/${opts.stamp}/${ref.slice('refs/'.length)}`;
  await setRef(root, stored, commit, null);
  return { ref, commit, outcome: 'kept', here, stored_at: stored };
}
