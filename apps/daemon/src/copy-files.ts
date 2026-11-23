import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { runGit } from '@friday/git';
import type { Logger } from './log.js';

/**
 * Files from outside version control in a copy of the project (2026-11-17). A task's worktree, and
 * Friday's checkout of a merged revision, are made from version control: a settings file the
 * project ignores (`.env`) is not in them, and a project whose tests read it fails every check
 * there, in the agent's hands and in Friday's, though the work is right. The files the project
 * lists under `worktrees.files`, and this clone trusted, are copied in before anything runs.
 *
 * What is never done: a file from outside the project is not read; a tracked file of the copy is
 * not written over; a file the copy's ignore rules do not cover is not written, since `git add`
 * would then take it into a commit, and from there into the project's history; nothing of a file's
 * content is logged or recorded, only its name and what happened.
 */

export interface FileToCopy {
  /** The file in the project folder. */
  from: string;
  /** Its name in the copy. */
  to: string;
}

export interface CopiedFileOutcome extends FileToCopy {
  /** `copied`: written; `same`: already there with these bytes; `missing`: not in the project folder; `refused`: see `reason`. */
  status: 'copied' | 'same' | 'missing' | 'refused';
  reason: string;
}

/** A settings file is small; anything larger is not one, and is not copied into every worktree. */
export const MAX_COPIED_BYTES = 1024 * 1024;

const WIN = process.platform === 'win32';
const same = (a: string, b: string) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The real location of the deepest part of `p` that exists, with the rest appended: where a write would land. */
function landing(p: string): string {
  let at = p;
  const rest: string[] = [];
  while (!existsSync(at)) {
    const up = path.dirname(at);
    if (up === at) return p;
    rest.unshift(path.basename(at));
    at = up;
  }
  return path.join(realpathSync(at), ...rest);
}

async function copyOne(projectRoot: string, dir: string, file: FileToCopy): Promise<CopiedFileOutcome> {
  const refused = (reason: string): CopiedFileOutcome => ({ ...file, status: 'refused', reason });
  const source = path.resolve(projectRoot, file.from);
  if (!inside(source, projectRoot)) return refused(`${file.from} is not inside the project folder`);
  if (!existsSync(source)) {
    return { ...file, status: 'missing', reason: `${file.from} is not in the project folder` };
  }
  // Through links: what is read must itself be in the project folder.
  if (!inside(realpathSync(source), realpathSync(projectRoot))) {
    return refused(`${file.from} leads outside the project folder`);
  }
  const info = lstatSync(realpathSync(source));
  if (!info.isFile()) return refused(`${file.from} is not a file`);
  if (info.size > MAX_COPIED_BYTES) {
    return refused(`${file.from} is larger than ${MAX_COPIED_BYTES / 1024} KB, which a settings file is not`);
  }

  const target = path.resolve(dir, file.to);
  if (!inside(target, dir) || !inside(landing(target), realpathSync(dir))) {
    return refused(`${file.to} would be written outside the copy`);
  }
  const rel = path.relative(dir, target).split(path.sep).join('/');
  const tracked = await runGit(dir, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', rel], {
    okCodes: [1],
  });
  if (tracked.code === 0) {
    return refused(`${file.to} is a file of the project there, and is not written over`);
  }
  const ignored = await runGit(dir, ['check-ignore', '-q', '--', rel], { okCodes: [1] });
  if (ignored.code !== 0) {
    return refused(
      `the project's ignore rules do not cover ${file.to}, so a commit could take it; add it to .gitignore first`,
    );
  }
  if (existsSync(target)) {
    const there = lstatSync(target);
    if (!there.isFile()) return refused(`${file.to} is there as something that is not a file`);
    if (readFileSync(target).equals(readFileSync(source))) return { ...file, status: 'same', reason: 'ok' };
  }
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  return { ...file, status: 'copied', reason: 'ok' };
}

/**
 * Copies each file into `dir`, a copy of the project at `projectRoot`. Nothing when `dir` is the
 * project folder itself (worktrees off): the files are there already. One file that cannot be
 * given does not keep the others out.
 */
export async function copyFilesInto(
  projectRoot: string,
  dir: string,
  files: readonly FileToCopy[],
): Promise<CopiedFileOutcome[]> {
  if (!files.length || !existsSync(dir)) return [];
  if (same(realpathSync(dir), realpathSync(projectRoot))) return [];
  const out: CopiedFileOutcome[] = [];
  for (const file of files) {
    try {
      out.push(await copyOne(projectRoot, dir, file));
    } catch (e) {
      out.push({ ...file, status: 'refused', reason: (e as Error).message });
    }
  }
  return out;
}

/** What to tell an agent, or say beside a failing check, about files its copy did not get; null when all are there. */
export function copiedFilesProblem(outcomes: readonly CopiedFileOutcome[]): string | null {
  const bad = outcomes.filter((o) => o.status === 'missing' || o.status === 'refused');
  if (!bad.length) return null;
  return bad.map((o) => (o.status === 'missing' ? o.reason : `${o.to} was not given: ${o.reason}`)).join('; ');
}

/** Gives a copy its files; answers what its agent, or a failing check's report, should know, or null. */
export type FileCopier = (dir: string, ids: Record<string, string>) => Promise<string | null>;

const named = (f: FileToCopy) => (f.to === f.from ? f.from : `${f.from} as ${f.to}`);

/**
 * The copier of one project: the files this clone trusted go into `dir`; what could not be given,
 * and what waits for the person's trust, is said in words an agent can act on (it must not take a
 * check that fails for a missing settings file as a fault of its work).
 */
export function fileCopier(deps: {
  root: string;
  policy: () => { worktree_files: readonly FileToCopy[]; worktree_files_held: readonly FileToCopy[] };
  logger: Logger;
}): FileCopier {
  return async (dir, ids) => {
    const policy = deps.policy();
    const outcomes = await copyFilesInto(deps.root, dir, policy.worktree_files);
    for (const o of outcomes) {
      const fields = { ...ids, from: o.from, to: o.to, status: o.status, reason: o.reason };
      if (o.status === 'copied' || o.status === 'same') deps.logger.info('file given to a copy of the project', fields);
      else deps.logger.warn('file not given to a copy of the project', fields);
    }
    const problem = copiedFilesProblem(outcomes);
    const held = policy.worktree_files_held;
    const parts = [
      problem
        ? `This copy of the project did not get every file the project lists for its copies (worktrees.files): ${problem}.`
        : null,
      held.length
        ? `The project lists files for its copies (${held.map(named).join(', ')}) that wait for the person's approval in Friday, so this copy does not have them.`
        : null,
    ].filter(Boolean);
    if (!parts.length) return null;
    return `${parts.join(' ')} A check or a program that reads such a file may fail for that reason, and not because of the work; say so in your report instead of working around it.`;
  };
}

/** A settings file by its name: `.env`, `.env.local`, `.env.agents.local`; not a committed template. */
const SETTINGS_FILE = /^\.env(\.[A-Za-z0-9_.-]+)?$/;
const TEMPLATE = /^\.env\.(example|sample|template|dist)$/i;
/** Folders no settings file of the project's own is looked for in. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'vendor']);
const FOUND_MAX = 30;
const VISITED_MAX = 4000;

/**
 * The settings files in the project folder that version control ignores, by their paths from it:
 * what a person is offered to give the copies. Three folders deep, never inside installed
 * packages, build output or a dot folder; names only, nothing of a file is read.
 */
export async function findSettingsFiles(root: string): Promise<string[]> {
  const named: string[] = [];
  let visited = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited += 1;
      if (visited > VISITED_MAX || named.length >= FOUND_MAX) return;
      const at = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && SETTINGS_FILE.test(e.name) && !TEMPLATE.test(e.name)) named.push(at);
      else if (e.isDirectory() && depth < 3 && !e.name.startsWith('.') && !SKIPPED.has(e.name)) {
        walk(path.join(dir, e.name), at, depth + 1);
      }
    }
  };
  walk(root, '', 0);
  if (!named.length) return [];
  // Only what git ignores: a tracked file is in every copy already.
  const ignored = await runGit(root, ['check-ignore', '--stdin'], {
    input: `${named.join('\n')}\n`,
    okCodes: [1, 128],
  });
  const kept = new Set(ignored.stdout.split(/\r?\n/).filter(Boolean));
  return named.filter((n) => kept.has(n)).sort();
}
