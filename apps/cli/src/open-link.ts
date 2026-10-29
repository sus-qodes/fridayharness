import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { type DaemonDiscovery, DaemonUnreachableError, type ProjectRef, readDiscovery } from '@friday/sdk';
import { cliEntry } from './agent-launcher.js';

/**
 * Opening Friday in a browser, and starting it when it is not running (plan M9 §5.12, FD-23).
 *
 * The browser is given the redirect file the daemon wrote in the private directory, never the
 * link itself, so the one-time code is not on any process command line (LESSONS UI-22).
 */

export type Opener = (target: string) => void;

/** The system's opener, detached; its exit code means nothing (explorer.exe exits 1 when it worked). */
export const systemOpener: Opener = (target) => {
  const [command, args] =
    process.platform === 'win32'
      ? // By its absolute path, never a program of that name in the current folder (LESSONS D-52).
        [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), [target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    const child = spawn(command, args as string[], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Opening is a convenience; the address is printed too.
  }
};

let current: Opener = systemOpener;

/** The opener in use; under tests (VITEST) nothing is ever opened. */
export function openTarget(target: string): void {
  if (process.env.VITEST) return;
  current(target);
}

/** Replaces the opener (tests). */
export function setOpener(o: Opener): void {
  current = o;
}

async function healthy(d: DaemonDiscovery): Promise<boolean> {
  try {
    const res = await fetch(`${d.url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.status === 200 || res.status === 401;
  } catch {
    return false;
  }
}

/** The running daemon's discovery, or undefined when none answers. */
export async function runningDaemon(ref: ProjectRef): Promise<DaemonDiscovery | undefined> {
  const d = readDiscovery(ref);
  return d && (await healthy(d)) ? d : undefined;
}

/**
 * Starts `friday run` detached and hidden (its output in `.friday/logs/daemon-console.log`) and
 * waits up to `waitMs` for it to answer. On an early exit, the log's last lines explain why.
 */
export async function startDetached(ref: ProjectRef, waitMs = 30_000): Promise<DaemonDiscovery> {
  const logs = path.join(ref.root, '.friday', 'logs');
  mkdirSync(logs, { recursive: true });
  const logFile = path.join(logs, 'daemon-console.log');
  const fd = openSync(logFile, 'a');
  let exited: number | null = null;
  try {
    const child = spawn(process.execPath, [cliEntry(), '--project', ref.root, 'run'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      shell: false,
      // Not the project folder, and never a bare-name lookup there (LESSONS D-52).
      cwd: path.dirname(cliEntry()),
      env: { ...process.env, ...(process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) },
    });
    child.on('exit', (code) => {
      exited = code ?? -1;
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const d = await runningDaemon(ref);
    if (d) return d;
    if (exited !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const { readFileSync } = await import('node:fs');
  const tail = readFileSync(logFile, 'utf8').trim().split('\n').slice(-8).join('\n');
  throw new DaemonUnreachableError(
    `Friday did not start${exited !== null ? ` (it exited with ${exited})` : ' in time'}. Its last output:\n${tail}\nRun "friday doctor" to check this machine.`,
  );
}
