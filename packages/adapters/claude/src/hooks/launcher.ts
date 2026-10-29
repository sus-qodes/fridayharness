/**
 * Friday's hook launcher, for every host Friday hooks into (plan B9, M8b.1). Bundled into one
 * dependency-free file (`dist/hook.mjs`, copied to `<project>/.friday/harness/<host>/hook.mjs`)
 * and run by the host: `node <that file> <vendor> <event>`, or `node <that file> <Event>` as
 * Claude Code has always run it.
 *
 * It never contains secrets or machine paths. At runtime its host module turns the host's input
 * into Friday's one shape; then it finds the project, Friday's private state directory, the
 * daemon's address and the bootstrap token, and forwards the hook to the daemon. Sensitive-path
 * rules are decided here first, for every host, so they hold even when the daemon is down
 * (ADR-0009). Any failure follows the fail rules in plan M1.10. The host module turns the answer
 * into the host's reply and exit code.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateSensitive } from '@friday/policy';
import { actionFromTool, stripHookPayload } from './actions.js';
import { claudeHookOutput } from './hosts/claude-code.js';
import { failureJudgment, wireHook, wireHost } from './hosts/common.js';
import { cursorRunsFriday, importedCursorCall } from './hosts/cursor.js';
import { hostModule, importedByCursor, launcherArgs } from './hosts/index.js';
import { type HookJudgment, type HostReply, isFridayTool } from './types.js';

export const LAUNCHER_VERSION = '0.2.0';

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

/** The checkout a directory belongs to (a task worktree or the main checkout), as a real path. */
export function checkoutOf(start: string): string | undefined {
  try {
    const top = execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 3000,
    }).trim();
    return top ? real(top) : undefined;
  } catch {
    return undefined;
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

/** What to do when the daemon cannot decide (plan M1.10 failure rules), as Claude Code's output. */
export function failureOutput(event: string, toolName: string | undefined, why: string): Out {
  return claudeHookOutput(failureJudgment(event, toolName, why));
}

/**
 * How long the launcher waits for the daemon, per Friday event: below the timeout Friday writes into
 * every host's hook configuration (Claude Code: PreToolUse 5 s, SessionStart 15 s, SessionEnd 3 s),
 * so the launcher's own answer arrives before the host gives up on it.
 */
export const LAUNCHER_BUDGET_MS: Record<string, number> = { PreToolUse: 4000, SessionStart: 12_000, SessionEnd: 2000 };
export const LAUNCHER_DEFAULT_BUDGET_MS = 8000;

function print(out: Out | undefined): void {
  if (out === null || out === undefined) return;
  process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
}

function write(reply: HostReply): number {
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  return reply.exit_code;
}

/**
 * Cursor running Claude Code's hooks through its import (`importedByCursor`). Where the project's
 * `.cursor/hooks.json` runs Friday's launcher, those hooks judge the call: nothing is answered or
 * recorded here, so each call is judged once. Where it does not, nothing else of Friday's sees the
 * call, so the launcher's own rules apply to it, answered in Claude Code's reply format, which
 * Cursor reads on that path; a call they pass gets no decision.
 */
function importedFromCursor(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): number {
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
  const dir = [env.CURSOR_PROJECT_DIR, roots[0], raw.cwd].find((v): v is string => typeof v === 'string' && v !== '');
  const root = findRoot(dir ?? process.cwd());
  if (!root || cursorRunsFriday(root)) return 0;
  const input = importedCursorCall(raw, env);
  if (!input?.tool_name || isFridayTool(input.tool_name)) return 0;
  const action = actionFromTool(input.tool_name, input.tool_input ?? {});
  const checkout = checkoutOf(dir ?? root) ?? root;
  const local = action
    ? evaluateSensitive(action, { projectRoot: checkout, mainRoot: root, stateDir: stateDirFromEnv(env) })
    : null;
  const reason = local?.reason ?? input.shape_error;
  if (reason) print(claudeHookOutput({ decision: 'deny', reason }));
  return 0;
}

export async function main(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  // Windows looks for a program started by its bare name (git) in the current folder before PATH;
  // a hook runs in the repository, whose content it does not trust (LESSONS D-52).
  if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';
  const { vendor, event: hostEvent } = launcherArgs(argv);
  const claude = vendor === 'claude-code';
  const host = hostModule(vendor);
  const raw = readStdin();
  if (claude && importedByCursor(env, raw)) return importedFromCursor(raw, env);
  const input = host.normalize(raw, hostEvent, env);
  const event = input.event;
  const toolName = input.tool_name;
  // Claude Code's replies are printed as the daemon gives them, so a launcher of any version works
  // with a daemon of any version; every other host's reply is built here from Friday's judgment.
  const answer = (j: HookJudgment): number => write(host.render(j, input));
  const none = (): number => (claude ? 0 : answer({ decision: 'none' }));
  // A host event Friday does nothing with, or a call another of the host's hooks carries in full.
  if (!event || input.judging === 'defer') return none();
  // Friday's own MCP tools are judged by the protocol behind them (ADR-0030 §1): nothing to add.
  if (toolName && isFridayTool(toolName)) return none();
  const start = input.project_dir || input.cwd || process.cwd();
  const root = findRoot(start);
  if (!root) return none(); // not a Friday project: stay out of the way
  const projectId = projectIdOf(root);
  if (!projectId) return none();
  const stateDir = stateDirFromEnv(env);

  // 1. Sensitive paths are decided locally, for every host: no daemon needed, so this cannot fail open.
  let localDeny: HookJudgment | null = null;
  if (event === 'PreToolUse' && toolName) {
    const action = actionFromTool(toolName, input.tool_input ?? {});
    // A session in a task worktree judges paths in its checkout; the main checkout stays protected (ADR-0023 §6).
    const checkout = checkoutOf(start) ?? root;
    const local = action ? evaluateSensitive(action, { projectRoot: checkout, mainRoot: root, stateDir }) : null;
    if (local) localDeny = { decision: 'deny', reason: local.reason };
    else if (input.shape_error) localDeny = { decision: 'deny', reason: input.shape_error };
  }
  if (input.judging === 'local' && !localDeny) return none();
  // A session Friday's spawn adapter started has no human to answer an ask (Cursor's and Gemini
  // CLI's adapters set this for their sessions); a hook that cannot ask has none either.
  const at = { canAsk: input.can_ask, headless: Boolean(env.FRIDAY_SPAWN_RUN) };
  /** The launcher's own answer: its local denial, else the failure rules for `why`. */
  const ownAnswer = (why: string): number => {
    const j = localDeny ?? failureJudgment(event, toolName, why, at);
    if (!claude) return answer(j);
    print(claudeHookOutput(j));
    return 0;
  };

  // 2. Everything else is decided (and every decision recorded) by the daemon.
  const priv = path.join(stateDir, 'projects', projectKeyOf(projectId, root));
  const discovery = readJson<{ url: string }>(path.join(priv, 'daemon.json'));
  let token = '';
  try {
    token = readFileSync(path.join(priv, 'bootstrap.token'), 'utf8').trim();
  } catch {
    token = '';
  }
  if (!discovery?.url || !token) return ownAnswer('the daemon is not running');
  const agent = readJson<{ agent_key?: string }>(path.join(priv, 'agent.json'));
  const body = {
    schema_version: 1,
    launcher_version: LAUNCHER_VERSION,
    // The host process the hook runs under: the MCP server Friday registers has the same parent
    // when the host starts both directly (Claude Code); a host that runs hooks through a shell
    // reports that shell.
    ...(claude ? { claude_pid: process.ppid } : {}),
    host_pid: process.ppid,
    agent_key: env.FRIDAY_AGENT || agent?.agent_key || null,
    local_decision: localDeny ? 'deny' : null,
    // Claude Code's own input goes as it always has; another host's goes in Friday's vocabulary.
    hook: stripHookPayload(claude ? raw : wireHook(input)),
    ...(claude ? {} : { host: wireHost(input) }),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LAUNCHER_BUDGET_MS[event] ?? LAUNCHER_DEFAULT_BUDGET_MS);
  try {
    const res = await fetch(
      `${discovery.url}/api/v1/projects/${projectId}/hooks/${vendor}/${encodeURIComponent(event)}`,
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
    const json = (await res.json().catch(() => ({}))) as {
      hook_output?: Out;
      judgment?: HookJudgment;
      error?: { message?: string };
    };
    if (localDeny) return ownAnswer('');
    if (!res.ok) return ownAnswer(json.error?.message ?? `daemon answered ${res.status}`);
    if (claude) {
      print(json.hook_output ?? null);
      return 0;
    }
    return answer(json.judgment ?? { decision: 'none' });
  } catch (e) {
    return ownAnswer(ctrl.signal.aborted ? 'the daemon did not answer in time' : (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
