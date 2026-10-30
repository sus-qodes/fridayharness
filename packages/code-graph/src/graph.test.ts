/**
 * The file-level code graph (plan M4b, ADR-0020).
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    expectEdge('@demo/lib/sub', {
      certainty: 'unsupported',
      reason: 'subpath ./sub is not exported by workspace package @demo/lib',
    });
    expectEdge('@/alias/thing', {
      certainty: 'unsupported',
      reason: "tsconfig path @/* of tsconfig.json maps @/alias/thing to src/alias/thing, not among the root's files",
    });
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

describe('a workspace whose packages export their build outputs (plan M14.9)', () => {
  it('links the apps to the sources behind dist, finds the contracts, and names the one import nothing declares', async () => {
    const build = JSON.stringify({ compilerOptions: { rootDir: '.', outDir: 'dist' }, include: ['src/**/*.ts'] });
    const { dir } = await repoFrom(
      {
        'package.json': JSON.stringify({
          name: 'restaurant',
          private: true,
          workspaces: ['packages/*', 'db', 'apps/*'],
        }),
        'tsconfig.json': JSON.stringify({ files: [], references: [{ path: 'apps/api/tsconfig.build.json' }] }),
        'db/package.json': JSON.stringify({
          name: '@shop/db',
          exports: {
            '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' },
            './schema': { types: './dist/src/schema.d.ts', default: './dist/src/schema.js' },
            './testing': { types: './dist/test/fixtures/index.d.ts', default: './dist/test/fixtures/index.js' },
          },
        }),
        'db/tsconfig.build.json': build,
        'db/src/index.ts': "export * from './schema.js';\n",
        'db/src/schema.ts': 'export const orders = {};\n',
        'db/test/fixtures/index.ts': "import { orders } from '../../src/schema.js';\nexport const fixture = orders;\n",
        'packages/shared/package.json': JSON.stringify({
          name: '@shop/shared',
          exports: { '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' } },
        }),
        'packages/shared/tsconfig.build.json': build,
        'packages/shared/src/index.ts': 'export type Money = number;\n',
        'apps/api/package.json': JSON.stringify({
          name: '@shop/api',
          exports: {
            './modules/*': { types: './dist/src/modules/*/index.d.ts', default: './dist/src/modules/*/index.js' },
            './shared/*': { types: './dist/src/shared/*.d.ts', default: './dist/src/shared/*.js' },
          },
        }),
        'apps/api/tsconfig.build.json': build,
        'apps/api/src/shared/logger.ts': 'export const log = console.log;\n',
        'apps/api/src/modules/orders/index.ts': [
          "import { orders } from '@shop/db/schema';",
          "import type { Money } from '@shop/shared';",
          "import { log } from '../../shared/logger.js';",
          'export const service = { orders, log, total: 0 as Money };',
          '',
        ].join('\n'),
        'apps/api/test/orders.test.ts': "import { fixture } from '@shop/db/testing';\nvoid fixture;\n",
        'apps/worker/package.json': JSON.stringify({ name: '@shop/worker', private: true }),
        'apps/worker/tsconfig.build.json': build,
        'apps/worker/src/main.ts': [
          "import { service } from '@shop/api/modules/orders';",
          "import { log } from '@shop/api/shared/logger';",
          "import { db } from '@shop/db';",
          "import { nothing } from '@shop/db/nothing';",
          'void [service, log, db, nothing];',
          '',
        ].join('\n'),
      },
      'restaurant',
    );
    const graph = await buildGraph(await GitRoot.open(dir));
    const to = (from: string, spec: string) => edge(graph, from, spec)?.to;
    expect(to('apps/api/src/modules/orders/index.ts', '@shop/db/schema')).toBe('db/src/schema.ts');
    expect(to('apps/api/src/modules/orders/index.ts', '@shop/shared')).toBe('packages/shared/src/index.ts');
    expect(to('apps/api/test/orders.test.ts', '@shop/db/testing')).toBe('db/test/fixtures/index.ts');
    expect(to('apps/worker/src/main.ts', '@shop/api/modules/orders')).toBe('apps/api/src/modules/orders/index.ts');
    expect(to('apps/worker/src/main.ts', '@shop/api/shared/logger')).toBe('apps/api/src/shared/logger.ts');
    expect(to('apps/worker/src/main.ts', '@shop/db')).toBe('db/src/index.ts');
    expect(graph.unsupported().map((e) => [e.specifier, e.reason])).toEqual([
      ['@shop/db/nothing', 'subpath ./nothing is not exported by workspace package @shop/db'],
    ]);
    expect(graph.contracts().map((n) => [n.path, n.contract?.areas])).toEqual([
      ['apps/api/src/modules/orders/index.ts', ['apps/worker']],
      ['apps/api/src/shared/logger.ts', ['apps/worker']],
      ['db/src/index.ts', ['apps/worker']],
      ['db/src/schema.ts', ['apps/api']],
      ['packages/shared/src/index.ts', ['apps/api']],
    ]);
    expect(graph.stats.edges).toEqual({ exact: 3, inferred: 6, unsupported: 1 });
    // A worker change reaches nothing; a schema change reaches the api module and, through it, the worker.
    expect(
      graph
        .consumers('db/src/schema.ts')
        .map((e) => e.from)
        .sort(),
    ).toEqual(['apps/api/src/modules/orders/index.ts', 'db/src/index.ts', 'db/test/fixtures/index.ts']);
    expect(graph.testsOf('db/src/schema.ts')).toEqual(['db/test/fixtures/index.ts']);
  });
});

describe('an incremental build is the full build (plan M14.10)', () => {
  /** Everything a graph answers, in a comparable form. */
  const picture = (g: CodeGraph) => ({
    version: g.version,
    nodes: [...g.nodes.entries()].sort(([a], [b]) => a.localeCompare(b)),
    edges: [...g.edges].sort(
      (a, b) =>
        a.from.localeCompare(b.from) || a.line - b.line || String(a.specifier).localeCompare(String(b.specifier)),
    ),
    skipped: [...g.skipped].sort((a, b) => a.path.localeCompare(b.path)),
    contracts: g.contracts().map((n) => [n.path, n.contract?.areas]),
    counts: { edges: g.stats.edges, contracts: g.stats.contracts, files: g.stats.files },
  });
  /** A full build and an incremental one from `previous`, equal to the last edge; returns the incremental one. */
  async function same(root: GitRoot, previous: CodeGraph, expectUnchanged?: number): Promise<CodeGraph> {
    const full = await buildGraph(root);
    const inc = await buildGraph(root, { previous });
    expect(picture(inc)).toEqual(picture(full));
    expect(full.stats.unchanged).toBe(0);
    if (expectUnchanged !== undefined) expect(inc.stats.unchanged).toBe(expectUnchanged);
    return inc;
  }

  it('keeps unchanged files unread across edits, additions, deletions, reverts, commits, renames and config changes', async () => {
    const { dir, g } = await repoFrom({
      'package.json': JSON.stringify({ name: 'inc-root', private: true }),
      'packages/lib/package.json': JSON.stringify({ name: '@inc/lib', exports: { '.': './src/index.ts' } }),
      'packages/lib/src/index.ts': 'export const lib = 1;\n',
      'packages/lib/src/other.ts': 'export const other = 2;\n',
      'src/a.ts': "import { b } from './b';\nimport { lib } from '@inc/lib';\nimport { m } from './missing';\n",
      'src/b.ts': 'export const b = 1;\n',
      'src/c.ts': "import './a';\n",
      'src/d.ts': 'export const d = 1;\n',
      'test/a.test.ts': "import '../src/a';\n",
    });
    const root = await GitRoot.open(dir);
    let g0 = await buildGraph(root);
    expect(g0.stats.unchanged).toBe(0);
    expect(edge(g0, 'src/a.ts', './missing')?.certainty).toBe('unsupported');

    // Nothing changed: everything is kept.
    g0 = await same(root, g0, 7);

    // An edit of one file: that file alone is read.
    writeFileSync(path.join(dir, 'src/b.ts'), "import { d } from './d';\nexport const b = d;\n");
    const g1 = await same(root, g0, 6);
    expect(g1.dependencies('src/b.ts').map((e) => e.to)).toEqual(['src/d.ts']);

    // A new file that an unchanged file was already importing: the edge of the unchanged file changes.
    writeFileSync(path.join(dir, 'src/missing.ts'), 'export const m = 1;\n');
    const g2 = await same(root, g1, 6);
    expect(edge(g2, 'src/a.ts', './missing')).toMatchObject({ to: 'src/missing.ts', certainty: 'exact' });

    // The edit reverted to HEAD's content: the file is read again, and its old edge is back.
    writeFileSync(path.join(dir, 'src/b.ts'), 'export const b = 1;\n');
    const g3 = await same(root, g2, 6);
    expect(g3.dependencies('src/b.ts')).toEqual([]);

    // A commit of everything: HEAD moves, the tree is clean, and only what the commits differ in is
    // read (the new file; b.ts was reverted, so the commit does not touch it).
    await g.commitAll('b, missing');
    const g4 = await same(root, g3, 7);
    expect(g4.identity.dirty).toBe(false);

    // A deleted file: its consumers' edges become unsupported; the consumers were not read.
    rmSync(path.join(dir, 'src/d.ts'));
    const g5 = await same(root, g4, 7);
    expect(g5.nodes.has('src/d.ts')).toBe(false);

    // A committed rename.
    await g.run(['mv', 'src/c.ts', 'src/renamed.ts']);
    await g.commitAll('rename');
    const g6 = await same(root, g5, 6);
    expect(g6.nodes.has('src/renamed.ts')).toBe(true);
    expect(g6.nodes.has('src/c.ts')).toBe(false);

    // A package's exports change: an unchanged importer's edge follows the new map.
    writeFileSync(
      path.join(dir, 'packages/lib/package.json'),
      JSON.stringify({ name: '@inc/lib', exports: { '.': './src/other.ts' } }),
    );
    const g7 = await same(root, g6, 7);
    expect(edge(g7, 'src/a.ts', '@inc/lib')?.to).toBe('packages/lib/src/other.ts');

    // A tsconfig with paths appears: the same.
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@inc/lib': ['src/d.ts'] } } }),
    );
    writeFileSync(path.join(dir, 'src/d.ts'), 'export const lib = 3;\n');
    const g8 = await same(root, g7, 7);
    expect(edge(g8, 'src/a.ts', '@inc/lib')?.to).toBe('src/d.ts');

    // A file grown past the size limit is skipped either way.
    writeFileSync(path.join(dir, 'src/big.ts'), `export const big = "${'x'.repeat(2000)}";\n`);
    const full = await buildGraph(root, { maxFileBytes: 1000 });
    const inc = await buildGraph(root, { previous: g8, maxFileBytes: 1000 });
    expect(picture(inc)).toEqual(picture(full));
    expect(inc.skipped.map((x) => x.path)).toEqual(['src/big.ts']);
  }, 120_000);

  it('reads everything again when the previous graph cannot vouch for the files', async () => {
    const { dir, g } = await repoFrom({ 'a.ts': "import './b';\n", 'b.ts': 'export {};\n' });
    const root = await GitRoot.open(dir);
    const first = await buildGraph(root);
    // Another root (a worktree of the same repository): its own files, read in full.
    const wt = path.join(ws().root, 'inc-wt');
    await g.run(['worktree', 'add', '-q', '-b', 'inc-feature', wt]);
    const other = await GitRoot.open(wt);
    expect((await buildGraph(other, { previous: first })).stats.unchanged).toBe(0);
    // An approximate identity (too many changed files to hash) proves nothing about content.
    writeFileSync(path.join(dir, 'a.ts'), "import './b';\n// edited\n");
    const limited = await GitRoot.open(dir, { maxHashedFiles: 0 });
    const approximate = await buildGraph(limited, { previous: first });
    expect(approximate.identity.basis).toBe('approximate');
    expect(approximate.stats.unchanged).toBe(0);
    // And a graph built from an approximate identity is not a starting point either.
    expect((await buildGraph(root, { previous: approximate })).stats.unchanged).toBe(0);
    // A caller that read the identity passes it; the graph carries it.
    const identity = await root.identity();
    const given = await buildGraph(root, { identity, previous: first });
    expect(given.identity).toBe(identity);
    expect(given.stats.unchanged).toBe(1);
  });

  it('does not reuse facts when the file-size limit changes', async () => {
    const { dir } = await repoFrom({
      'package.json': JSON.stringify({ name: 'limit-root', private: true }),
      'big.ts': `export const big = "${'x'.repeat(2000)}";\n`,
    });
    const root = await GitRoot.open(dir);
    const previous = await buildGraph(root);
    const full = await buildGraph(root, { maxFileBytes: 1000 });
    const incremental = await buildGraph(root, { previous, maxFileBytes: 1000 });

    expect(picture(incremental)).toEqual(picture(full));
    expect(incremental.stats.unchanged).toBe(0);
    expect(incremental.skipped).toEqual([{ path: 'big.ts', reason: 'larger than 1000 bytes' }]);
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
  }, 180_000);
});
