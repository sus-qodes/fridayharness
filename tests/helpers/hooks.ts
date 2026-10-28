import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './cli.js';

export const HOOK_FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'hooks', 'claude-code', 'v2.1', 'spike');
const BUNDLER = path.join(REPO_ROOT, 'packages', 'adapters', 'claude', 'scripts', 'bundle-hook.mjs');

/** Placeholders the scrubbed recordings use for machine paths. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder in the recordings.
const PROJECT_DIR = '${PROJECT_DIR}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder in the recordings.
const HOME = '${HOME}';

export interface HookVars {
  projectDir: string;
  sessionId?: string;
}

/** Recorded fixture names (without `.json`). */
export function hookFixtureNames(): string[] {
  return readdirSync(HOOK_FIXTURES)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/**
 * Loads a recorded hook input and fills in `${PROJECT_DIR}` and `${HOME}`. The recordings are from
 * Windows, so paths that start with a placeholder get this OS's separator.
 */
export function hookFixture(
  name: string,
  vars: HookVars,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  const { input } = JSON.parse(readFileSync(path.join(HOOK_FIXTURES, `${name}.json`), 'utf8')) as {
    input: Record<string, unknown>;
  };
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') {
      for (const [ph, value] of [
        [PROJECT_DIR, vars.projectDir],
        [HOME, os.homedir()],
      ] as const) {
        if (v.startsWith(ph)) return value + v.slice(ph.length).replace(/[\\/]/g, path.sep);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return {
    ...(fill(input) as Record<string, unknown>),
    ...(vars.sessionId ? { session_id: vars.sessionId } : {}),
    ...patch,
  };
}

let toolUse = 0;

/** A tool hook input shaped like the recordings. */
export function toolHook(
  event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure',
  tool: string,
  toolInput: Record<string, unknown>,
  vars: HookVars,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  toolUse += 1;
  return {
    session_id: vars.sessionId ?? 'sess-test-1',
    transcript_path: path.join(os.homedir(), '.claude', 'projects', 'fixture', 'transcript.jsonl'),
    cwd: vars.projectDir,
    prompt_id: 'prompt_test_1',
    permission_mode: 'acceptEdits',
    hook_event_name: event,
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: `toolu_test_${toolUse}`,
    ...extra,
  };
}

export interface HookReply {
  status: number;
  body: { ok?: boolean; hook_output?: unknown; error?: { code: string; message: string } };
}

/** POSTs a hook to the daemon exactly as the launcher does. */
export async function postHook(
  daemon: { url: string; projectId: string; token: string },
  event: string,
  hook: Record<string, unknown>,
  opts: { claudePid?: number; agentKey?: string | null; localDecision?: 'deny' | null } = {},
): Promise<HookReply> {
  const res = await fetch(`${daemon.url}/api/v1/projects/${daemon.projectId}/hooks/claude-code/${event}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_version: 1,
      launcher_version: 'test',
      claude_pid: opts.claudePid ?? 4242,
      agent_key: opts.agentKey ?? null,
      local_decision: opts.localDecision ?? null,
      hook,
    }),
  });
  return { status: res.status, body: (await res.json()) as HookReply['body'] };
}

/** The PreToolUse decision in a hook output, or null when Friday added none. */
export function decisionOf(output: unknown): { decision: string; reason: string } | null {
  const h = (
    output as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null
  )?.hookSpecificOutput;
  return h?.permissionDecision ? { decision: h.permissionDecision, reason: h.permissionDecisionReason ?? '' } : null;
}

/** Bundles the launcher from source, as `pnpm build` does, so tests never run a stale dist/hook.mjs. */
export async function bundleLauncher(dir: string): Promise<{ file: string; version: string }> {
  mkdirSync(dir, { recursive: true });
  const { bundleHook } = (await import(pathToFileURL(BUNDLER).href)) as {
    bundleHook: (outfile: string) => Promise<{ outfile: string; version: string }>;
  };
  const res = await bundleHook(path.join(dir, 'hook.mjs'));
  return { file: res.outfile, version: res.version };
}

/** Environment for host processes: no variables from the Claude Code session running the tests. */
export function hostEnv(env: Record<string, string | undefined>): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) =>
        v !== undefined && !k.startsWith('CLAUDE') && !k.startsWith('FRIDAY_') && k !== 'MCP_CONNECTION_NONBLOCKING',
    ),
  ) as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

export interface LauncherRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** stdout parsed as JSON, when it is JSON. */
  json: Record<string, unknown> | null;
}

/** Runs a launcher the way Claude Code does: `node <file> <Event>` with the hook input on stdin. */
export function runLauncher(
  file: string,
  event: string,
  hook: Record<string, unknown>,
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
): Promise<LauncherRun> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, event], {
      env: hostEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`launcher ${event} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json: Record<string, unknown> | null = null;
      try {
        json = stdout.trim().startsWith('{') ? (JSON.parse(stdout) as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, ms: Date.now() - started, json });
    });
    child.stdin.end(JSON.stringify(hook));
  });
}
