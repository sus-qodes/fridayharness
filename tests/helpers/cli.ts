import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '@friday/cli';
import type { TestWorkspace } from '@friday/test-support';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_SOURCE = path.join(REPO_ROOT, 'apps', 'cli', 'src', 'bin.ts');

/** Runs the CLI in this process and captures its output. Uses `process.env.FRIDAY_STATE_DIR`. */
export async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = undefined;
  try {
    const code = await runCli(['node', 'friday', ...args]);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    process.exitCode = undefined;
  }
}

/** Spawns `friday run` from source (tsx) and resolves once it prints FRIDAY_READY. */
export async function spawnFridayRun(
  ws: TestWorkspace,
  timeoutMs = 30_000,
): Promise<{ child: ChildProcess; url: string; output: () => string }> {
  const child = spawn(
    process.execPath,
    ['--conditions', 'development', '--import', 'tsx', CLI_SOURCE, '--project', ws.projectDir, 'run'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, FRIDAY_STATE_DIR: ws.stateDir, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    },
  );
  ws.track(child);
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (c: string) => {
    output += c;
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`friday run did not start within ${timeoutMs} ms:\n${output}`)),
      timeoutMs,
    );
    child.stdout?.on('data', (c: string) => {
      output += c;
      const m = /FRIDAY_READY (\{.*\})/.exec(output);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve((JSON.parse(m[1]) as { url: string }).url);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`friday run exited early (${code}):\n${output}`));
    });
  });
  return { child, url, output: () => output };
}
