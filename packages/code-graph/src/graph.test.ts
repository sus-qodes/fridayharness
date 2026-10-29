/**
 * The file-level code graph (plan M4b, ADR-0020).
 */
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@friday/db';
import { GitRoot } from '@friday/git';
import { deterministicGit, FIXTURE_BASE_EPOCH, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { buildGraph, type CodeGraph, memoryFactsCache, openFactsCache, stripJsonComments } from './index.js';

const ws = useTestWorkspace();
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
}

async function repoFrom(files: Record<string, string>, name = 'proj') {
  const dir = path.join(ws().root, name);
  mkdirSync(dir, { recursive: true });
  write(dir, files);
  const g = deterministicGit(dir);
  await g.init();
  await g.commitAll('init');
  return { dir, g };
}

const edge = (graph: CodeGraph, from: string, specifier: string) =>
  graph.dependencies(from).find((e) => e.specifier === specifier);

describe('fixture-shop (M4b exit criterion)', () => {
  it('links the frontend client and the backend controller through the shared contract', async () => {
    const dir = path.join(ws().root, 'shop');
    cpSync(path.join(REPO, 'tests', 'fixtures', 'fixture-shop'), dir, { recursive: true });
    const g = deterministicGit(dir);
    await g.init();
    await g.commitAll('fixture');
    const graph = await buildGraph(await GitRoot.open(dir));

    expect(edge(graph, 'frontend/src/api-client.ts', '../../shared/src/api.ts')).toMatchObject({
      to: 'shared/src/api.ts',
      certainty: 'exact',
    });
    expect(edge(graph, 'backend/src/checkout.controller.ts', '../../shared/src/api.ts')).toMatchObject({
      to: 'shared/src/api.ts',
      kind: 'type-import',
      certainty: 'exact',
    });
    expect(graph.nodes.get('shared/src/api.ts')?.contract).toEqual({ areas: ['backend', 'frontend'] });
    expect(graph.contracts().map((n) => n.path)).toEqual(['shared/src/api.ts']);
    expect(graph.testsOf('shared/src/api.ts')).toEqual(['shared/test/api.test.ts']);
    expect(graph.testsOf('frontend/src/api-client.ts')).toEqual(['frontend/test/api-client.test.ts']);
    expect(graph.nodes.get('backend/test/checkout.service.test.ts')).toMatchObject({
      test: true,
      external: ['node:assert/strict', 'node:test'],
    });
    expect(graph.unsupported()).toEqual([]);
    // A backend change reaches the frontend consumer in two steps, and never the infra config.
    const around = graph.neighbourhood('backend/src/checkout.service.ts', 2);
    expect(around.get('shared/src/api.ts')).toBe(1);
    expect(around.get('frontend/src/api-client.ts')).toBe(2);
    expect([...around.keys()].some((p) => p.startsWith('infra/'))).toBe(false);
    expect(graph.version).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('certainty: reported, never guessed', () => {
  it('labels every construct exact, inferred or unsupported with its reason', async () => {
    const { dir } = await repoFrom({
      'package.json': JSON.stringify({ name: 'demo-root', private: true }),
      'tsconfig.json':
        '{\n  // aliases are not resolved by Friday\n  "compilerOptions": { "paths": { "@/*": ["src/*"], }, },\n}\n',
      'packages/lib/package.json': JSON.stringify({
        name: '@demo/lib',
        exports: { '.': { development: './src/index.ts', default: './dist/index.js' } },
      }),
      'packages/lib/src/index.ts': 'export const x = 1;\n',
      'packages/old/package.json': JSON.stringify({ name: 'old-pkg', main: './dist/index.js' }),
      'src/side.ts': 'console.log("side");\n',
      'src/util/index.ts': 'export const u = 1;\n',
      'src/types.ts': 'export type T = string;\n',
      'src/legacy.js': 'module.exports = 1;\n',
      'src/app.ts': [
        "import { x } from '@demo/lib';",
        "import { y } from '@demo/lib/sub';",
        "import z from '@/alias/thing';",
        "import './side.js';",
        "export * from './util';",
        'const name = "a";',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source text of the parsed file
        'const m = await import(`./mods/${name}`);',
        'const someVar = "b";',
        'const n = require(someVar);',
        "import fs from 'node:fs';",
        "import react from 'react';",
        "import missing from './missing';",
        "import old from 'old-pkg';",
        "import type { T } from './types.js';",
        "import legacy = require('./legacy');",
        "const lazy = () => import('./util/index.ts');",
        '',
      ].join('\n'),
    });
    const graph = await buildGraph(await GitRoot.open(dir));
    const app = 'src/app.ts';
    const expectEdge = (spec: string | null, fields: Record<string, unknown>) =>
      expect(
        graph.dependencies(app).find((e) => e.specifier === spec && (spec !== null || e.kind === fields.kind)),
        String(spec),
      ).toMatchObject(fields);
    expectEdge('@demo/lib', {
      to: 'packages/lib/src/index.ts',
      certainty: 'inferred',
      reason: 'workspace package @demo/lib',
    });
    expectEdge('@demo/lib/sub', { certainty: 'unsupported', reason: 'subpath of workspace package @demo/lib' });
    expectEdge('@/alias/thing', { certainty: 'unsupported', reason: 'tsconfig path alias' });
    expectEdge('./side.js', { to: 'src/side.ts', kind: 'side-effect', certainty: 'exact' });
    expectEdge('./util', { to: 'src/util/index.ts', kind: 're-export', certainty: 'exact' });
    expectEdge(null, { kind: 'dynamic-import', certainty: 'unsupported', reason: 'computed specifier', line: 7 });
    expectEdge(null, { kind: 'require', certainty: 'unsupported', reason: 'computed specifier', line: 9 });
    expectEdge('./missing', { certainty: 'unsupported', reason: 'src/missing not found' });
    expectEdge('old-pkg', { certainty: 'unsupported', reason: expect.stringContaining('not among the root') });
    expectEdge('./types.js', { to: 'src/types.ts', kind: 'type-import', certainty: 'exact' });
    expectEdge('./legacy', { to: 'src/legacy.js', kind: 'import-equals', certainty: 'exact' });
    expectEdge('./util/index.ts', { to: 'src/util/index.ts', kind: 'dynamic-import', certainty: 'exact' });
    expect(graph.nodes.get(app)?.external).toEqual(['node:fs', 'react']);
    expect(graph.stats.edges).toEqual({ exact: 5, inferred: 1, unsupported: 6 });
  });

  it('strips comments and trailing commas from tsconfig, not from strings', () => {
    expect(JSON.parse(stripJsonComments('{ "a": "// not a comment", /* c */ "b": [1,], }'))).toEqual({
      a: '// not a comment',
      b: [1],
    });
  });
});

describe('versions and the facts cache', () => {
  it('re-parses only what changed, and keeps no stale cache format', async () => {
    const { dir } = await repoFrom({
      'a.ts': "import { b } from './b';\n",
      'b.ts': 'export const b = 1;\n',
      'c.ts': "import './a';\n",
    });
    const cacheDir = path.join(ws().root, 'graph-cache');
    let cache = openFactsCache(cacheDir);
    const root = await GitRoot.open(dir);
    const first = await buildGraph(root, { cache });
    expect(first.stats).toMatchObject({ files: 3, parsed: 3, cached: 0 });
    const again = await buildGraph(root, { cache });
    expect(again.stats).toMatchObject({ parsed: 0, cached: 3 });
    expect(again.version).toBe(first.version);
    writeFileSync(path.join(dir, 'b.ts'), "import { c } from './c';\nexport const b = 1;\n");
    const edited = await buildGraph(root, { cache });
    expect(edited.stats).toMatchObject({ parsed: 1, cached: 2 });
    expect(edited.version).not.toBe(first.version);
    expect(edited.dependencies('b.ts').map((e) => e.to)).toEqual(['c.ts']);
    cache.close();
    // A cache written by another format version is discarded, not trusted.
    const db = openDatabase(path.join(cacheDir, 'facts.db'));
    db.pragma('user_version = 0');
    db.close();
    cache = openFactsCache(cacheDir);
    expect((await buildGraph(root, { cache })).stats.parsed).toBe(3);
    cache.close();
  });

  it('gives each execution root its own edges', async () => {
    const { dir, g } = await repoFrom({ 'a.ts': "import './b';\n", 'b.ts': 'export {};\n', 'c.ts': 'export {};\n' });
    const wt = path.join(ws().root, 'wt');
    await g.run(['worktree', 'add', '-q', '-b', 'feature', wt]);
    writeFileSync(path.join(wt, 'a.ts'), "import './c';\n");
    await deterministicGit(wt, { startEpoch: FIXTURE_BASE_EPOCH + 50 }).commitAll('switch to c');
    const cache = memoryFactsCache();
    const [main, feature] = await Promise.all([
      buildGraph(await GitRoot.open(dir), { cache }),
      buildGraph(await GitRoot.open(wt), { cache }),
    ]);
    expect(main.dependencies('a.ts').map((e) => e.to)).toEqual(['b.ts']);
    expect(feature.dependencies('a.ts').map((e) => e.to)).toEqual(['c.ts']);
    expect(main.version).not.toBe(feature.version);
  });
});

describe('a real repository: Friday itself', () => {
  it('builds, resolves workspace packages, and answers queries within budget', async () => {
    const graph = await buildGraph(await GitRoot.open(REPO));
    expect(graph.stats.files).toBeGreaterThan(200);
    expect(graph.stats.edges.exact).toBeGreaterThan(200);
    expect(graph.stats.edges.inferred).toBeGreaterThan(50);
    const protocol = 'packages/protocol/src/index.ts';
    expect(graph.nodes.get(protocol)?.contract?.areas.length).toBeGreaterThan(5);
    const started = performance.now();
    graph.consumers(protocol);
    graph.testsOf('packages/state/src/service.ts');
    graph.neighbourhood('packages/state/src/service.ts', 2);
    expect(performance.now() - started).toBeLessThan(100);
    console.log(
      `friday repo: ${graph.stats.files} files, ${JSON.stringify(graph.stats.edges)} edges, ${graph.stats.contracts} contracts, built in ${graph.stats.ms} ms`,
    );
    // The build grows with this repository and slows under the parallel suite; only queries are timed (LESSONS T-61).
  }, 60_000);
});
