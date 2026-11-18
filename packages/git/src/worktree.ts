import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { commitTree, isAncestor, mergeCommits, mergeJoining, moveRef, resolveCommit } from './integrate.js';
import { applyState, preserveCommit, preservedPrefix, resetWorktree, snapshotWorktree } from './recover.js';
import { GitRoot } from './root.js';
import { runGit } from './run.js';

/**
 * Task worktrees (ADR-0023): one checkout per task, in a per-user folder beside Friday's state
 * directory, on the branch `friday/<task_id>`. Creating one is idempotent; removing one never
 * forces away uncommitted work.
 */

/** `FRIDAY_WORKTREES_DIR`, else `friday-worktrees` beside the state directory (ADR-0023 §4). */
export function worktreesDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FRIDAY_WORKTREES_DIR) return path.resolve(env.FRIDAY_WORKTREES_DIR);
  if (env.FRIDAY_STATE_DIR) return path.join(path.dirname(path.resolve(env.FRIDAY_STATE_DIR)), 'friday-worktrees');
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'friday-worktrees');
  }
  return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'friday-worktrees');
}

/** The 8-character key of a main checkout, as in the project key (plan B3). */
export function rootKey(mainRoot: string): string {
  const norm = process.platform === 'win32' ? mainRoot.toLowerCase() : mainRoot;
  return createHash('sha256').update(norm).digest('hex').slice(0, 8);
}

export const taskBranch = (taskId: string) => `friday/${taskId}`;

/**
 * Whether two checkouts are of one repository: they share a git common directory (review F08). A
 * clone of the project has its own, so a worktree of another clone is never taken for this one's.
 * Throws when either is not a git checkout.
 */
export async function sameRepository(a: string, b: string): Promise<boolean> {
  const common = async (dir: string) => {
    const refs = await (await GitRoot.open(dir)).refs();
    const real = await realpath(refs.commonDir);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  const [x, y] = await Promise.all([common(a), common(b)]);
  return x === y;
}

const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

/** Friday's tracked harness files: a worktree has them only once they are committed. */
const HARNESS_FILES = ['.mcp.json', '.claude/settings.json', '.claude/skills', '.friday/harness'];
/** Per-developer files kept out of git through the shared info/exclude: copied into worktrees. */
const LOCAL_FILES = ['.claude/settings.local.json'];

export interface AllocateOptions {
  /** Real path of the main checkout. */
  mainRoot: string;
  worktreesDir: string;
  taskId: string;
  /** Commit-ish to start a new branch from; default the main checkout's HEAD. */
  base?: string;
  project?: { project_id: string; name: string };
  timeoutMs?: number;
}

export interface Allocation {
  path: string;
  branch: string;
  /** The commit the worktree's branch pointed at when it was allocated. */
  base_commit: string;
  /** False when an existing worktree was reused. */
  created: boolean;
  /** True when the branch already existed (a previous attempt) and was checked out again. */
  reused_branch: boolean;
  warnings: string[];
}

export interface WorktreeRefresh {
  from: string;
  goal_head: string;
  head: string;
  commits: string[];
  preserved_ref: string | null;
  conflicts: { path: string; task: string; goal: string }[];
  /** Files where both sides only added lines at the same place: both additions are in the folder. */
  joined?: string[];
  /**
   * The folder holds the goal's work merged with the task's, and each of `conflicts` as git leaves
   * a file it cannot merge: both versions between `<<<<<<<` and `>>>>>>>`, for the agent to finish.
   */
  marked?: boolean;
}

/**
 * Merge a goal revision, then replay the recorded dirty delta without committing that delta.
 *
 * Where the two collide (2026-11-18) Friday still does the merge: the task's work as it stands
 * becomes a commit of its branch, that is merged with the goal revision, and the files git cannot
 * merge are left in the folder with both versions marked. The agent finishes them by editing, with
 * no git command of its own, and the branch then descends from the goal revision, so the work
 * integrates without colliding a second time. Before, the folder was left as it was and the agent
 * was told to merge: a git command it has to ask for, and one it could skip by editing, after which
 * its folder passed for a revert of everything the goal had gained.
 */
export async function refreshWorktree(opts: {
  dir: string;
  goalHead: string;
  taskId: string;
}): Promise<WorktreeRefresh> {
  const root = await GitRoot.open(opts.dir);
  const refs = await root.refs();
  if (!refs.linked || refs.branch !== taskBranch(opts.taskId) || !refs.head)
    throw new FridayError('invalid_request', 'only a task worktree with a HEAD can be refreshed');
  const from = refs.head;
  const goal = await resolveCommit(root.root, opts.goalHead);
  if (!goal) throw new FridayError('invalid_request', `the goal revision ${opts.goalHead} is missing`);
  const result: WorktreeRefresh = {
    from,
    goal_head: goal,
    head: from,
    commits: [],
    preserved_ref: null,
    conflicts: [],
  };
  if (await isAncestor(root.root, goal, from)) return result;
  result.commits = (await runGit(root.root, ['rev-list', '--reverse', `${from}..${goal}`])).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  const content = await root.contentTree();
  const saved = await snapshotWorktree(root.root, `Friday: preserve edits before refreshing ${opts.taskId}`);
  if (saved) result.preserved_ref = await preserveCommit(root.root, preservedPrefix(opts.taskId), 'refresh', saved);
  const merged = await mergeJoining(root.root, from, goal);
  const head = merged.conflicts.length
    ? from
    : (await isAncestor(root.root, from, goal))
      ? goal
      : await commitTree(root.root, merged.tree, [from, goal], `Friday: refresh ${opts.taskId} from goal ${goal}`);
  const replayed = saved && !merged.conflicts.length ? await mergeCommits(root.root, head, saved) : null;
  const conflicts = [...new Set([...merged.conflicts, ...(replayed?.conflicts ?? [])])];
  if (conflicts.length) {
    // The task's work as one commit: what is uncommitted in the folder is in `saved`, on `from`.
    const mine = saved ?? from;
    const both = await mergeJoining(root.root, mine, goal);
    const base = (await runGit(root.root, ['merge-base', mine, goal])).stdout.trim();
    const changes = async (side: string, file: string) => {
      const diff = await runGit(root.root, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--unified=1',
        base,
        side,
        '--',
        file,
      ]);
      return diff.stdout.length > 3000
        ? `${diff.stdout.slice(0, 3000)}\n[diff truncated after 3000 characters]`
        : diff.stdout;
    };
    for (const file of both.conflicts)
      result.conflicts.push({ path: file, task: await changes(mine, file), goal: await changes(goal, file) });
    const left = both.conflicts.length;
    const marked = await commitTree(
      root.root,
      both.tree,
      [mine, goal],
      left
        ? `Friday: merge goal ${goal} into ${opts.taskId}, ${left} file(s) left for its agent`
        : `Friday: refresh ${opts.taskId} from goal ${goal}`,
    );
    const now = await root.contentTree();
    if (now.head !== from || now.tree !== content.tree)
      throw new FridayError('git_conflict', 'the task worktree changed while its refresh was prepared; retry');
    // Every dirty file is in `saved`, an ancestor of the commit the folder moves to.
    if (saved) await resetWorktree(root.root);
    await runGit(root.root, ['read-tree', '-m', '-u', from, marked], { timeoutMs: 300_000 });
    await moveRef(root.root, 'HEAD', marked, from);
    result.head = marked;
    result.marked = left > 0;
    if (both.joined?.length) result.joined = both.joined;
    return result;
  }
  const restored = replayed
    ? await commitTree(root.root, replayed.tree, [head], `Friday: replay preserved edits of ${opts.taskId}`)
    : null;
  const current = await root.contentTree();
  const savedTree = saved ? (await runGit(root.root, ['rev-parse', `${saved}^{tree}`])).stdout.trim() : content.tree;
  if (current.head !== from || current.tree !== content.tree || savedTree !== content.tree)
    throw new FridayError('git_conflict', 'the task worktree changed while its refresh was prepared; retry');
  // Every dirty file is reachable through preserved_ref before Git clears it; ignored files stay.
  if (saved) await resetWorktree(root.root);
  await runGit(root.root, ['read-tree', '-m', '-u', from, head], { timeoutMs: 300_000 });
  await moveRef(root.root, 'HEAD', head, from);
  if (restored) await applyState(root.root, restored);
  result.head = head;
  if (merged.joined?.length) result.joined = merged.joined;
  return result;
}

/** Creates the task's worktree, or returns the one that already exists (ADR-0023 §2). */
export async function allocateWorktree(opts: AllocateOptions): Promise<Allocation> {
  const main = await GitRoot.open(opts.mainRoot);
  const refs = await main.refs();
  if (refs.linked)
    throw new FridayError('invalid_request', `${opts.mainRoot} is a linked worktree, not the main checkout`);
  const branch = taskBranch(opts.taskId);
  const keyDir = path.join(opts.worktreesDir, rootKey(main.root));
  const dir = path.join(keyDir, opts.taskId.slice(-8));
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const git = (args: string[], okCodes?: number[]) =>
    runGit(main.root, args, { timeoutMs, ...(okCodes ? { okCodes } : {}) });
  const warnings: string[] = [];

  // Registrations whose folders are gone are stale; git forgets them (it never touches a folder that exists).
  await git(['worktree', 'prune']);
  const existing = (await main.worktrees()).find((w) => w.branch === branch || samePath(w.path, dir));
  if (existing) {
    if (existing.branch !== branch) {
      throw new FridayError(
        'invalid_request',
        `${existing.path} is a worktree of another branch (${existing.branch ?? 'detached'})`,
      );
    }
    return {
      path: existing.path,
      branch,
      base_commit: existing.head ?? '',
      created: false,
      reused_branch: true,
      warnings,
    };
  }
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new FridayError(
      'invalid_request',
      `${dir} exists and is not a worktree of this project; Friday leaves it alone`,
    );
  }
  mkdirSync(keyDir, { recursive: true });
  const marker = path.join(keyDir, 'project.json');
  if (!existsSync(marker)) {
    writeFileSync(marker, `${JSON.stringify({ ...(opts.project ?? {}), main_checkout: main.root }, null, 2)}\n`);
  }
  const branchExists =
    (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], [1])).stdout.trim() !== '';
  if (branchExists) {
    await git(['worktree', 'add', dir, branch]);
  } else {
    const base = (await git(['rev-parse', '--verify', `${opts.base ?? 'HEAD'}^{commit}`])).stdout.trim();
    await git(['worktree', 'add', '-b', branch, dir, base]);
  }
  const head = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim();

  for (const rel of LOCAL_FILES) {
    const from = path.join(main.root, rel);
    const to = path.join(dir, rel);
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
  const uncommitted = (await git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...HARNESS_FILES])).stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3));
  if (uncommitted.length) {
    warnings.push(
      `Friday's harness files have uncommitted changes (${uncommitted.slice(0, 5).join(', ')}); a Claude Code session in the worktree runs without them until they are committed`,
    );
  }
  return { path: dir, branch, base_commit: head, created: true, reused_branch: branchExists, warnings };
}

/**
 * Removes a task worktree. Uncommitted changes are never forced away: git refuses, and so does
 * Friday. The branch stays, so committed work survives.
 */
export async function removeWorktree(mainRoot: string, dir: string): Promise<void> {
  const root = await GitRoot.open(dir).catch(() => null);
  if (root) {
    const status = await root.status();
    const id = await root.identity(status);
    if (id.dirty) throw new FridayError('worktree_dirty', `${dir} has ${id.files} uncommitted change(s); it is kept`);
    // The content is clean, but git trusts a size change without reading the file (a line-ending
    // conversion), and so would refuse the removal. Restaging those files records the same content
    // with fresh stat data; git's own check, which still catches an edit made since, then agrees.
    const stale = status.entries.filter((e) => e.kind === 'changed').map((e) => e.path);
    if (stale.length) await runGit(root.root, ['update-index', '-q', '--stdin'], { input: `${stale.join('\n')}\n` });
  }
  await runGit(mainRoot, ['worktree', 'remove', dir]);
}
