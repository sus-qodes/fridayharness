/**
 * Process groups (review F07): every process a run starts ends with the run, including one whose
 * parent already exited, and an ended group is confirmed empty rather than assumed so.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessGroups, runProcess, startProcess } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const ws = useTestWorkspace();
let groups: ProcessGroups;
afterEach(async () => {
  await groups?.close();
});

const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);

/** Appends to `marker` every 25 ms, forever. */
const WRITER = "setInterval(() => require('node:fs').appendFileSync(process.argv[1], 'x'), 25)";

/**
 * Starts the writer as a grandchild, then exits at once: the writer is orphaned. On Windows it is
 * started detached, which leaves Node's own job for its children; on POSIX it stays in the group.
 */
const orphaning = (marker: string) =>
  [
    "const { spawn } = require('node:child_process');",
    `const w = spawn(process.execPath, ['-e', ${JSON.stringify(WRITER)}, ${JSON.stringify(marker)}], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });`,
    'w.unref();',
    'setTimeout(() => process.exit(0), 150);',
  ].join('\n');

async function stillWriting(marker: string, ms = 300): Promise<boolean> {
  const a = size(marker);
  await sleep(ms);
  return size(marker) > a;
}

const env = { ...process.env } as NodeJS.ProcessEnv;

describe('process groups', () => {
  it('ends what a run left running, an orphaned grandchild included, once its first process exits', async () => {
    groups = new ProcessGroups();
    const marker = path.join(ws().root, 'orphan.txt');
    const group = groups.create();
    const out = await runProcess({
      command: process.execPath,
      args: ['-e', orphaning(marker)],
      cwd: ws().root,
      env,
      timeoutMs: 20_000,
      group,
    });
    expect(out.spawn_error).toBeNull();
    expect(out.exit_code).toBe(0);
    await sleep(100);
    expect(await group.active()).toBe(0);
    expect(await stillWriting(marker)).toBe(false);
  });

  it('stops a running tree and resolves only once nothing of it is left', async () => {
    groups = new ProcessGroups();
    const marker = path.join(ws().root, 'running.txt');
    const group = groups.create();
    let stop: (() => Promise<void>) | undefined;
    const done = runProcess({
      command: process.execPath,
      args: [
        '-e',
        `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(WRITER)}, ${JSON.stringify(marker)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`,
      ],
      cwd: ws().root,
      env,
      timeoutMs: 20_000,
      group,
      onStart: (_pid, s) => {
        stop = s;
      },
    });
    // While every package tests at once, starting the group's helper and two processes can take
    // longer than 5 s (LESSONS T-63): wait for the writer as long as the run itself may take.
    for (let i = 0; i < 400 && size(marker) === 0; i++) await sleep(50);
    expect(size(marker)).toBeGreaterThan(0);
    await (stop as () => Promise<void>)();
    expect(await group.active()).toBe(0);
    expect(await stillWriting(marker)).toBe(false);
    const out = await done;
    expect(out.exit_code).not.toBe(0);
  }, 60_000);

  it('never starts a run whose group was ended before it began', async () => {
    groups = new ProcessGroups();
    const marker = path.join(ws().root, 'never.txt');
    const group = groups.create();
    await group.terminate();
    const out = await runProcess({
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      cwd: ws().root,
      env,
      timeoutMs: 20_000,
      group,
    });
    expect(out.spawn_error).toContain('could not place the process in its group');
    await sleep(200);
    expect(existsSync(marker)).toBe(false);
  });

  it('ends a run whose supervisor dies without warning, its descendants included', async () => {
    const marker = path.join(ws().root, 'crash.txt');
    const script = path.join(ws().root, 'supervisor.mjs');
    const entry = pathToFileURL(path.join(HERE, 'index.ts')).href;
    // The run writes, and starts a grandchild that writes too (detached on Windows, so only the job
    // holds it); the supervisor stands in for the daemon.
    const run = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(WRITER)}, ${JSON.stringify(marker)}], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' }).unref();`,
      `${WRITER.replace('process.argv[1]', JSON.stringify(marker))};`,
    ].join('\n');
    writeFileSync(
      script,
      [
        `import { ProcessGroups, runProcess } from ${JSON.stringify(entry)};`,
        'const group = new ProcessGroups().create();',
        `runProcess({ command: process.execPath, args: ['-e', ${JSON.stringify(run)}], cwd: ${JSON.stringify(ws().root)}, env: process.env, timeoutMs: 60000, group, onStart: () => console.log('STARTED') });`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const supervisor = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', script], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    ws().track(supervisor);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the supervisor did not start its run')), 30_000);
      supervisor.stdout?.on('data', (d: Buffer) => {
        if (String(d).includes('STARTED')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    for (let i = 0; i < 100 && size(marker) < 20; i++) await sleep(50);
    expect(await stillWriting(marker, 200)).toBe(true);
    // Killed alone, as a crash would: nothing asks its children to stop.
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(supervisor.pid), '/F'], { stdio: 'ignore' });
    else process.kill(supervisor.pid as number, 'SIGKILL');
    await new Promise((r) => supervisor.once('exit', r));
    await sleep(500);
    expect(await stillWriting(marker, 500)).toBe(false);
  }, 60_000);

  it('ends every group when the daemon closes them', async () => {
    groups = new ProcessGroups();
    const marker = path.join(ws().root, 'closing.txt');
    const group = groups.create();
    const done = runProcess({
      command: process.execPath,
      args: ['-e', `${WRITER}`, marker],
      cwd: ws().root,
      env,
      timeoutMs: 20_000,
      group,
    });
    for (let i = 0; i < 100 && size(marker) === 0; i++) await sleep(50);
    await groups.close();
    await done;
    expect(await stillWriting(marker)).toBe(false);
  });

  it('runs a host Friday talks to over stdio inside its group, and ends it with all it started (ADR-0032 §2)', async () => {
    groups = new ProcessGroups();
    const marker = path.join(ws().root, 'host.txt');
    const group = groups.create();
    // Answers each line; on "work" starts a writer that outlives nothing but its group.
    const host = [
      "const { spawn } = require('node:child_process');",
      "require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {",
      `  if (l === 'work') spawn(process.execPath, ['-e', ${JSON.stringify(WRITER)}, ${JSON.stringify(marker)}], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' }).unref();`,
      "  process.stdout.write(JSON.stringify({ echo: l }) + '\\n');",
      '});',
    ].join('\n');
    const lines: string[] = [];
    const p = startProcess({
      command: process.execPath,
      args: ['-e', host],
      cwd: ws().root,
      env,
      group,
      onLine: (l) => lines.push(l),
    });
    // Written before the host is in its group: delivered once it is.
    p.write('hello\n');
    p.write('work\n');
    for (let i = 0; i < 100 && lines.length < 2; i++) await sleep(50);
    expect(lines.map((l) => JSON.parse(l).echo)).toEqual(['hello', 'work']);
    for (let i = 0; i < 100 && size(marker) < 5; i++) await sleep(50);
    expect(await stillWriting(marker, 200)).toBe(true);
    await p.stop();
    expect(await group.active()).toBe(0);
    expect(await stillWriting(marker)).toBe(false);
    expect((await p.exited).spawn_error).toBeNull();
  }, 60_000);
});
