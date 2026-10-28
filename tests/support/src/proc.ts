import { type ChildProcess, execFile, type SpawnOptions, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const isWindows = process.platform === 'win32';

export interface SpawnNodeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: SpawnOptions['stdio'];
}

/**
 * Spawns `node <script> ...args` without a shell.
 * Never spawn `.cmd` shims (pnpm/npx bins) on Windows: they cannot be executed without a shell.
 * On POSIX the child leads its own process group so `killTree` can signal the whole group.
 */
export function spawnNode(script: string, args: string[] = [], opts: SpawnNodeOptions = {}): ChildProcess {
  return spawn(process.execPath, [script, ...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    detached: !isWindows,
  });
}

/** True when a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kills a process and all of its descendants.
 * Windows: `taskkill /PID <pid> /T /F`. POSIX: SIGTERM to the process group, then SIGKILL after a grace period.
 */
export async function killTree(pid: number | undefined, opts: { graceMs?: number } = {}): Promise<void> {
  if (pid === undefined || !isAlive(pid)) return;
  if (isWindows) {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
    return;
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  };
  signalGroup('SIGTERM');
  const deadline = Date.now() + (opts.graceMs ?? 2_000);
  while (Date.now() < deadline && isAlive(pid)) await sleep(50);
  // Descendants may ignore SIGTERM even when the leader exited.
  signalGroup('SIGKILL');
}

/** Resolves when the child exits; rejects after `timeoutMs`. */
export function waitForExit(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`process ${child.pid} did not exit within ${timeoutMs} ms`)),
      timeoutMs,
    );
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Polls until `pid` no longer exists. */
export async function waitForPidGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return !isAlive(pid);
}
