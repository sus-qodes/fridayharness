import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildGraph } from '@friday/code-graph';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { GraphService } from './graph-service.js';

const ws = useTestWorkspace();

describe('GraphService', () => {
  it('does not return an in-flight graph after the checkout changes', async () => {
    const dir = ws().projectDir;
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'graph-service-root', private: true }));
    await writeFile(path.join(dir, 'src.ts'), 'export const value = 1;\n');
    const git = deterministicGit(dir);
    await git.init();
    await git.commitAll('initial');

    let calls = 0;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new GraphService({
      root: dir,
      cacheDir: path.join(ws().root, 'graph-cache'),
      build: (root, options) => {
        calls += 1;
        const result = buildGraph(root, options);
        if (calls === 1) {
          began();
          return result.then(async (graph) => {
            await gate;
            return graph;
          });
        }
        return result;
      },
    });
    ws().track(service);

    const first = service.graph();
    await started;
    await writeFile(path.join(dir, 'src.ts'), 'export const value = 2;\n');
    const current = service.graph();
    release();

    const graph = await current;
    await first;
    expect(calls).toBe(2);
    expect(graph.identity.dirty).toBe(true);
    expect(graph.identity.paths).toEqual(['src.ts']);
  });
});

describe('GraphService and the Merkle tree (ADR-0037 §2)', () => {
  it('keeps the last graph when nothing on disk changed and git cannot vouch, and reads only what changed', async () => {
    const dir = ws().projectDir;
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'tree-root', private: true }));
    await writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(dir, 'b.ts'), "import { a } from './a.ts';\nexport const b = a + 1;\n");
    const git = deterministicGit(dir);
    await git.init();
    await git.commitAll('initial');
    const service = new GraphService({ root: dir, cacheDir: path.join(ws().root, 'graph-cache') });
    ws().track(service);
    const first = await service.graph();
    expect(first.treeHash).toMatch(/^[0-9a-f]{64}$/);
    // An approximate identity (git could not vouch) with nothing changed on disk: the same graph.
    const approx = { ...first.identity, basis: 'approximate' as const, version: 'x~1' };
    expect(await service.graph(dir, approx)).toBe(first);
    // One file changes: the tree names it, and only it is read.
    await writeFile(path.join(dir, 'b.ts'), "import { a } from './a.ts';\nexport const b = a + 2;\n");
    const second = await service.graph(dir, { ...approx, version: 'x~2' });
    expect(second).not.toBe(first);
    expect(second.treeHash).not.toBe(first.treeHash);
    expect(second.stats.unchanged).toBe(1);
    expect(second.stats.parsed).toBe(1);
    // The keyword index followed the graph.
    const hits = await service.search('b');
    expect(hits.map((h) => [h.kind, h.path, h.name])).toContainEqual(['symbol', 'b.ts', 'b']);
  });
});
