import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runGit } from '@friday/git';
import { type Actor, FridayError } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';

/** What landing a goal did, or why it did nothing. */
export interface LandResult {
  goal_id: string;
  /** `landed`: the branch was merged; `already`: there was nothing to bring. */
  status: 'landed' | 'already';
  branch: string;
  /** The person's branch it was merged into. */
  into: string;
  /** The checkout's HEAD after it. */
  head: string;
  fast_forward: boolean;
}

/** Where a goal's finished work is: on its goal branch, in the project folder itself, or both. */
export type GoalWork = 'branch' | 'folder' | 'mixed';

/**
 * What "Land" would do for a goal, read before anyone clicks (2026-11-17): the branch it lands
 * into by name, and the one thing in the way when there is one, in words a person can act on.
 */
export interface LandPlan {
  goal_id: string;
  branch: string;
  /** The branch the project folder has checked out; null on a detached HEAD. */
  into: string | null;
  /**
   * `ready`: Land merges the goal branch. `landed`: the folder's branch already has it.
   * `in_folder`: the goal's work was made in the project folder itself (sessions attached from an
   * editor, or worktrees off), so there is nothing to land: the person reviews and commits it.
   * `blocked`: something in the folder is in the way (`reason`, `files`). `not_completed`.
   */
  state: 'ready' | 'landed' | 'in_folder' | 'blocked' | 'not_completed';
  reason: string | null;
  /** The files in the way (`blocked`), or the folder's uncommitted files (`in_folder`); 50 at most. */
  files: string[];
  /** Commits the goal branch has that the folder's branch does not. */
  commits: number;
  work: GoalWork;
}

const MAX_REASON = 600;
const MAX_FILES = 50;
/** Longer than a slow hook or a large checkout needs; the desktop waits longer still (lib.rs). */
const MERGE_TIMEOUT_MS = 120_000;

/** The first lines git said, without its hints: what a person reads in the refusal. */
function said(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'))
    .join(' ')
    .slice(0, MAX_REASON);
}

/**
 * Where a goal's completed tasks worked. A run without a branch worked in the project folder
 * itself: a session attached from an editor (Antigravity, Claude Code in VS Code), or any run with
 * `worktrees.mode: off`. Since 2026-11-17 the work of a session its person runs there is kept as a
 * commit and integrated, so it counts as on the branch; only work that was never integrated
 * (worktrees off, or verified before that) is in the folder alone.
 */
export function goalWork(state: FridayState, projectId: string, goalId: string): GoalWork {
  let folder = 0;
  let branch = 0;
  for (const t of state.q.goalTasks(projectId, goalId)) {
    if (t.status !== 'COMPLETED') continue;
    const run = state.q.runs(t.task_id).at(-1);
    if (!run) continue;
    if (run.branch_ref || state.q.latestIntegration(projectId, t.task_id)?.status === 'integrated') branch += 1;
    else folder += 1;
  }
  if (folder > 0 && branch > 0) return 'mixed';
  return folder > 0 ? 'folder' : 'branch';
}

export interface Entry {
  path: string;
  staged: boolean;
  untracked: boolean;
}

/** `git status --porcelain -z`, one entry per path (a rename's old path is dropped). */
export async function folderStatus(root: string): Promise<Entry[]> {
  const out = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
    okCodes: [128],
  });
  const parts = out.stdout.split('\0');
  const entries: Entry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i] ?? '';
    if (p.length < 4) continue;
    const x = p[0] ?? ' ';
    const y = p[1] ?? ' ';
    // A rename or a copy carries its source as the next field.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1;
    const untracked = x === '?' && y === '?';
    entries.push({ path: p.slice(3), untracked, staged: !untracked && x !== ' ' });
  }
  return entries;
}

/** What the person is in the middle of in this folder, or null: Land never touches it. */
async function inProgress(root: string): Promise<string | null> {
  const marks: [string, string][] = [
    ['MERGE_HEAD', 'a merge'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['BISECT_LOG', 'a bisect'],
  ];
  for (const [name, what] of marks) {
    const p = await runGit(root, ['rev-parse', '--git-path', name], { okCodes: [128] });
    const file = p.stdout.trim();
    if (p.code === 0 && file && existsSync(path.resolve(root, file))) return what;
  }
  return null;
}

/** True when `file` is an entry of the folder's status, or lies under an untracked folder of it. */
export function covers(entry: Entry, file: string): boolean {
  return entry.path === file || (entry.path.endsWith('/') && file.startsWith(entry.path));
}

interface Inspection {
  plan: LandPlan;
  /** Set when the plan is `ready` or `landed`: what the merge works from. */
  tip: string | null;
  before: string | null;
  /** The files the merge would write, and the folder's status before it. */
  touched: string[];
  status: Entry[];
  /**
   * Files the goal changes that the folder already holds, uncommitted, with exactly the goal's
   * content: the work a session did in this folder, which reached the goal branch from here.
   */
  already?: string[];
}

/**
 * Whether the folder's `file` is, as git would store it, what `tip` has there (both absent counts).
 * `git hash-object` applies the same filters as `git add`, so a line-ending difference the
 * repository normalises is not a difference.
 */
export async function sameAsTip(root: string, tip: string, file: string): Promise<boolean> {
  const theirs = await runGit(root, ['rev-parse', '--verify', '--quiet', `${tip}:${file}`], { okCodes: [1, 128] });
  const here = existsSync(path.resolve(root, file));
  if (theirs.code !== 0) return !here;
  if (!here) return false;
  const mine = await runGit(root, ['hash-object', '--', file], { okCodes: [1, 128] });
  return mine.code === 0 && mine.stdout.trim() === theirs.stdout.trim();
}

async function inspect(state: FridayState, project: ProjectRef, goalId: string, partial = false): Promise<Inspection> {
  const pid = project.project_id;
  const goal = state.q.findGoal(pid, goalId);
  if (!goal) throw new FridayError('goal_not_found', `no goal ${goalId}`);
  const root = project.root;
  const branch = `friday/goal-${goalId}`;
  const work = goalWork(state, pid, goalId);
  const current = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [1, 128] });
  const into = current.code === 0 ? current.stdout.trim() : null;
  const base: LandPlan = { goal_id: goalId, branch, into, state: 'ready', reason: null, files: [], commits: 0, work };
  const none = { tip: null, before: null, touched: [], status: [] };
  // `partial`: what the goal has so far, while it is still worked on (landing each task).
  if (goal.status !== 'COMPLETED' && !(partial && goal.status === 'ACTIVE')) {
    return {
      plan: { ...base, state: 'not_completed', reason: `the goal is ${goal.status}; only a completed goal lands` },
      ...none,
    };
  }
  const tipRef = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    okCodes: [1, 128],
  });
  if (tipRef.code !== 0) {
    // Nothing was integrated: every task worked in the project folder, where its work already is.
    const status = await folderStatus(root);
    return {
      plan: {
        ...base,
        state: 'in_folder',
        work: 'folder',
        reason:
          "this goal's work was made in the project folder itself, so it is already there: review the changes and commit them; there is no branch to land",
        files: status.map((e) => e.path).slice(0, MAX_FILES),
      },
      ...none,
      status,
    };
  }
  const tip = tipRef.stdout.trim();
  const headRef = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [1, 128] });
  const before = headRef.code === 0 ? headRef.stdout.trim() : null;
  const blocked = (reason: string, files: string[] = []): Inspection => ({
    plan: { ...base, state: 'blocked', reason, files: files.slice(0, MAX_FILES) },
    tip,
    before,
    touched: [],
    status: [],
  });
  if (!before) return blocked('the project folder has no commit yet: make a first commit, then land the goal');
  if (!into) {
    return blocked(
      'the project folder is not on a branch (a detached HEAD): check out your branch first, then land the goal',
    );
  }
  const landed = await runGit(root, ['merge-base', '--is-ancestor', tip, before], { okCodes: [1] });
  if (landed.code === 0) {
    return { plan: { ...base, state: 'landed' }, tip, before, touched: [], status: [] };
  }
  const ahead = await runGit(root, ['rev-list', '--count', `${before}..${tip}`], { okCodes: [128] });
  const commits = Number(ahead.stdout.trim()) || 0;
  const midway = await inProgress(root);
  if (midway) {
    return blocked(
      `the project folder is in the middle of ${midway}: finish it or abort it first; Friday does not touch it`,
    );
  }
  const status = await folderStatus(root);
  const staged = status.filter((e) => e.staged).map((e) => e.path);
  if (staged.length) {
    return blocked(
      'the project folder has staged changes that are not committed: commit them or unstage them first',
      staged,
    );
  }
  // The files the merge writes: what the goal changed since the two branches parted.
  const diff = await runGit(root, ['diff', '--name-only', '--no-renames', '-z', `${before}...${tip}`], {
    okCodes: [128],
  });
  const touched = diff.code === 0 ? diff.stdout.split('\0').filter(Boolean) : [];
  // A file the goal changes that is changed here too is in the way, unless the folder already
  // holds exactly what the goal has for it (2026-11-17): the work an agent did in this folder
  // reached the goal branch from here, and landing must not trip over its own source.
  const already: string[] = [];
  const inTheWay: string[] = [];
  for (const file of touched) {
    if (!status.some((e) => covers(e, file))) continue;
    if (await sameAsTip(root, tip, file)) already.push(file);
    else inTheWay.push(file);
  }
  if (inTheWay.length) {
    return blocked(
      'these files have changes that are not committed, and the goal changes them too: commit them or set them aside first',
      inTheWay,
    );
  }
  if (already.length) {
    // Git takes such files over only when the branch just moves forward to the goal.
    const forward = await runGit(root, ['merge-base', '--is-ancestor', before, tip], { okCodes: [1] });
    if (forward.code !== 0) {
      return blocked(
        `these files already hold the goal's work without being committed, and ${into} has commits the goal does not have: commit them first, then land the goal`,
        already,
      );
    }
  }
  return { plan: { ...base, commits }, tip, before, touched, status, already };
}

/** What Land would do for a goal now (`GET goals/:gid/land`); it changes nothing. */
export async function landPlan(state: FridayState, project: ProjectRef, goalId: string): Promise<LandPlan> {
  return (await inspect(state, project, goalId)).plan;
}

/**
 * Why git did not merge, for a person: the known outcomes in a plain sentence, git's own words
 * after it. `hooked`: the merge had started (MERGE_HEAD) and stopped without a conflict, which is
 * what a hook that refuses the merge commit looks like.
 */
function explain(text: string, branch: string, into: string, hooked: boolean): { kind: string; message: string } {
  const git = said(text);
  const tail = git ? ` Git said: ${git}` : '';
  const nothing = 'Nothing was changed.';
  if (/CONFLICT/.test(text)) {
    return {
      kind: 'conflict',
      message: `the goal's changes and ${into} change the same lines, so git cannot merge them by itself. ${nothing} Merge ${branch} yourself (VS Code shows the conflicts).${tail}`,
    };
  }
  if (/tell me who you are|unable to auto-detect email|empty ident name|no email was given/i.test(text)) {
    return {
      kind: 'identity',
      message: `git does not know your name and email yet, and a merge commit needs them. ${nothing} Set them once (git config --global user.name, and user.email), then land the goal again.${tail}`,
    };
  }
  if (/not possible to fast-forward/i.test(text)) {
    return {
      kind: 'ff_only',
      message: `this repository only takes fast-forward merges, and ${into} has commits the goal does not have. ${nothing} Merge or rebase ${branch} yourself.${tail}`,
    };
  }
  if (/unrelated histories/i.test(text)) {
    return {
      kind: 'unrelated',
      message: `${branch} and ${into} share no history, so git does not merge them. ${nothing}${tail}`,
    };
  }
  if (/unable to unlink|permission denied|index\.lock|cannot lock|resource busy|used by another process/i.test(text)) {
    return {
      kind: 'locked',
      message: `a file is open or locked by another program (an editor, a running app, another git command). ${nothing} Close it, then land the goal again.${tail}`,
    };
  }
  if (hooked) {
    return {
      kind: 'hook',
      message: `a commit hook of this repository refused the merge commit (a commit-message rule, for example). ${nothing} Merge ${branch} yourself, or change the hook.${tail}`,
    };
  }
  return { kind: 'git', message: `git did not merge ${branch} into ${into}. ${nothing}${tail}` };
}

/**
 * Puts the folder back after a merge that did not finish: aborts the merge this call started
 * (never another: `inspect` refused when one was in progress), then undoes what the attempt left
 * among the files it was writing: a file it created is removed, one it rewrote is restored from
 * HEAD. Anything it could not put back (a locked file) is returned by name.
 */
async function putBack(root: string, i: { touched: string[]; status: Entry[] }): Promise<string[]> {
  const midway = await runGit(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { okCodes: [1, 128] });
  if (midway.code === 0) await runGit(root, ['merge', '--abort'], { okCodes: [1, 128] });
  const was = new Set(i.status.map((e) => e.path));
  const left: string[] = [];
  for (const e of await folderStatus(root)) {
    if (was.has(e.path)) continue;
    const mine = i.touched.filter((f) => covers(e, f));
    if (!mine.length) continue;
    for (const file of mine) {
      try {
        if (e.untracked) rmSync(path.resolve(root, file), { force: true });
        else {
          await runGit(root, ['reset', '-q', 'HEAD', '--', file], { okCodes: [1, 128] });
          await runGit(root, ['checkout', 'HEAD', '--', file]);
        }
      } catch {
        left.push(file);
      }
    }
  }
  return left;
}

/** One landing at a time for a project: a second click, or a second window, waits its turn out. */
const landing = new Set<string>();

/**
 * Lands a completed goal (2026-11-16): merges `friday/goal-<id>` into the branch the main checkout
 * has checked out, as `git merge` in that folder would. A person asks for it (the desktop shows its
 * own confirmation first); Friday never does it by itself. It merges or it does nothing, and it
 * never touches a merge, rebase or staged change of the person's own: those, a detached HEAD and
 * files in the way are refused before git runs (`landPlan` says so beforehand), and a merge that
 * stops midway (a conflict, a hook, a locked file, the time limit) is taken back.
 */
export async function landGoal(
  state: FridayState,
  project: ProjectRef,
  goalId: string,
  actor: Actor,
  opts: { partial?: boolean } = {},
): Promise<LandResult> {
  const pid = project.project_id;
  if (landing.has(pid)) {
    throw new FridayError('invalid_state_transition', 'a goal is being landed in this project right now: wait for it');
  }
  landing.add(pid);
  try {
    const i = await inspect(state, project, goalId, opts.partial === true);
    const { plan } = i;
    const root = project.root;
    // A goal still worked on is not "landed" yet: the board learns that when its last work lands.
    const whole = state.q.findGoal(pid, goalId)?.status === 'COMPLETED';
    const record = (result: LandResult, before: string | null) => {
      if (whole) state.recordObservation(pid, actor, 'goal.landed', { ...result, before }, []);
    };
    if (plan.state === 'not_completed')
      throw new FridayError('invalid_state_transition', `goal ${goalId}: ${plan.reason}`);
    if (plan.state === 'in_folder' || plan.state === 'blocked') {
      throw new FridayError(
        'invalid_request',
        `${plan.reason}${plan.files.length ? `: ${plan.files.join(', ')}` : ''}`,
        {
          state: plan.state,
          files: plan.files,
        },
      );
    }
    const into = plan.into as string;
    const before = i.before as string;
    const tip = i.tip as string;
    if (plan.state === 'landed') {
      const result: LandResult = {
        goal_id: goalId,
        status: 'already',
        branch: plan.branch,
        into,
        head: before,
        fast_forward: false,
      };
      // Merged by hand, or landed before: the board learns it once.
      if (!landedGoals(state, pid).has(goalId)) record(result, before);
      return result;
    }

    const summary = (state.q.findGoal(pid, goalId)?.objective ?? state.q.findGoal(pid, goalId)?.request ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 72);
    // Files the folder already holds with the goal's content are told to git as such (staged as
    // they are), so the branch moves forward over them without rewriting or refusing them. If the
    // merge does not happen they are unstaged again: the folder is as it was.
    const already = i.already ?? [];
    const stage = async (args: string[]) => {
      for (let n = 0; n < already.length; n += 50) {
        await runGit(root, [...args, '--', ...already.slice(n, n + 50)], { okCodes: [1, 128] });
      }
    };
    await stage(['--literal-pathspecs', 'add', '-A']);
    let merge: { code: number; stdout: string; stderr: string };
    try {
      merge = await runGit(root, ['merge', '--no-edit', '-m', `Land goal ${goalId}: ${summary}`, plan.branch], {
        okCodes: [1, 2, 128],
        timeoutMs: MERGE_TIMEOUT_MS,
      });
    } catch (e) {
      // The time limit, or git itself could not run: whatever the attempt left is taken back.
      await stage(['--literal-pathspecs', 'reset', '-q']);
      const left = await putBack(root, i);
      const why = e instanceof Error ? e.message : String(e);
      throw new FridayError(
        'invalid_request',
        `the merge did not finish (${said(why)}); it was stopped and the folder put back${left.length ? `, except: ${left.join(', ')}` : ''}`,
        { branch: plan.branch, into, kind: 'stopped', left },
      );
    }
    if (merge.code !== 0) {
      const hooked =
        (await runGit(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { okCodes: [1, 128] })).code === 0;
      const text = `${merge.stdout}\n${merge.stderr}`;
      await stage(['--literal-pathspecs', 'reset', '-q']);
      const left = await putBack(root, i);
      const { kind, message } = explain(text, plan.branch, into, hooked && !/CONFLICT/.test(text));
      throw new FridayError(
        'invalid_request',
        left.length ? `${message} These files could not be put back, check them: ${left.join(', ')}` : message,
        { branch: plan.branch, into, kind, conflict: kind === 'conflict', left },
      );
    }
    const head = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const result: LandResult = {
      goal_id: goalId,
      // HEAD that did not move: git found nothing to bring.
      status: head === before ? 'already' : 'landed',
      branch: plan.branch,
      into,
      head,
      fast_forward: head === tip,
    };
    // An observation refers to agents, harnesses, tasks and runs; the goal is named in the payload.
    record(result, before);
    return result;
  } finally {
    landing.delete(pid);
  }
}

/** A recorded landing, as the board shows it. */
export interface Landing {
  into: string;
  head: string;
  at: string;
}

/** The goals a person landed, by id, with the latest landing of each (`goal.landed`). */
export function landedGoals(state: FridayState, projectId: string): Map<string, Landing> {
  const out = new Map<string, Landing>();
  for (const e of state.store.readSince(projectId, 0, { types: ['goal.landed'], limit: 2000 })) {
    const p = e.payload as { goal_id?: unknown; into?: unknown; head?: unknown };
    if (typeof p.goal_id !== 'string' || typeof p.into !== 'string') continue;
    out.set(p.goal_id, { into: p.into, head: typeof p.head === 'string' ? p.head : '', at: e.occurred_at });
  }
  return out;
}
