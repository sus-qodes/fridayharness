import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { GATE_SOURCE, type ProcessGroup } from './groups.js';

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
  /**
   * The group the run's processes belong to (review F07). On Windows the run starts at Friday's
   * gate, so its whole tree is in the group's job before the command runs. Ending the group ends
   * every process the run started; when the run's first process exits, what it left running is
   * ended with it.
   */
  group?: ProcessGroup;
  /**
   * Called once the process started, with a function that ends its whole tree. With a group it
   * resolves once nothing of the tree is left; without one, once the signal is sent.
   */
  onStart?: (pid: number | undefined, stop: () => Promise<void>) => void;
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

/** The gate's own environment: only what Node needs to start; the command's is in its spec. */
function gateEnv(env: NodeJS.ProcessEnv, systemRoot: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = process.platform === 'win32' ? { SystemRoot: systemRoot } : {};
  for (const k of ['TEMP', 'TMP', 'TMPDIR']) if (env[k]) out[k] = env[k];
  return out;
}

/** One argument quoted for `cmd.exe /s /c` and the program behind it (callers refuse `"` and `%`). */
const quoteForCmd = (a: string) => `"${a.replace(/(\\+)$/, '$1$1')}"`;

/** A long-running process Friday talks to over its standard input and output (ADR-0032 §2). */
export interface InteractiveSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Every process it starts belongs to this group, and ends with it. */
  group: ProcessGroup;
  /** Each line it writes to standard output. */
  onLine: (line: string) => void;
  /** Characters of standard error to keep (the tail). */
  maxStderrChars?: number;
}

export interface InteractiveProcess {
  readonly pid: number | undefined;
  /** Writes to its standard input; what is written before it is in its group waits until then. */
  write(text: string): void;
  /** Ends it and everything it started; resolves once none of it is left. */
  stop(): Promise<void>;
  /** Resolves when it exits, with the tail of its standard error. */
  readonly exited: Promise<{
    exit_code: number | null;
    signal: string | null;
    stderr: string;
    spawn_error: string | null;
  }>;
}

/**
 * Starts a process that speaks over stdio (a host such as Codex's app-server) inside a group, at
 * Friday's gate: the command starts only once the gate is in the group, so the host and every
 * command it runs end with the group, whatever the host does with an interrupt (M3.5).
 */
export function startProcess(spec: InteractiveSpec): InteractiveProcess {
  const max = spec.maxStderrChars ?? 64 * 1024;
  const systemRoot = spec.env.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  let stderr = '';
  let failure: string | null = null;
  let ready = false;
  const queued: string[] = [];
  let resolveExit!: (o: {
    exit_code: number | null;
    signal: string | null;
    stderr: string;
    spawn_error: string | null;
  }) => void;
  const exited = new Promise<{
    exit_code: number | null;
    signal: string | null;
    stderr: string;
    spawn_error: string | null;
  }>((r) => {
    resolveExit = r;
  });
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, ['--no-warnings', '-e', GATE_SOURCE], {
      cwd: spec.cwd,
      env: gateEnv(spec.env, systemRoot),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    resolveExit({ exit_code: null, signal: null, stderr: '', spawn_error: (e as Error).message });
    return { pid: undefined, write: () => undefined, stop: async () => undefined, exited };
  }
  child.stdin?.on('error', () => undefined);
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
    if (stderr.length > max) stderr = stderr.slice(stderr.length - max);
  });
  let partial = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => {
    partial += d;
    for (let nl = partial.indexOf('\n'); nl >= 0; nl = partial.indexOf('\n')) {
      const line = partial.slice(0, nl).replace(/\r$/, '');
      partial = partial.slice(nl + 1);
      if (line) spec.onLine(line);
    }
  });
  child.once('error', (e) => {
    failure = e.message;
  });
  child.once('close', (code, signal) => {
    if (partial.trim()) spec.onLine(partial.trim());
    // What it left running ends with it.
    spec.group.terminate().catch(() => undefined);
    resolveExit({ exit_code: code, signal: signal ?? null, stderr, spawn_error: failure });
  });
  const pid = child.pid;
  if (pid !== undefined) {
    spec.group.adopt(pid).then(
      () => {
        const target = { file: spec.command, args: [...spec.args], verbatim: false };
        child.stdin?.write(`${JSON.stringify({ ...target, cwd: spec.cwd, env: spec.env, interactive: true })}\n`);
        ready = true;
        for (const q of queued.splice(0)) child.stdin?.write(q);
      },
      (e: Error) => {
        failure = `could not place the process in its group: ${e.message}`;
        killTree(pid);
      },
    );
  }
  return {
    pid,
    write(text: string) {
      if (ready) child.stdin?.write(text);
      else queued.push(text);
    },
    async stop() {
      await spec.group.terminate();
      child.stdin?.end();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000).unref())]);
    },
    exited,
  };
}

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
    // cmd.exe from the system folder, never one found on PATH; no AutoRun, no delayed expansion.
    const systemRoot = spec.env.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
    const target = spec.viaCmd
      ? {
          file: path.win32.join(systemRoot, 'System32', 'cmd.exe'),
          args: ['/d', '/v:off', '/s', '/c', `"${[spec.command, ...spec.args].map(quoteForCmd).join(' ')}"`],
          verbatim: true,
        }
      : { file: spec.command, args: [...spec.args], verbatim: false };
    const group = spec.group;
    let failure: string | null = null;
    let child: ReturnType<typeof spawn>;
    try {
      child = group
        ? // The gate starts nothing until its spec arrives, which is sent once it is in the group.
          spawn(process.execPath, ['--no-warnings', '-e', GATE_SOURCE], {
            cwd: spec.cwd,
            env: gateEnv(spec.env, systemRoot),
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        : spawn(target.file, target.args, {
            cwd: spec.cwd,
            env: spec.env,
            windowsHide: true,
            windowsVerbatimArguments: target.verbatim,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
    } catch (e) {
      finish({ spawn_error: (e as Error).message });
      return;
    }
    const stop = group
      ? () => group.terminate()
      : async () => {
          killTree(child.pid);
        };
    timer = setTimeout(() => {
      timedOut = true;
      stop().catch(() => killTree(child.pid));
    }, spec.timeoutMs);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.stdin?.on('error', () => undefined);
    child.once('error', (e) => finish({ spawn_error: e.message }));
    child.once('close', (code, signal) =>
      finish({ exit_code: code, signal: signal ?? null, ...(failure ? { spawn_error: failure } : {}) }),
    );
    if (!group || child.pid === undefined) {
      spec.onStart?.(child.pid, stop);
      return;
    }
    // What the run left running when its first process exits ends with it.
    child.once('exit', () => {
      group.terminate().catch(() => undefined);
    });
    const pid = child.pid;
    group.adopt(pid).then(
      () => {
        // One line; the pipe stays open while Friday runs (its end tells a POSIX gate Friday is gone).
        child.stdin?.write(`${JSON.stringify({ ...target, cwd: spec.cwd, env: spec.env })}\n`);
        spec.onStart?.(pid, stop);
      },
      (e: Error) => {
        failure = `could not place the process in its group: ${e.message}`;
        killTree(pid);
      },
    );
  });
}
