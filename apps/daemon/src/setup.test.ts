import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildProgress } from '@friday/code-graph';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { buildProjectGraph, ProgressLines, readSetupRecord, setupRecordPath, writeSetupRecord } from './setup.js';

const ws = useTestWorkspace();

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
}

describe('the setup record', () => {
  it('is written whole under .friday/graph and read back; garbage reads as none', () => {
    const root = path.join(ws().root, 'p');
    mkdirSync(root, { recursive: true });
    expect(readSetupRecord(root)).toBeNull();
    writeSetupRecord(root, {
      schema_version: 1,
      graph: {
        status: 'done',
        lines: ['a'],
        started_at: 't',
        finished_at: 't',
        stats: null,
        tree_hash: null,
        reason: null,
      },
    });
    expect(setupRecordPath(root)).toBe(path.join(root, '.friday', 'graph', 'setup.json'));
    expect(readSetupRecord(root)?.graph.status).toBe('done');
    expect(existsSync(`${setupRecordPath(root)}.${process.pid}.tmp`)).toBe(false);
    writeFileSync(setupRecordPath(root), '{not json');
    expect(readSetupRecord(root)).toBeNull();
    writeFileSync(setupRecordPath(root), JSON.stringify({ schema_version: 2, graph: {} }));
    expect(readSetupRecord(root)).toBeNull();
  });
});

describe('the progress lines', () => {
  it('say the listing, every tenth of the reading and its end, the resolution and the result', () => {
    const lines = new ProgressLines();
    const reading = (done: number, total: number): BuildProgress => ({
      phase: 'reading',
      done,
      total,
      parsed: done,
      cached: 0,
      unchanged: 0,
    });
    expect(lines.line({ phase: 'listing', files: 1313 })).toBe('Listing files: 1,313 source files');
    expect(lines.line(reading(25, 1313))).toBe('Reading files: 25/1,313 (25 parsed)');
    expect(lines.line(reading(50, 1313))).toBeNull();
    expect(lines.line(reading(132, 1313))).toBe('Reading files: 132/1,313 (132 parsed)');
    expect(lines.line(reading(140, 1313))).toBeNull();
    expect(lines.line(reading(1313, 1313))).toBe('Reading files: 1,313/1,313 (1,313 parsed)');
    expect(lines.line({ phase: 'resolving', files: 1290 })).toBe('Resolving imports and symbols across 1,290 files');
    expect(lines.line({ phase: 'done', files: 1290, edges: 4120, symbols: 8222, skipped: 2, ms: 3210 })).toBe(
      'Code graph ready: 1,290 files, 4,120 imports, 8,222 symbols in 3.2 s (2 skipped)',
    );
    expect(new ProgressLines().line({ phase: 'reading', done: 0, total: 0, parsed: 0, cached: 0, unchanged: 0 })).toBe(
      'Reading files: 0/0',
    );
  });
});

describe('buildProjectGraph', () => {
  it('skips a folder without git, says so, and records it', async () => {
    const root = path.join(ws().root, 'plain');
    mkdirSync(root, { recursive: true });
    const said: string[] = [];
    const step = await buildProjectGraph({ projectRoot: root, onLine: (l) => said.push(l) });
    expect(step.status).toBe('skipped');
    expect(step.reason).toBe('not a git repository');
    expect(said).toEqual([
      'Building the code graph',
      'No git repository here yet: the code graph is built once the repository has git',
    ]);
    expect(readSetupRecord(root)?.graph).toEqual(step);
  });

  it('builds the graph of a repository, prints each line as it goes, and records the result', async () => {
    const root = path.join(ws().root, 'repo');
    mkdirSync(root, { recursive: true });
    write(root, {
      'src/a.ts': "import { b } from './b.js';\nexport const a = b + 1;\n",
      'src/b.ts': 'export const b = 1;\n',
      'README.md': '# repo\n',
    });
    const g = deterministicGit(root);
    await g.init();
    await g.commitAll('init');
    const said: string[] = [];
    const step = await buildProjectGraph({ projectRoot: root, onLine: (l) => said.push(l) });
    expect(step.status, step.reason ?? '').toBe('done');
    expect(step.stats).toMatchObject({ files: 2, edges: 1, symbols: 2, skipped: 0 });
    expect(step.tree_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(said[0]).toBe('Building the code graph');
    expect(said[1]).toBe('Listing files: 2 source files');
    expect(said.at(-1)).toMatch(/^Code graph ready: 2 files, 1 imports, 2 symbols in \d+(\.\d)? s$/);
    expect(step.lines).toEqual(said);
    const record = JSON.parse(readFileSync(setupRecordPath(root), 'utf8'));
    expect(record).toEqual({ schema_version: 1, graph: step });
    // The build left its stores behind for the daemon to reuse.
    expect(existsSync(path.join(root, '.friday', 'graph'))).toBe(true);
  });
});
