/**
 * `friday git-start` (2026-11-19, the fix list's G2): a folder that is not under git gets a way
 * forward from the app instead of "make it one first, then start again: git init".
 *
 * Friday works without a commit only in a degraded way: no task gets a copy of its own, and nothing
 * an agent does can be undone by git. Here Friday starts git in the project folder when it is not
 * in one, and saves the files as they are as the first version:
 * - a `.gitignore` listing what tools make (node_modules, dist, build…) is written only when the
 *   folder has none;
 * - files that hold secrets (`.env`, keys) are never saved, whatever `.gitignore` says: they are
 *   listed in git's own local exclude file, so they stay on disk and out of git;
 * - a folder far too big to be the project's own files (generated folders not ignored) is refused
 *   before anything changes, with its biggest folders named;
 * - when git does not know the person's name, the first version is saved under the computer's user
 *   and name, as git itself would do, for this project only, and that is said;
 * - when anything fails, what Friday made (the repository, its `.gitignore`) is taken away again.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_GITIGNORE = [
  '# Written by Friday when it started git here: what tools make, not what people write.',
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.cache/',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  '# Settings with keys and passwords stay on this computer.',
  '.env',
  '.env.*',
  '!.env.example',
  '',
].join('\n');

/** The first version's words. */
export const FIRST_VERSION = 'The project as it was when Friday was set up';

/** Files with keys and passwords: never saved. Templates that only document them are. */
const SECRET = [/(^|\/)\.env(\.[^/]*)?$/i, /\.pem$/i, /(^|\/)id_(rsa|ed25519)(\.[^/]*)?$/i];
const TEMPLATE = /(^|\/)\.env\.(example|sample|template)$/i;
export const isSecretFile = (p: string) => !TEMPLATE.test(p) && SECRET.some((r) => r.test(p));

/** More than this is not a project's own files: generated folders are in it. */
export const LIMITS = { files: 20_000, bytes: 500 * 1024 * 1024 };

export interface GitStart {
  /** `started`: git was started and the first version saved; `saved`: git was there without a commit. */
  status: 'started' | 'saved' | 'already' | 'no_git' | 'too_big' | 'inside_another' | 'failed';
  files: number;
  bytes: number;
  /** Left out: they hold secrets. */
  secrets: string[];
  /** Friday wrote the `.gitignore` (the folder had none). */
  ignore_written: boolean;
  /** The name the first version was saved under, when git knew none and Friday set it here. */
  identity: { name: string; email: string } | null;
  /** The biggest folders, when it was too big. */
  big: { path: string; bytes: number }[];
  message: string;
}

const git = (root: string, args: string[], input?: string) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
  });

const tryGit = (root: string, args: string[]): string | null => {
  try {
    return git(root, args);
  } catch {
    return null;
  }
};

const said = (e: unknown) => {
  const err = e as { stderr?: string; message?: string };
  return (
    String(err.stderr ?? '')
      .trim()
      .split(/\r?\n/)
      .find(Boolean) ??
    err.message ??
    String(e)
  ).slice(0, 300);
};

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function startGit(root: string, limits = LIMITS): GitStart {
  const base: GitStart = {
    status: 'failed',
    files: 0,
    bytes: 0,
    secrets: [],
    ignore_written: false,
    identity: null,
    big: [],
    message: '',
  };
  if (tryGit(root, ['--version']) === null) {
    return {
      ...base,
      status: 'no_git',
      message: 'Git is not installed on this computer. Install Git for Windows (git-scm.com), then try again.',
    };
  }
  const top = tryGit(root, ['rev-parse', '--show-toplevel'])?.trim() ?? null;
  if (top && !same(top, root)) {
    return {
      ...base,
      status: 'inside_another',
      message: `This folder is inside another git project, ${top}: open that folder instead.`,
    };
  }
  if (top && tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== null) {
    return { ...base, status: 'already', message: 'This folder already has a saved version in git.' };
  }
  const created = !top;
  const ignoreFile = path.join(root, '.gitignore');
  const undo = () => {
    if (created) rmSync(path.join(root, '.git'), { recursive: true, force: true });
    if (base.ignore_written) rmSync(ignoreFile, { force: true });
  };
  try {
    if (created) git(root, ['init', '-q']);
    if (!existsSync(ignoreFile)) {
      writeFileSync(ignoreFile, DEFAULT_GITIGNORE);
      base.ignore_written = true;
    }
    // What `git add -A` would save: untracked files git does not ignore, and any already staged.
    const listed = [
      ...git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0'),
      ...git(root, ['ls-files', '-z', '--cached']).split('\0'),
    ].filter(Boolean);
    const files = [...new Set(listed.map((f) => f.replaceAll('\\', '/')))];
    const secrets = files.filter(isSecretFile);
    const kept = files.filter((f) => !isSecretFile(f));
    let bytes = 0;
    const byFolder = new Map<string, number>();
    for (const f of kept) {
      let size = 0;
      try {
        size = statSync(path.join(root, f)).size;
      } catch {
        // gone meanwhile
      }
      bytes += size;
      const first = f.includes('/') ? `${f.split('/')[0]}/` : f;
      byFolder.set(first, (byFolder.get(first) ?? 0) + size);
    }
    if (kept.length > limits.files || bytes > limits.bytes) {
      undo();
      return {
        ...base,
        ignore_written: false,
        status: 'too_big',
        files: kept.length,
        bytes,
        big: [...byFolder.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([p, b]) => ({ path: p, bytes: b })),
        message: `${kept.length} files, ${Math.round(bytes / 1024 / 1024)} MB: that is more than a project's own files, so folders that tools make are in it. Add them to .gitignore, then try again. Nothing was changed.`,
      };
    }
    // Secrets stay on disk and out of git: git's own exclude file, which is never shared.
    if (secrets.length) {
      const exclude = path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']).trim());
      appendFileSync(
        exclude,
        `\n# Left out by Friday: they hold secrets.\n${secrets.map((s) => `/${s.replace(/([*?[\]!#])/g, '\\$1')}`).join('\n')}\n`,
      );
      for (const s of secrets) tryGit(root, ['rm', '--cached', '-q', '--', s]);
    }
    // A name for the first version when git knows none: the computer's user, as git itself would.
    let identity: GitStart['identity'] = null;
    const name = tryGit(root, ['config', 'user.name'])?.trim();
    const email = tryGit(root, ['config', 'user.email'])?.trim();
    if (!name || !email) {
      const user = os.userInfo().username || 'friday-user';
      const host =
        os
          .hostname()
          .toLowerCase()
          .replace(/[^a-z0-9.-]/g, '-') || 'localhost';
      identity = { name: name || user, email: email || `${user.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}@${host}` };
      git(root, ['config', 'user.name', identity.name]);
      git(root, ['config', 'user.email', identity.email]);
    }
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '--allow-empty', '-m', FIRST_VERSION]);
    return {
      ...base,
      status: created ? 'started' : 'saved',
      files: kept.length,
      bytes,
      secrets,
      identity,
      message: `${kept.length} ${kept.length === 1 ? 'file' : 'files'} saved as the first version.`,
    };
  } catch (e) {
    undo();
    return {
      ...base,
      ignore_written: false,
      message: `Git could not save the first version: ${said(e)}. Nothing was changed.`,
    };
  }
}
