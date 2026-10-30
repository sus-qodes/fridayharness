/**
 * The project's one-time setup: `friday init` builds the code graph right away and records it;
 * a daemon that finds no record builds it once at start, with every line recorded as an
 * observation for a setup screen; `setup.graph: false` turns both off.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DomainEvent } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon } from '../helpers/daemon.js';

const ws = useTestWorkspace();
let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = savedStateDir;
});

async function repo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'friday-setup-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const git = deterministicGit(dir);
  await git.init();
  await git.commitAll('init');
  return dir;
}

const record = (dir: string) => path.join(dir, '.friday', 'graph', 'setup.json');

describe('friday init builds the code graph', () => {
  it('prints the setup lines, records the result, and the summary says the graph is ready', async () => {
    const dir = await repo();
    try {
      const r = await cli(['--project', dir, 'init', '--name', 'shop', '--no-hosts']);
      expect(r.code, r.stderr).toBe(0);
      const lines = r.stdout.split('\n');
      const heading = lines.indexOf('Setting up your project');
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(lines[heading + 1]).toBe('  Building the code graph');
      expect(lines[heading + 2]).toBe('  Listing files: 1 source files');
      expect(r.stdout).toMatch(/ {2}Code graph ready: 1 files, 0 imports, 1 symbols in /);
      // The summary comes after the lines, so the heading is above "Initialized".
      const initialized = lines.findIndex((l) => l.startsWith('Initialized Friday project "shop"'));
      expect(initialized).toBeGreaterThan(heading);
      expect(r.stdout).toContain('  code graph: ready (1 files, 1 symbols); it follows your changes from here');
      expect(readFileSync(path.join(dir, '.friday', 'config.yaml'), 'utf8')).toContain('setup:\n  graph: true\n');
      const saved = JSON.parse(readFileSync(record(dir), 'utf8'));
      expect(saved.graph).toMatchObject({ status: 'done', stats: { files: 1, symbols: 1 } });
      expect(saved.graph.lines[0]).toBe('Building the code graph');

      // Again with --force: the record stands, nothing is built twice.
      const again = await cli(['--project', dir, 'init', '--force', '--no-hosts']);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).not.toContain('Setting up your project');
      expect(again.stdout).toContain('  code graph: ready (1 files, 1 symbols)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--no-graph writes setup.graph: false, builds nothing, and says when the graph comes', async () => {
    const dir = await repo();
    try {
      const r = await cli(['--project', dir, 'init', '--no-graph', '--no-hosts']);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).not.toContain('Setting up your project');
      expect(r.stdout).toContain(
        '  code graph: not built now (--no-graph); it is built the first time something needs it',
      );
      expect(readFileSync(path.join(dir, '.friday', 'config.yaml'), 'utf8')).toContain('setup:\n  graph: false\n');
      expect(existsSync(record(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--json carries the graph step and prints no setup lines', async () => {
    const dir = await repo();
    try {
      const r = await cli(['--json', '--project', dir, 'init', '--no-hosts']);
      expect(r.code, r.stderr).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.graph).toMatchObject({ status: 'done', stats: { files: 1 } });
      expect(parsed.graph.lines).toContain('Building the code graph');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the daemon and the setup', () => {
  const setupEvents = async (td: Awaited<ReturnType<typeof startTestDaemon>>) =>
    (
      await td.operator.get<{ events: DomainEvent[] }>(
        `${td.operator.projectPath('/events')}?type=setup.started&type=setup.progress&type=setup.completed&type=setup.failed`,
      )
    ).events;

  it('builds the graph once at start when the project has no record, recording each line', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    await td.daemon.setup.start();
    const status = await td.operator.get<{
      state: string;
      graph: { status: string; lines: string[] };
      intent: unknown;
    }>(td.operator.projectPath('/setup'));
    expect(status.state).toBe('done');
    expect(status.graph.lines[0]).toBe('Building the code graph');
    expect(status.graph.lines.at(-1)).toMatch(/^Code graph ready: 0 files/);
    expect(status.intent).toEqual({ state: 'none', version: null, planner_available: expect.any(Boolean) });
    const events = await setupEvents(td);
    expect(events.map((e) => e.type)).toEqual([
      'setup.started',
      ...status.graph.lines.map(() => 'setup.progress'),
      'setup.completed',
    ]);
    expect(events[1]?.payload).toEqual({ step: 'graph', line: 'Building the code graph' });
    expect(events.at(-1)?.payload).toMatchObject({ step: 'graph', stats: { files: 0 } });
    expect(JSON.parse(readFileSync(record(ws().projectDir), 'utf8')).graph.status).toBe('done');

    // A second start finds the record and builds nothing.
    await td.daemon.close('restart');
    const td2 = await startTestDaemon(ws(), { initialized: true });
    await td2.daemon.setup.start();
    expect((await setupEvents(td2)).filter((e) => e.type === 'setup.started')).toHaveLength(1);
    expect((await td2.operator.get<{ state: string }>(td2.operator.projectPath('/setup'))).state).toBe('done');
  });

  it('with setup.graph: false the status is skipped and nothing is recorded', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      editConfig: (yaml) => yaml.replace('setup:\n  graph: true\n', 'setup:\n  graph: false\n'),
    });
    await td.daemon.setup.start();
    expect(await setupEvents(td)).toEqual([]);
    const status = await td.operator.get<{ state: string; graph: { status: string } }>(
      td.operator.projectPath('/setup'),
    );
    expect(status).toMatchObject({ state: 'skipped', graph: { status: 'pending' } });
    expect(existsSync(record(ws().projectDir))).toBe(false);
  });
});
