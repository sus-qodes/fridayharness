/**
 * @friday/verification
 * Runs the project's configured checks for a completion claim (spec Part 09 §7, plan B14).
 * M1: one runner, exec form, timeout with process-tree kill. M5 adds policies, diff analysis
 * and targeted tests.
 */
import { execFile, spawn } from 'node:child_process';

export const PACKAGE_NAME = '@friday/verification';

export interface CheckSpec {
  name: string;
  command: string;
  args?: string[];
  /** Absolute working directory. */
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Run through the shell (needed for `.cmd` shims such as npm on Windows). Off by default. */
  shell?: boolean;
  /** Bytes of combined output to keep (the tail is kept). */
  maxOutputBytes?: number;
}

export interface CheckOutcome {
  name: string;
  passed: boolean;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  /** Combined stdout + stderr (tail, if truncated). */
  output: string;
  output_truncated: boolean;
  /** Could not start (e.g. command not found). */
  spawn_error: string | null;
}

/**
 * Environment variables a project's checks never inherit from the daemon (review, M5 note):
 * provider keys, tokens and passwords. Checks run project code, which an agent may have written.
 */
const SECRET_ENV = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|ACCESS_?KEY)(?:$|_)/i;
const SECRET_ENV_NAMES = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NPM_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);

/** The daemon's environment without secrets, plus the check's own variables (those are kept as given). */
export function checkEnvironment(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (SECRET_ENV_NAMES.has(k.toUpperCase()) || SECRET_ENV.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra, FRIDAY_VERIFICATION: '1' };
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Runs one check and resolves with its outcome; never throws. */
export function runCheck(spec: CheckSpec): Promise<CheckOutcome> {
  const started = performance.now();
  const max = spec.maxOutputBytes ?? 256 * 1024;
  return new Promise((resolve) => {
    let output = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > max) {
        output = output.slice(output.length - max);
        truncated = true;
      }
    };
    const finish = (o: Partial<CheckOutcome>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name: spec.name,
        passed: false,
        exit_code: null,
        signal: null,
        timed_out: timedOut,
        duration_ms: Math.round(performance.now() - started),
        output,
        output_truncated: truncated,
        spawn_error: null,
        ...o,
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: checkEnvironment(process.env, spec.env),
        shell: spec.shell ?? false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ spawn_error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, spec.timeoutMs ?? 120_000);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (e) => finish({ spawn_error: e.message }));
    child.once('close', (code, signal) => {
      finish({ exit_code: code, signal: signal ?? null, passed: code === 0 && !timedOut });
    });
  });
}

/** Short human summary of a check outcome (one line). */
export function summarizeOutcome(o: CheckOutcome): string {
  if (o.spawn_error) return `could not start: ${o.spawn_error}`;
  if (o.timed_out) return `timed out after ${Math.round(o.duration_ms / 1000)} s`;
  const lines = o.output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const interesting =
    [...lines].reverse().find((l) => /\b(pass|fail|error|tests?|ok|✓|✗)\b/i.test(l)) ?? lines.at(-1) ?? '';
  return `${o.passed ? 'passed' : `failed (exit ${o.exit_code ?? o.signal})`} in ${o.duration_ms} ms${interesting ? `: ${interesting.slice(0, 160)}` : ''}`;
}
