/**
 * Friday's Claude Code hook launcher. Bundled into one dependency-free file
 * (`dist/hook.mjs`, copied to `<project>/.friday/harness/claude-code/hook.mjs`) and run by
 * Claude Code in exec form: `node <that file> <Event>`.
 *
 * It never contains secrets or machine paths. At runtime it finds the project, Friday's
 * private state directory, the daemon's address and the bootstrap token, then forwards the
 * hook to the daemon. Sensitive-path rules are decided here first, so they hold even when the
 * daemon is down (ADR-0009). Any failure follows the fail rules in plan M1.10.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateSensitive } from '@friday/policy';
import { actionFromTool, stripHookPayload } from './actions.js';
import { COMMAND_TOOLS, NETWORK_TOOLS, WRITE_TOOLS } from './types.js';

export const LAUNCHER_VERSION = '0.1.0';

type Out = Record<string, unknown> | string | null;

function readStdin(): Record<string, unknown> {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function hasConfig(dir: string): boolean {
  return existsSync(path.join(dir, '.friday', 'config.yaml'));
}

/**
 * Same resolution as @friday/sdk findProjectRoot, without dependencies: the git main worktree
 * first (a linked worktree also contains the tracked config.yaml but is not the project root),
 * then the nearest `.friday/config.yaml`.
 */
export function findRoot(start: string): string | undefined {
  try {
    const common = execFileSync('git', ['-C', start, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 3000,
    }).trim();
    const abs = path.resolve(start, common);
    if (path.basename(abs) === '.git' && hasConfig(path.dirname(abs))) return real(path.dirname(abs));
  } catch {
    // not a git repository
  }
  let dir = path.resolve(start);
  for (;;) {
    if (hasConfig(dir)) return real(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function stateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FRIDAY_STATE_DIR) return path.resolve(env.FRIDAY_STATE_DIR);
  if (process.platform === 'win32')
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Friday');
  return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'friday');
}

export function projectIdOf(root: string): string | undefined {
  try {
    const text = readFileSync(path.join(root, '.friday', 'config.yaml'), 'utf8');
    return /\bid:\s*["']?(proj_[0-9a-hjkmnp-tv-z]{26})/.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

export function projectKeyOf(projectId: string, root: string): string {
  const norm = process.platform === 'win32' ? root.toLowerCase() : root;
  return `${projectId}-${createHash('sha256').update(norm).digest('hex').slice(0, 8)}`;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function print(out: Out): void {
  if (out === null) return;
  process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
}

const preDecision = (decision: 'deny' | 'ask', reason: string) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
    permissionDecisionReason: `Friday: ${reason}`,
  },
});

/** What to do when the daemon cannot decide (plan M1.10 failure rules). */
export function failureOutput(event: string, toolName: string | undefined, why: string): Out {
  if (event === 'PreToolUse' && toolName) {
    if (WRITE_TOOLS.has(toolName)) {
      return preDecision(
        'deny',
        `edits are paused because Friday is unavailable (${why}). Ask the human to run "friday run".`,
      );
    }
    if (COMMAND_TOOLS.has(toolName) || NETWORK_TOOLS.has(toolName)) {
      return preDecision('ask', `Friday is unavailable (${why}), so a human must confirm this.`);
    }
    return null;
  }
  if (event === 'SessionStart') {
    return `Friday is not available for this session (${why}). Ask the human to run "friday run" in the project, then restart the session. Do not edit files until Friday is available.`;
  }
  return null;
}

const TIMEOUTS: Record<string, number> = { PreToolUse: 4000, SessionStart: 12_000, SessionEnd: 2000 };

export async function main(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const event = argv[2] ?? 'unknown';
  const hook = readStdin();
  const toolName = typeof hook.tool_name === 'string' ? hook.tool_name : undefined;
  const start = env.CLAUDE_PROJECT_DIR || (typeof hook.cwd === 'string' ? hook.cwd : '') || process.cwd();
  const root = findRoot(start);
  if (!root) return 0; // not a Friday project: stay out of the way
  const projectId = projectIdOf(root);
  if (!projectId) return 0;
  const stateDir = stateDirFromEnv(env);

  // 1. Sensitive paths are decided locally: no daemon needed, so this cannot fail open.
  let localDeny: Out = null;
  if (event === 'PreToolUse' && toolName) {
    const action = actionFromTool(toolName, (hook.tool_input as Record<string, unknown>) ?? {});
    const local = action ? evaluateSensitive(action, { projectRoot: root, stateDir }) : null;
    if (local) localDeny = preDecision('deny', local.reason);
  }

  // 2. Everything else is decided (and every decision recorded) by the daemon.
  const priv = path.join(stateDir, 'projects', projectKeyOf(projectId, root));
  const discovery = readJson<{ url: string }>(path.join(priv, 'daemon.json'));
  let token = '';
  try {
    token = readFileSync(path.join(priv, 'bootstrap.token'), 'utf8').trim();
  } catch {
    token = '';
  }
  if (!discovery?.url || !token) {
    print(localDeny ?? failureOutput(event, toolName, 'the daemon is not running'));
    return 0;
  }
  const agent = readJson<{ agent_key?: string }>(path.join(priv, 'agent.json'));
  const body = {
    schema_version: 1,
    launcher_version: LAUNCHER_VERSION,
    claude_pid: process.ppid,
    agent_key: env.FRIDAY_AGENT || agent?.agent_key || null,
    local_decision: localDeny ? 'deny' : null,
    hook: stripHookPayload(hook),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUTS[event] ?? 8000);
  try {
    const res = await fetch(
      `${discovery.url}/api/v1/projects/${projectId}/hooks/claude-code/${encodeURIComponent(event)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-friday-client': `hook-launcher/${LAUNCHER_VERSION}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      },
    );
    const json = (await res.json().catch(() => ({}))) as { hook_output?: Out; error?: { message?: string } };
    if (localDeny) print(localDeny);
    else if (!res.ok) print(failureOutput(event, toolName, json.error?.message ?? `daemon answered ${res.status}`));
    else print(json.hook_output ?? null);
  } catch (e) {
    print(
      localDeny ??
        failureOutput(
          event,
          toolName,
          ctrl.signal.aborted ? 'the daemon did not answer in time' : (e as Error).message,
        ),
    );
  } finally {
    clearTimeout(timer);
  }
  return 0;
}
