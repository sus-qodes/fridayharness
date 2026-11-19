/**
 * A clean install, checked when the files that list the project's packages changed (2026-11-18).
 *
 * The project's checks run in the folder the agent worked in, where its packages are already
 * installed. In the trial an agent left a `package-lock.json` that `npm ci` refuses ("Missing:
 * @emnapi/core@1.11.2 from lock file"): lint, the types, the tests and the build all passed there,
 * the goal landed, and from then on every new task folder failed its install in two seconds. The
 * project's own pipeline, which installs with `npm ci`, would have failed on that branch too.
 *
 * So when a task changes a `package.json` or an npm lockfile, Friday asks npm whether a clean
 * install would work, without installing anything: `npm ci --dry-run --ignore-scripts` reads the
 * lockfile and the manifests, refuses when they disagree, and leaves `node_modules` as it is. A
 * lockfile npm refuses fails the verification, with npm's own words and what to do. When npm
 * cannot say (it did not start, ran out of time, or failed for another reason) the work is not
 * failed for it: that is said as a warning.
 *
 * Only npm for now: pnpm, Yarn and Bun have no install that only checks, and are left to the
 * project's own checks.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

const MANIFESTS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);
const NPM_LOCKS = ['npm-shrinkwrap.json', 'package-lock.json'];
/** A change that touches more lockfiles than this is checked for the first ones only. */
const MAX_ROOTS = 3;

export const CLEAN_INSTALL_COMMAND = 'npm';
export const CLEAN_INSTALL_ARGS: readonly string[] = [
  'ci',
  '--dry-run',
  '--ignore-scripts',
  '--prefer-offline',
  '--no-audit',
  '--no-fund',
];
export const CLEAN_INSTALL_TIMEOUT_MS = 120_000;

export interface LockRoot {
  /** The folder the lockfile is in, relative to the checkout (`''`: the checkout itself). */
  dir: string;
  lockfile: string;
}

/**
 * The npm lockfiles that govern the changed manifests and lockfiles: for each, the nearest folder
 * at or above it that has one (a workspace's `package.json` is locked by the root's file).
 */
export function lockRoots(
  root: string,
  changed: readonly string[],
  exists: (file: string) => boolean = existsSync,
): LockRoot[] {
  const out = new Map<string, string>();
  for (const p of changed) {
    const parts = p.replaceAll('\\', '/').split('/');
    const base = parts.pop() ?? '';
    if (!MANIFESTS.has(base) || parts.includes('node_modules')) continue;
    for (let n = parts.length; n >= 0; n -= 1) {
      const dir = parts.slice(0, n).join('/');
      const lock = NPM_LOCKS.find((l) => exists(path.join(root, dir, l)));
      if (!lock) continue;
      if (!out.has(dir)) out.set(dir, lock);
      break;
    }
  }
  return [...out].slice(0, MAX_ROOTS).map(([dir, lockfile]) => ({ dir, lockfile }));
}

/** What npm prints when the lockfile and the manifests disagree. */
const OUT_OF_STEP =
  /can only install (?:packages )?when your package\.json and [\w.-]+(?: or [\w.-]+)? are in sync|Missing: .+ from lock file|Invalid: lock file's .+ does not satisfy/i;

export interface CleanInstallVerdict {
  /** `ok`: a clean install works; `out_of_step`: npm refuses the lockfile; `unknown`: npm could not say. */
  verdict: 'ok' | 'out_of_step' | 'unknown';
  summary: string;
}

/** What npm's answer means for the work. */
export function judgeCleanInstall(
  o: { passed: boolean; output: string; timed_out: boolean; spawn_error?: string | null; exit_code: number | null },
  at: LockRoot,
): CleanInstallVerdict {
  const where = at.dir ? `${at.dir}/${at.lockfile}` : at.lockfile;
  if (o.passed) return { verdict: 'ok', summary: `a clean install (npm ci) works with ${where}` };
  if (!o.timed_out && !o.spawn_error && OUT_OF_STEP.test(o.output)) {
    const said = o.output
      .split('\n')
      .map((l) => l.replace(/^npm (?:error|ERR!)\s*/i, '').trim())
      .filter((l) => /^(?:Missing|Invalid): /i.test(l))
      .slice(0, 4);
    return {
      verdict: 'out_of_step',
      summary: `${where} does not match package.json, so a clean install (npm ci) fails${said.length ? `: ${said.join('; ')}` : ''}. Run "npm install" in ${at.dir || 'the project folder'} so the lockfile is written again, and keep the rewritten ${at.lockfile} in the work`,
    };
  }
  const why = o.spawn_error
    ? `npm could not start: ${o.spawn_error}`
    : o.timed_out
      ? `npm did not answer within ${Math.round(CLEAN_INSTALL_TIMEOUT_MS / 1000)} s`
      : `npm exited with ${o.exit_code ?? 'an unknown status'}`;
  return {
    verdict: 'unknown',
    summary: `could not tell whether a clean install works with ${where} (${why}); the work is not failed for it`,
  };
}
