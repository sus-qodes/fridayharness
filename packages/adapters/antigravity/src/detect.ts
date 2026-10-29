/**
 * Finding Antigravity on this machine (plan M8b.3): the CLI `agy` and the desktop App. Both run the
 * same agent and read the same `.agents/` files, so either one is enough for attach mode. Reading
 * a version runs `agy --version` and nothing else: no conversation, no sign-in, no model call.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The host version Friday's Antigravity files were written from (its documentation, 2026-10-18). */
export const DOCUMENTED_VERSION = '1.4';

/**
 * The oldest CLI whose hooks Friday's files suit: workspace hooks load after a folder is trusted
 * from 1.1.1, and an answer without a decision is read without an error from 1.0.16.
 */
export const HOOKS_MIN = '1.1.1';

/** Hook and settings files with a byte-order mark load from this CLI version on. */
export const BOM_SAFE = '1.3.1';

export interface AntigravityInstall {
  kind: 'cli' | 'app';
  /** The executable found. */
  binary: string;
  /** Its version, or null when it could not be read (never guessed). */
  version: string | null;
  source: 'AGY_BIN' | 'PATH' | 'per-user' | 'per-machine';
}

export interface AntigravityFound {
  cli: AntigravityInstall | null;
  app: AntigravityInstall | null;
  /** Every place looked at, in order. */
  checked: string[];
  /** A command shim found where the executable was expected, which Friday does not run. */
  shim: string | null;
}

/** Reads a version from `agy --version`: the first `x.y.z` it prints, or null. */
export function agyVersion(binary: string): string | null {
  try {
    const out = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 15_000,
    });
    return parseVersion(out);
  } catch {
    return null;
  }
}

export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

/** The App's version from its bundled `package.json`, when the App keeps one there; null otherwise. */
function appVersion(exe: string): string | null {
  for (const rel of [
    ['resources', 'app', 'package.json'],
    ['resources', 'app', 'product.json'],
  ]) {
    try {
      const v = JSON.parse(readFileSync(path.join(path.dirname(exe), ...rel), 'utf8')).version;
      if (typeof v === 'string') return parseVersion(v);
    } catch {
      // not there, or not readable
    }
  }
  return null;
}

/**
 * Looks for the CLI in `AGY_BIN`, then `PATH`, then its per-user install folder
 * (`%LOCALAPPDATA%\agy\bin`), then the per-machine folder one vendor page names; and for the App in
 * the per-user and per-machine program folders (where the App installs is not documented). A
 * `.cmd` shim is not run: it needs a shell. `readVersion` is replaced in tests.
 */
export function findAntigravity(
  env: NodeJS.ProcessEnv = process.env,
  readVersion: (binary: string) => string | null = agyVersion,
): AntigravityFound {
  const win = process.platform === 'win32';
  const checked: string[] = [];
  let shim: string | null = null;
  const exe = win ? 'agy.exe' : 'agy';

  const cliCandidates: Array<[string, AntigravityInstall['source']]> = [];
  if (env.AGY_BIN) cliCandidates.push([env.AGY_BIN, 'AGY_BIN']);
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean))
    cliCandidates.push([path.join(dir, exe), 'PATH']);
  if (win) {
    const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    cliCandidates.push([path.join(local, 'agy', 'bin', exe), 'per-user']);
    if (env.ProgramFiles ?? env.PROGRAMFILES)
      cliCandidates.push([
        path.join((env.ProgramFiles ?? env.PROGRAMFILES) as string, 'Google', 'antigravity-cli', exe),
        'per-machine',
      ]);
  }
  let cli: AntigravityInstall | null = null;
  for (const [binary, source] of cliCandidates) {
    checked.push(binary);
    if (!existsSync(binary)) {
      const cmd = binary.replace(/\.exe$/i, '.cmd');
      if (win && !shim && cmd !== binary && existsSync(cmd)) shim = cmd;
      continue;
    }
    cli = { kind: 'cli', binary, version: readVersion(binary), source };
    break;
  }

  const appCandidates: Array<[string, AntigravityInstall['source']]> = [];
  if (win) {
    const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    appCandidates.push([path.join(local, 'Programs', 'Antigravity', 'Antigravity.exe'), 'per-user']);
    const pf = env.ProgramFiles ?? env.PROGRAMFILES;
    if (pf) appCandidates.push([path.join(pf, 'Antigravity', 'Antigravity.exe'), 'per-machine']);
  } else if (process.platform === 'darwin') {
    appCandidates.push(['/Applications/Antigravity.app', 'per-machine']);
    appCandidates.push([path.join(os.homedir(), 'Applications', 'Antigravity.app'), 'per-user']);
  }
  let app: AntigravityInstall | null = null;
  for (const [binary, source] of appCandidates) {
    checked.push(binary);
    if (!existsSync(binary)) continue;
    app = { kind: 'app', binary, version: win ? appVersion(binary) : null, source };
    break;
  }
  return { cli, app, checked, shim };
}
