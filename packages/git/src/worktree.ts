import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
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
