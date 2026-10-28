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
