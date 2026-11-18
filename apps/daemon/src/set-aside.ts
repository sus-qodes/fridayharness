/**
 * Files in the way of a landing, set aside (2026-11-18).
 *
 * A goal could not land while the project folder held uncommitted changes to files the goal
 * changes too, and all Friday said was "commit them or set them aside first". In the trial that
 * happened to a person who had changed nothing: an agent they ran in their editor had worked on
 * the goal in the folder, ran out of quota, and the task was finished elsewhere. Its thirty-two
 * half-done files stayed in the folder and stopped the landing, with nothing in the app to do
 * about it.
 *
 * So the landing can take them out of the way itself, when its person says so:
 *  - their content, exactly as it is, is kept as a commit under `refs/friday/set-aside/<goal>/`
 *    (a ref of Friday's own: no branch, no stash of the person's is touched);
 *  - the folder's copies go back to the last commit (a file that is new is removed);
 *  - if the landing then does not happen, every one of them is written back and the ref removed,
 *    so "nothing was changed" stays true;
 *  - after a landing, "Put them back" writes them over the landed files that were not changed
 *    since, and says which ones it left alone.
 *
 * It also says whose they are, as far as the records know: files an agent's ended attempt at one
 * of the goal's tasks covered are what that attempt left; files an agent is working on in the
 * folder right now are never taken from under it.
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { commitTree, GitRoot, preserveCommit, runGit } from '@friday/git';
import { matchesAny } from '@friday/policy';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';

export const SET_ASIDE_PREFIX = 'refs/friday/set-aside/';
/** How many file names an event and a plan carry; the commit holds all of them. */
const LISTED = 200;
const BATCH = 50;
const ACTIVE = new Set(['ASSIGNED', 'RUNNING', 'WAITING', 'HARNESS_LOST']);

/** What a blocked plan says about uncommitted files the goal changes too. */
export interface InTheWay {
  /** All of them (the plan's `files` lists fifty at most). */
  count: number;
  /** How many of them an agent's ended attempt at this goal left in the folder, and whose. */
  left: number;
  left_by: string[];
  /** Agents working on some of them in the folder right now: they are not set aside meanwhile. */
  working: string[];
}

/** Files set aside at a landing of a goal and not put back since. */
export interface SetAside {
  ref: string;
  commit: string;
  count: number;
  files: string[];
  into: string | null;
  at: string;
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

/** A recorded path as the folder's status names it: relative to the root, with forward slashes. */
function relative(root: string, p: string): string {
  const rel = path.isAbsolute(p) ? path.relative(root, p) : p;
  return rel.split(path.sep).join('/').replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * Whose the files in the way are. A run without a branch that worked in the project folder is a
 * session its person runs there (or worktrees are off): what it observed, and what its task may
 * write, is what it covers.
 */
export function whoseFiles(
  state: FridayState,
  project: ProjectRef,
  goalId: string,
  files: readonly string[],
): Pick<InTheWay, 'left' | 'left_by' | 'working'> {
  const pid = project.project_id;
  const left = new Set<string>();
  const leftBy = new Set<string>();
  const working = new Set<string>();
  const inFolder = (root: string | null, branch: string | null) =>
    Boolean(root) && !branch && sameDir(root as string, project.root);
  const covered = (scope: readonly string[], observed: readonly string[]) => {
    const seen = new Set(observed.map((p) => relative(project.root, p)));
    return files.filter((f) => seen.has(f) || matchesAny(f, scope));
  };
  for (const t of state.q.goalTasks(pid, goalId)) {
    for (const run of state.q.runs(t.task_id)) {
      if (!run.ended_at || !inFolder(run.execution_root, run.branch_ref)) continue;
      const mine = covered(t.scope?.write ?? [], run.observed_paths ?? []);
      if (!mine.length) continue;
      for (const f of mine) left.add(f);
      leftBy.add(state.q.findAgent(run.agent_id)?.agent_key ?? 'an agent');
    }
  }
  // Any goal's task: a file an agent is editing in this folder now is its work in progress.
  for (const t of state.q.tasks(pid, { statuses: [...ACTIVE] as never })) {
    const run = t.current_run_id ? state.q.findRun(t.current_run_id) : undefined;
    if (!run || run.ended_at || !inFolder(run.execution_root, run.branch_ref)) continue;
    if (covered(t.scope?.write ?? [], run.observed_paths ?? []).length) {
      working.add(state.q.findAgent(run.agent_id)?.agent_key ?? 'an agent');
    }
  }
  return { left: left.size, left_by: [...leftBy].sort(), working: [...working].sort() };
}

/** The set-asides of a goal that still hold files not put back, oldest first. */
export function setAsides(state: FridayState, projectId: string, goalId: string): SetAside[] {
  const out = new Map<string, SetAside>();
  const events = state.store.readSince(projectId, 0, {
    types: ['goal.files_set_aside', 'goal.set_aside_restored'],
    limit: 2000,
  });
  for (const e of events) {
    const p = e.payload as {
      goal_id?: unknown;
      ref?: unknown;
      commit?: unknown;
      count?: unknown;
      files?: unknown;
      into?: unknown;
      left?: unknown;
    };
    if (p.goal_id !== goalId || typeof p.ref !== 'string') continue;
    if (e.type === 'goal.files_set_aside') {
      if (typeof p.commit !== 'string') continue;
      const files = Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === 'string') : [];
      out.set(p.ref, {
        ref: p.ref,
        commit: p.commit,
        count: typeof p.count === 'number' ? p.count : files.length,
        files,
        into: typeof p.into === 'string' ? p.into : null,
        at: e.occurred_at,
      });
      continue;
    }
    // Put back: gone from the list, unless some were left alone (they are what it still holds).
    const still = Array.isArray(p.left) ? p.left.filter((f): f is string => typeof f === 'string') : [];
    const was = out.get(p.ref);
    if (!was) continue;
    if (still.length) out.set(p.ref, { ...was, count: still.length, files: still.slice(0, LISTED) });
    else out.delete(p.ref);
  }
  return [...out.values()];
}

/** What was taken out of the way: the commit that holds it, and under which ref. */
export interface Taken {
  ref: string;
  commit: string;
  files: string[];
}

/** The files a set-aside commit holds, and whether each is there (false: the folder had deleted it). */
async function heldFiles(root: string, commit: string): Promise<{ file: string; present: boolean }[]> {
  const out = await runGit(root, ['diff', '--name-status', '--no-renames', '-z', `${commit}^`, commit]);
  const parts = out.stdout.split('\0');
  const files: { file: string; present: boolean }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i] ?? '';
    const file = parts[i + 1] ?? '';
    if (file) files.push({ file, present: !status.startsWith('D') });
  }
  return files;
}

/**
 * Takes `files` out of the way: keeps their content as a commit on top of `head`, then puts the
 * folder's copies back to `head`. All of them or none: when one cannot be put back (open in
 * another program), the ones already done are written back and it throws.
 */
export async function takeAside(root: string, goalId: string, files: readonly string[], head: string): Promise<Taken> {
  const git = await GitRoot.open(root);
  const tree = await git.pathsTree(head, files);
  const commit = await commitTree(
    root,
    tree,
    [head],
    `Files set aside before landing goal ${goalId}\n\nUncommitted in the project folder, and changed by the goal too: kept here exactly as they were.`,
  );
  const held = await heldFiles(root, commit);
  // Nothing is touched unless the commit holds, for every file, exactly what the folder has.
  const unkept: string[] = [];
  for (const f of files) if (!(await holds(root, commit, f))) unkept.push(f);
  if (unkept.length) throw new Error(`could not keep an exact copy of: ${unkept.slice(0, 5).join(', ')}`);
  const ref = await preserveCommit(root, `${SET_ASIDE_PREFIX}${goalId}/`, 'landing', commit);
  const tracked = new Set(
    (
      await Promise.all(
        chunks(files).map((c) =>
          runGit(root, ['--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', head, '--', ...c]),
        ),
      )
    ).flatMap((r) => r.stdout.split('\0').filter(Boolean)),
  );
  try {
    for (const c of chunks(files.filter((f) => tracked.has(f)))) {
      await runGit(root, ['--literal-pathspecs', 'checkout', head, '--', ...c], { timeoutMs: 300_000 });
    }
    for (const f of files) if (!tracked.has(f)) rmSync(path.resolve(root, f), { force: true });
  } catch (e) {
    await bringBack(root, commit, { onlyUnchanged: false });
    await runGit(root, ['update-ref', '-d', ref], { okCodes: [1, 128] });
    throw e;
  }
  return { ref, commit, files: held.map((h) => h.file) };
}

/**
 * Whether `commit` has for `file` what the folder has, as git would store it (both absent counts):
 * `git hash-object` applies the filters `git add` does.
 */
async function holds(root: string, commit: string, file: string): Promise<boolean> {
  const kept = await runGit(root, ['rev-parse', '--verify', '--quiet', `${commit}:${file}`], { okCodes: [1, 128] });
  const here = existsSync(path.resolve(root, file));
  if (kept.code !== 0) return !here;
  if (!here) return false;
  const mine = await runGit(root, ['hash-object', '--', file], { okCodes: [1, 128] });
  return mine.code === 0 && mine.stdout.trim() === kept.stdout.trim();
}

function chunks<T>(list: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The folder's files that differ from the last commit, as its status names them. */
async function changedNow(root: string): Promise<Set<string>> {
  const out = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { okCodes: [128] });
  const changed = new Set<string>();
  const parts = out.stdout.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i] ?? '';
    if (p.length < 4) continue;
    if (p[0] === 'R' || p[0] === 'C' || p[1] === 'R' || p[1] === 'C') i += 1;
    changed.add(p.slice(3));
  }
  return changed;
}

/**
 * Writes the files a set-aside commit holds back into the folder, without staging them.
 * `onlyUnchanged`: a file that differs from the last commit now (the person, or an agent, changed
 * it since) is left alone and named in `skipped`. `failed`: could not be written (open elsewhere).
 */
export async function bringBack(
  root: string,
  commit: string,
  opts: { onlyUnchanged: boolean },
): Promise<{ restored: string[]; skipped: string[]; failed: string[] }> {
  const held = await heldFiles(root, commit);
  const changed = opts.onlyUnchanged ? await changedNow(root) : new Set<string>();
  const restored: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const { file, present } of held) {
    if (changed.has(file)) {
      // Changed since, unless what is there is the kept copy itself (put back before).
      if (await holds(root, commit, file)) restored.push(file);
      else skipped.push(file);
      continue;
    }
    try {
      if (present) {
        await runGit(root, ['--literal-pathspecs', 'restore', `--source=${commit}`, '--worktree', '--', file]);
      } else if (existsSync(path.resolve(root, file))) {
        rmSync(path.resolve(root, file), { force: true });
      }
      restored.push(file);
    } catch {
      failed.push(file);
    }
  }
  return { restored, skipped, failed };
}

/** The names an event carries of a longer list. */
export function listed(files: readonly string[]): string[] {
  return files.slice(0, LISTED);
}
