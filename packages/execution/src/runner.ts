import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

/** One process: its absolute binary, arguments, folder and complete environment. */
export interface ProcessSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** A Windows `.cmd`/`.bat` shim: started through `cmd.exe` with each argument quoted. */
  viaCmd?: boolean;
  timeoutMs: number;
  /** Characters of combined output to keep (the tail). */
  maxOutputChars?: number;
  /** Called once the process started, with a function that ends its whole tree. */
  onStart?: (pid: number | undefined, stop: () => void) => void;
}

export interface ProcessOutcome {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  /** Combined stdout and stderr (the tail, if truncated). */
  output: string;
  output_truncated: boolean;
  /** Could not start (for example the binary vanished). */
  spawn_error: string | null;
}

/** Ends a process and everything it started. */
export function killTree(pid: number | undefined): void {
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

/** One argument quoted for `cmd.exe /s /c` and the program behind it (callers refuse `"` and `%`). */
const quoteForCmd = (a: string) => `"${a.replace(/(\\+)$/, '$1$1')}"`;

/** Runs one process and resolves with its outcome; never throws. */
export function runProcess(spec: ProcessSpec): Promise<ProcessOutcome> {
  const started = performance.now();
  const max = spec.maxOutputChars ?? 256 * 1024;
  return new Promise((resolve) => {
    let output = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > max) {
        output = output.slice(output.length - max);
        truncated = true;
      }
    };
    const finish = (o: Partial<ProcessOutcome>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
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
      if (spec.viaCmd) {
        // cmd.exe from the system folder, never one found on PATH; no AutoRun, no delayed expansion.
        const root = spec.env.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
        const line = [spec.command, ...spec.args].map(quoteForCmd).join(' ');
        child = spawn(path.win32.join(root, 'System32', 'cmd.exe'), ['/d', '/v:off', '/s', '/c', `"${line}"`], {
          cwd: spec.cwd,
          env: spec.env,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        child = spawn(spec.command, [...spec.args], {
          cwd: spec.cwd,
          env: spec.env,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    } catch (e) {
      finish({ spawn_error: (e as Error).message });
      return;
    }
    const stop = () => killTree(child.pid);
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (e) => finish({ spawn_error: e.message }));
    child.once('close', (code, signal) => finish({ exit_code: code, signal: signal ?? null }));
    spec.onStart?.(child.pid, stop);
  });
}
