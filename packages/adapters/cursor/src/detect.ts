/**
 * Finding Cursor on this machine without starting it (plan M8b.2): the IDE from its per-user
 * install folder, the CLI (`agent`, also called `cursor-agent`) from `CURSOR_AGENT_BIN`, `PATH`
 * and its installer's folder, whose `versions\<version>` folders name the installed versions.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CursorIde {
  /** The folder of the installed app. */
  dir: string;
  version: string | null;
  /** Where the version was read. */
  version_source: string | null;
}

export interface CursorCli {
  /** The executable spawn mode starts, or null when none can be started without a shell. */
  binary: string | null;
  /** The newest installed version (the newest `versions` folder), or null when unknown. */
  version: string | null;
  /** Every installed version, newest first. */
  versions: string[];
  /** Why spawn mode cannot start it, in words for the operator. */
  problem: string | null;
  /** Where Friday looked, in order. */
  checked: string[];
}

const win = () => process.platform === 'win32';

function readVersion(file: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/** The per-user IDE: `%LOCALAPPDATA%\Programs\cursor` on Windows, the app bundle on macOS. */
export function findCursorIde(env: NodeJS.ProcessEnv = process.env): CursorIde | null {
  const dirs: { dir: string; app: string }[] = [];
  if (win() && env.LOCALAPPDATA) {
    const dir = path.join(env.LOCALAPPDATA, 'Programs', 'cursor');
    dirs.push({ dir, app: path.join(dir, 'resources', 'app') });
  } else if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      const dir = path.join(base, 'Cursor.app');
      dirs.push({ dir, app: path.join(dir, 'Contents', 'Resources', 'app') });
    }
  }
  for (const { dir, app } of dirs) {
    if (!existsSync(dir)) continue;
    const file = path.join(app, 'package.json');
    const version = readVersion(file);
    return { dir, version, version_source: version ? file : null };
  }
  return null;
}

/** The installer's folder: `%LOCALAPPDATA%\cursor-agent` on Windows, `~/.local/share/cursor-agent` elsewhere. */
export function cursorAgentHome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (win()) return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'cursor-agent') : null;
  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'cursor-agent');
}

/** Installed versions from the installer's `versions` folder, newest first (`2026.10.16-e3cb207`). */
export function installedVersions(home: string | null): string[] {
  if (!home) return [];
  const dir = path.join(home, 'versions');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}/.test(d.name))
      .map((d) => d.name)
      .sort(compareCliVersions)
      .reverse();
  } catch {
    return [];
  }
}

/** Orders CLI versions (`YYYY.MM.DD-hash`) by their date. */
export function compareCliVersions(a: string, b: string): number {
  const parts = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

/**
 * Finds the Cursor CLI: `CURSOR_AGENT_BIN`, then `agent` and `cursor-agent` on `PATH`, then the
 * installer's folder. On Windows only an executable is used: Friday passes the task's prompt as an
 * argument inside a process group, which a `.cmd` shim would hand to `cmd.exe` to re-read.
 */
export function findCursorAgent(env: NodeJS.ProcessEnv = process.env): CursorCli {
  const checked: string[] = [];
  const home = cursorAgentHome(env);
  const versions = installedVersions(home);
  const names = win() ? ['agent.exe', 'cursor-agent.exe'] : ['agent', 'cursor-agent'];
  const candidates: string[] = [];
  if (env.CURSOR_AGENT_BIN) candidates.push(env.CURSOR_AGENT_BIN);
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const n of names) candidates.push(path.join(dir, n));
  }
  if (home) {
    for (const n of names) candidates.push(path.join(home, n));
    if (!win()) candidates.push(path.join(os.homedir(), '.local', 'bin', 'agent'));
  }
  let shim: string | null = null;
  for (const c of candidates) {
    checked.push(c);
    if (existsSync(c)) {
      if (win() && /\.(cmd|bat|ps1)$/i.test(c)) {
        shim ??= c;
        continue;
      }
      return { binary: c, version: versions[0] ?? null, versions, problem: null, checked };
    }
    if (win() && !shim) {
      const cmd = c.replace(/\.exe$/i, '.cmd');
      if (cmd !== c && existsSync(cmd)) shim = cmd;
    }
  }
  return {
    binary: null,
    version: versions[0] ?? null,
    versions,
    problem: shim
      ? `only the shim ${shim} was found; spawn mode needs the agent executable: set CURSOR_AGENT_BIN to agent.exe or cursor-agent.exe`
      : versions.length
        ? `Cursor CLI versions ${versions.slice(0, 3).join(', ')} are installed, but no agent executable was found on PATH or in its folder: set CURSOR_AGENT_BIN`
        : 'the Cursor CLI was not found: install it (see docs/integration/cursor.md), or set CURSOR_AGENT_BIN',
    checked,
  };
}

/** Names that look like a secret, which no host gets from Friday's environment. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL)/i;
/** The Cursor CLI's own login, when the user gives it by environment. */
const CURSOR_LOGIN = new Set(['CURSOR_API_KEY']);

/**
 * The environment of a Cursor session the spawn adapter starts: the adapter's own, without
 * - Friday's variables, except the state folder the hook launcher reads;
 * - every `CURSOR_*` and `CLAUDE*` variable, which describe a session the adapter may itself run in
 *   (a terminal inside Cursor or Claude Code): Cursor's hooks would take that session's project
 *   folder for this one's (`CURSOR_PROJECT_DIR`);
 * - names that look like secrets, except the CLI's own login (`CURSOR_API_KEY`).
 */
export function cursorEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (CURSOR_LOGIN.has(upper)) {
      out[k] = v;
      continue;
    }
    if (upper.startsWith('CURSOR_') || upper.startsWith('CLAUDE')) continue;
    if (upper === 'MCP_CONNECTION_NONBLOCKING') continue;
    if (upper.startsWith('FRIDAY_') && upper !== 'FRIDAY_STATE_DIR') continue;
    if (SECRET_NAME.test(k)) continue;
    out[k] = v;
  }
  return out;
}
