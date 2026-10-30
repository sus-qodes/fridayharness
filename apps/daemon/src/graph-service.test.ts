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
