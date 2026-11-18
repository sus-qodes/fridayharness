import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  /** Paths where both sides only added lines and both additions were kept (`mergeJoining`). */
  joined?: string[];
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

/** A file both sides changed, as `git merge-tree` lists it: the blob of each side and of their common start. */
interface Collision {
  path: string;
  base?: { mode: string; oid: string };
  ours?: { mode: string; oid: string };
  theirs?: { mode: string; oid: string };
}

/** Files a tool writes whole: two versions are never joined line by line. */
const GENERATED =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i;
/** Larger files are left to an agent. */
const JOIN_MAX_BYTES = 1_000_000;
const MARK = 40;
const MARK_OURS = '<'.repeat(MARK);
const MARK_BASE = '|'.repeat(MARK);
const MARK_THEIRS = '='.repeat(MARK);
const MARK_END = '>'.repeat(MARK);

/**
 * The file with both sides' additions, or null when the two versions collide anywhere in another
 * way than both adding lines at the same place: a line that was there before, changed or removed by
 * either, is a real collision. Read from git's own three-way comparison (`merge-file --diff3`),
 * written with markers too long to be taken for the file's text. Ours first; lines both sides added
 * alike at the start or the end of their additions are kept once (the same import, say), except
 * when those are only blank lines, which each block keeps as its spacing.
 */
function joinAdditions(marked: string): string | null {
  const out: string[] = [];
  let part: 'none' | 'ours' | 'base' | 'theirs' = 'none';
  let hunks = 0;
  let ours: string[] = [];
  let theirs: string[] = [];
  const blank = (l: string) => l.trim() === '';
  for (const raw of marked.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (part === 'none' && line.startsWith(`${MARK_OURS} `)) {
      part = 'ours';
      ours = [];
      theirs = [];
    } else if (part === 'ours' && line.startsWith(`${MARK_BASE} `)) part = 'base';
    else if (part === 'base' && line === MARK_THEIRS) part = 'theirs';
    else if (part === 'theirs' && line.startsWith(`${MARK_END} `)) {
      if (!ours.length || !theirs.length) return null;
      let head = 0;
      while (head < ours.length && head < theirs.length && ours[head] === theirs[head]) head += 1;
      if (ours.slice(0, head).every(blank)) head = 0;
      let tail = 0;
      while (
        tail < ours.length - head &&
        tail < theirs.length - head &&
        ours[ours.length - 1 - tail] === theirs[theirs.length - 1 - tail]
      )
        tail += 1;
      if (ours.slice(ours.length - tail).every(blank)) tail = 0;
      out.push(...ours.slice(0, ours.length - tail), ...theirs.slice(head));
      hunks += 1;
      part = 'none';
    } else if (part === 'base')
      return null; // a line that was there before: one side changed or removed it
    else if (part === 'ours') ours.push(raw);
    else if (part === 'theirs') theirs.push(raw);
    else out.push(raw);
  }
  return part === 'none' && hunks > 0 ? out.join('\n') : null;
}

/**
 * Merges two commits like `mergeCommits`, and keeps both sides' lines where they only added at the
 * same place of a file that was there before (2026-11-18): two tasks that each append an entry to a
 * changelog, a route to a list, a text to a strings file. Git calls that a conflict because it
 * cannot know the order; here the order is ours first (`joinAdditions`).
 * `joined` names those files. Everything else stays a conflict: a line one side changed or removed,
 * a file both created, a file one side deleted, a binary or generated file, a file without a final
 * newline. The merged revision is checked like any other before a branch moves to it.
 */
export async function mergeJoining(root: string, ours: string, theirs: string): Promise<MergeResult> {
  const plain = await mergeCommits(root, ours, theirs);
  if (!plain.conflicts.length) return plain;
  const r = await runGit(root, ['merge-tree', '--write-tree', '--no-messages', '-z', ours, theirs], {
    okCodes: [1],
    timeoutMs: 300_000,
  });
  const [tree = '', ...rows] = r.stdout.split('\0');
  if (tree !== plain.tree) return plain;
  const files = new Map<string, Collision>();
  for (const row of rows) {
    const m = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/s.exec(row);
    if (!m) continue;
    const file = files.get(m[4] as string) ?? { path: m[4] as string };
    const side = { mode: m[1] as string, oid: m[2] as string };
    if (m[3] === '1') file.base = side;
    else if (m[3] === '2') file.ours = side;
    else file.theirs = side;
    files.set(file.path, file);
  }
  const joined: { path: string; mode: string; oid: string }[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'friday-join-'));
  try {
    const blob = async (oid: string, name: string): Promise<string | null> => {
      const bytes = (await runGit(root, ['cat-file', 'blob', oid], { raw: true })).bytes ?? Buffer.alloc(0);
      const text = bytes.length <= JOIN_MAX_BYTES && !bytes.includes(0);
      // A last line without its newline would be glued to the other side's first line.
      if (!text || (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a)) return null;
      const file = path.join(dir, name);
      writeFileSync(file, bytes);
      return file;
    };
    for (const f of files.values()) {
      if (!plain.conflicts.includes(f.path) || GENERATED.test(f.path)) continue;
      // Both changed a file that was there before, and neither changed what kind of file it is.
      if (!f.base || !f.ours || !f.theirs || f.ours.mode !== f.theirs.mode || !/^100/.test(f.ours.mode)) continue;
      const [o, b, t] = [
        await blob(f.ours.oid, 'ours'),
        await blob(f.base.oid, 'base'),
        await blob(f.theirs.oid, 'theirs'),
      ];
      if (!o || !b || !t) continue;
      const codes = Array.from({ length: 127 }, (_, i) => i + 1);
      const marked = await runGit(
        root,
        ['merge-file', '-p', '--diff3', `--marker-size=${MARK}`, '-L', 'ours', '-L', 'base', '-L', 'theirs', o, b, t],
        { okCodes: codes, raw: true },
      );
      // Read byte for byte (latin1 keeps every byte), so the file's own encoding and line ends stay.
      const both = marked.code === 0 ? null : joinAdditions((marked.bytes ?? Buffer.alloc(0)).toString('latin1'));
      if (both === null) continue;
      const out = path.join(dir, 'joined');
      writeFileSync(out, Buffer.from(both, 'latin1'));
      const oid = (await runGit(root, ['hash-object', '-w', '--no-filters', out])).stdout.trim();
      if (/^[0-9a-f]{40,64}$/.test(oid)) joined.push({ path: f.path, mode: f.ours.mode, oid });
    }
    if (!joined.length) return plain;
    const gitDir = (await runGit(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    const index = path.join(gitDir, `friday-join-${randomBytes(4).toString('hex')}.index`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await runGit(root, ['read-tree', plain.tree], { env });
      for (const j of joined) {
        await runGit(root, ['update-index', '--cacheinfo', `${j.mode},${j.oid},${j.path}`], { env });
      }
      const merged = (await runGit(root, ['write-tree'], { env })).stdout.trim();
      const done = new Set(joined.map((j) => j.path));
      return { tree: merged, conflicts: plain.conflicts.filter((c) => !done.has(c)), joined: [...done] };
    } finally {
      rmSync(index, { force: true });
    }
  } catch {
    // Joining is a convenience: when any step of it fails, the files stay the conflict git found.
    return plain;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

/**
 * Where the commit of a task's verified work in the project folder is kept (2026-11-17): one per
 * verification, so integration takes exactly what that verification judged.
 */
export function verifiedRef(taskId: string, verificationId: string): string {
  return `refs/friday/verified/${taskId}/${verificationId}`;
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
