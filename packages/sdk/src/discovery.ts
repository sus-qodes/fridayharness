import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FridayError } from '@friday/protocol';
import { protectPrivateDir } from './access.js';
import { type FridayConfig, loadConfig } from './config.js';

export const FRIDAY_DIR = '.friday';
export const CONFIG_FILE = 'config.yaml';

export interface ProjectRef {
  /** Real path of the main worktree. */
  root: string;
  project_id: string;
  name: string;
  /** `<project_id>-<8 hex of sha256(root)>` (ADR-0008): two clones never share state. */
  project_key: string;
  config: FridayConfig;
}

export interface DaemonDiscovery {
  schema_version: 1;
  instance_id: string;
  project_id: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  url: string;
  api_version: string;
  protocol_versions: string[];
  started_at: string;
  daemon_version: string;
}

function realpath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Main worktree root via `git rev-parse --git-common-dir`, so linked worktrees resolve to the same project (ADR-0012). */
function gitMainRoot(start: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', start, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    }).trim();
    if (!out) return undefined;
    const common = path.resolve(start, out);
    return path.basename(common) === '.git' ? path.dirname(common) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The checkout a directory belongs to: its git top level, a task worktree or the main checkout
 * (ADR-0023 §3), as a real path; undefined outside git.
 */
export function checkoutRoot(start: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    }).trim();
    return out ? realpath(path.resolve(out)) : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the project root from a directory: git main worktree first, then the nearest `.friday/config.yaml`. */
export function findProjectRoot(start: string = process.env.FRIDAY_PROJECT_DIR ?? process.cwd()): string | undefined {
  const abs = path.resolve(start);
  const viaGit = gitMainRoot(abs);
  if (viaGit && existsSync(path.join(viaGit, FRIDAY_DIR, CONFIG_FILE))) return realpath(viaGit);
  let dir = abs;
  for (;;) {
    if (existsSync(path.join(dir, FRIDAY_DIR, CONFIG_FILE))) return realpath(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function projectKey(projectId: string, root: string): string {
  const norm = process.platform === 'win32' ? root.toLowerCase() : root;
  return `${projectId}-${createHash('sha256').update(norm).digest('hex').slice(0, 8)}`;
}

export function loadProject(start?: string): ProjectRef {
  const root = findProjectRoot(start);
  if (!root) {
    throw new FridayError(
      'project_not_found',
      `no Friday project found from ${start ?? process.cwd()}; run "friday init"`,
    );
  }
  const config = loadConfig(path.join(root, FRIDAY_DIR, CONFIG_FILE));
  return {
    root,
    project_id: config.project.id,
    name: config.project.name,
    project_key: projectKey(config.project.id, root),
    config,
  };
}

/** Per-user private state directory (ADR-0008). */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FRIDAY_STATE_DIR) return path.resolve(env.FRIDAY_STATE_DIR);
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Friday');
  }
  return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'friday');
}

export function privateDirFor(ref: Pick<ProjectRef, 'project_key'>, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'projects', ref.project_key);
}

/**
 * Creates a private directory and makes sure only the current user can open it (review F02):
 * an explicit user-only ACL on Windows, mode 0700 elsewhere. Throws when that cannot be done.
 */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  protectPrivateDir(dir);
  return dir;
}

/** Writes a file readable only by the current user (mode 0600; on Windows the directory's user-only ACL is inherited). */
export function writePrivateFile(dir: string, name: string, content: string): string {
  ensurePrivateDir(dir);
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  // Atomic replace. On Windows a reader holding the file open can briefly cause EPERM; retry.
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, file);
      break;
    } catch (e) {
      if (attempt >= 20) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return file;
}

export function readDiscovery(
  ref: Pick<ProjectRef, 'project_key'>,
  env: NodeJS.ProcessEnv = process.env,
): DaemonDiscovery | undefined {
  const file = path.join(privateDirFor(ref, env), 'daemon.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DaemonDiscovery;
  } catch {
    return undefined;
  }
}

export type LocalTokenClass = 'operator' | 'bootstrap';

export function readToken(
  ref: Pick<ProjectRef, 'project_key'>,
  tokenClass: LocalTokenClass,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const file = path.join(privateDirFor(ref, env), `${tokenClass}.token`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined;
}

/** Contents of `<stateDir>/install.json`, written by `friday setup`. */
export interface InstallInfo {
  friday_version: string;
  node_path: string;
  cli_entry: string | null;
  daemon_entry: string | null;
  mcp_server_entry: string | null;
  written_at: string;
}

export function readInstallInfo(env: NodeJS.ProcessEnv = process.env): InstallInfo | undefined {
  const file = path.join(stateDir(env), 'install.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as InstallInfo;
  } catch {
    return undefined;
  }
}

/** Where the MCP server's launcher sits inside a copy of Friday, a checkout or an installed archive. */
const MCP_ENTRY_IN_COPY = ['packages', 'mcp-server', 'bin', 'friday-mcp.mjs'];

/**
 * The MCP server launcher of the copy of Friday this code runs from: the nearest folder above this
 * module that holds one. A checkout and the installed archive share one layout and a bundle sits
 * inside it, so the same walk finds it from `packages/sdk`, from `apps/cli/dist` and from sources.
 * It is the path `friday setup`, run by this copy, records as `mcp_server_entry`.
 */
export function ownMcpEntry(from: string = fileURLToPath(import.meta.url)): string | undefined {
  let dir = path.dirname(path.resolve(from));
  for (let up = 0; up < 8; up += 1) {
    const entry = path.join(dir, ...MCP_ENTRY_IN_COPY);
    if (existsSync(entry)) return entry;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Whether two paths name one file: by real path where it exists (links resolved), and without case on Windows. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const real = realpath(path.resolve(p));
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `31 October 2026` for a recorded time, in this machine's time zone; undefined when it is not a time. */
function plainDate(iso: unknown): string | undefined {
  const at = typeof iso === 'string' ? new Date(iso) : undefined;
  if (!at || Number.isNaN(at.getTime())) return undefined;
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
}

/** The folder of the copy of Friday an MCP server entry belongs to; the entry itself when it sits anywhere else. */
function copyOf(entry: string): string {
  const home = path.resolve(entry, '..', '..', '..', '..');
  return samePath(path.join(home, ...MCP_ENTRY_IN_COPY), entry) ? home : path.resolve(entry);
}

/** What a host's setup check says about `install.json`: the status and words of its check, and the entry found. */
export interface InstallCheck {
  status: 'ok' | 'warn' | 'fail';
  message: string;
  fix?: string;
  /** The MCP server entry the apps a person opens themselves start; undefined when none is on disk. */
  entry?: string;
}

/**
 * The machine's install entry as a host's setup check reports it (`friday harness doctor <host>`).
 * The apps a person opens themselves start Friday's MCP server through a launcher that reads
 * `install.json` each time it runs, so a file written by another copy of Friday leaves them on that
 * copy while this one runs the daemon (seen 2026-11-17: a session that registered under the wrong
 * name, showed as two agents and was refused work). That is a warning in plain words.
 *
 * `named` is `FRIDAY_MCP_ENTRY` as the caller reads it: an entry someone named by hand, which is
 * used as it is and compared with nothing. `own` is the entry of the copy that asks (this code's
 * own copy unless given; null for none, which compares nothing).
 */
export function installCheck(
  opts: { env?: NodeJS.ProcessEnv; named?: string | undefined; own?: string | null | undefined } = {},
): InstallCheck {
  const info = readInstallInfo(opts.env);
  const entry = opts.named ?? info?.mcp_server_entry ?? undefined;
  if (!entry || !existsSync(entry)) {
    return {
      status: 'fail',
      message: 'Friday is not set up on this machine (install.json has no MCP server entry)',
      fix: 'run "pnpm build" in the Friday repository, then "friday setup"',
    };
  }
  const own = opts.own === undefined ? ownMcpEntry() : opts.own;
  if (opts.named === undefined && own && !samePath(entry, own)) {
    const when = plainDate(info?.written_at);
    return {
      status: 'warn',
      message: `Apps you open yourself start another copy of Friday (${copyOf(entry)}${when ? `, set up on ${when}` : ''}), not this one. Open the Friday desktop app once, or run friday setup, to switch them to this copy.`,
      entry,
    };
  }
  return { status: 'ok', message: `MCP server entry: ${entry}`, entry };
}
