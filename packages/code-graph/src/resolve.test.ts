/**
 * Resolution of what a project's own configuration declares (ADR-0020 §4, amended 2026-10-20):
 * package `exports` with subpaths, patterns and conditions, tsconfig `paths`, and the sources of
 * build outputs where a tsconfig declares `outDir` and `rootDir`. Nothing else is guessed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  matchPattern,
  type Resolution,
  Resolver,
  readExports,
  readTsconfigPaths,
  readWorkspacePackages,
  sourceOfOutput,
} from './resolve.js';

const ws = useTestWorkspace();

/** A root with these files, and a resolver over it as the graph builds one. */
async function rootOf(files: Record<string, string>): Promise<{ resolve: (from: string, spec: string) => Resolution }> {
  const dir = path.join(ws().root, 'root');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  const set = new Set(Object.keys(files));
  const resolver = new Resolver(set, await readWorkspacePackages(dir, set), await readTsconfigPaths(dir, set));
  return { resolve: (from, spec) => resolver.resolve(from, spec) };
}

const pkg = (json: Record<string, unknown>) => JSON.stringify(json);
const buildConfig = JSON.stringify({ compilerOptions: { rootDir: '.', outDir: 'dist' }, include: ['src/**/*.ts'] });

describe('package exports: root, subpaths, patterns and conditions', () => {
  it('resolves the root export under the first condition Friday reads, and a declared subpath', async () => {
    const { resolve } = await rootOf({
      'packages/sdk/package.json': pkg({
        name: '@demo/sdk',
        exports: {
          '.': { development: './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' },
          './sse': { development: './src/sse.ts', default: './dist/sse.js' },
        },
      }),
      'packages/sdk/src/index.ts': '',
      'packages/sdk/src/sse.ts': '',
      'apps/ui/src/a.ts': '',
    });
    expect(resolve('apps/ui/src/a.ts', '@demo/sdk')).toEqual({
      type: 'file',
      to: 'packages/sdk/src/index.ts',
      certainty: 'inferred',
      reason: 'workspace package @demo/sdk',
    });
    expect(resolve('apps/ui/src/a.ts', '@demo/sdk/sse')).toEqual({
      type: 'file',
      to: 'packages/sdk/src/sse.ts',
      certainty: 'inferred',
      reason: 'export ./sse of workspace package @demo/sdk',
    });
  });

  it('maps a build output to its source only where the package declares outDir and rootDir', async () => {
    const { resolve } = await rootOf({
      'db/package.json': pkg({
        name: '@demo/db',
        exports: {
          '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' },
          './schema': { types: './dist/src/schema.d.ts', default: './dist/src/schema.js' },
          './testing': { types: './dist/test/fixtures/index.d.ts', default: './dist/test/fixtures/index.js' },
          './gone': { types: './dist/src/gone.d.ts', default: './dist/src/gone.js' },
        },
      }),
      'db/tsconfig.build.json': buildConfig,
      'db/src/index.ts': '',
      'db/src/schema.ts': '',
      'db/test/fixtures/index.ts': '',
      'apps/api/src/a.ts': '',
    });
    const from = 'apps/api/src/a.ts';
    expect(resolve(from, '@demo/db')).toMatchObject({
      to: 'db/src/index.ts',
      certainty: 'inferred',
      reason: 'workspace package @demo/db (its build output, mapped to the source by db/tsconfig.build.json)',
    });
    expect(resolve(from, '@demo/db/schema')).toMatchObject({ to: 'db/src/schema.ts', certainty: 'inferred' });
    expect(resolve(from, '@demo/db/testing')).toMatchObject({ to: 'db/test/fixtures/index.ts', certainty: 'inferred' });
    // Declared, mapped, and still not there: said so, with the mapping.
    expect(resolve(from, '@demo/db/gone')).toEqual({
      type: 'unsupported',
      reason:
        "the target of export ./gone of @demo/db (./dist/src/gone.d.ts) maps to db/src/gone by db/tsconfig.build.json, not among the root's files",
    });
  });

  it('keeps a build output unsupported when no tsconfig declares where it comes from', async () => {
    const { resolve } = await rootOf({
      'packages/a/package.json': pkg({ name: 'a', exports: { '.': './dist/index.js' } }),
      'packages/a/src/index.ts': '',
      'packages/b/package.json': pkg({ name: 'b', main: './dist/index.js' }),
      'packages/b/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist' } }),
      'packages/b/src/index.ts': '',
      'packages/c/package.json': pkg({ name: 'c', exports: { '.': './dist/index.js' } }),
      'packages/c/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'packages/c/src/index.ts': '',
      'x.ts': '',
    });
    expect(resolve('x.ts', 'a')).toEqual({
      type: 'unsupported',
      reason:
        "the entry of a (./dist/index.js) is not among the root's files (a build output?); packages/a/tsconfig.json is not among the root's files, so build outputs are not mapped to sources",
    });
    expect(resolve('x.ts', 'b')).toEqual({
      type: 'unsupported',
      reason:
        "the entry of b (./dist/index.js) is not among the root's files (a build output?); packages/b/tsconfig.json declares outDir but no rootDir, so its outputs are not mapped to sources",
    });
    expect(resolve('x.ts', 'c')).toEqual({
      type: 'unsupported',
      reason:
        "the entry of c (./dist/index.js) is not among the root's files (a build output?); packages/c/tsconfig.json declares no outDir, so build outputs are not mapped to sources",
    });
  });

  it('expands a pattern export, the longest prefix first, and reports a pattern whose target is missing', async () => {
    const { resolve } = await rootOf({
      'apps/api/package.json': pkg({
        name: '@demo/api',
        exports: {
          './modules/*': { types: './dist/src/modules/*/index.d.ts', default: './dist/src/modules/*/index.js' },
          './modules/shared/*': { default: './dist/src/shared/*.js' },
          './shared/*': { types: './dist/src/shared/*.d.ts', default: './dist/src/shared/*.js' },
        },
      }),
      'apps/api/tsconfig.build.json': buildConfig,
      'apps/api/src/modules/uploads/index.ts': '',
      'apps/api/src/modules/orders/orders.service.ts': '',
      'apps/api/src/shared/logger.ts': '',
      'apps/worker/src/w.ts': '',
    });
    const from = 'apps/worker/src/w.ts';
    expect(resolve(from, '@demo/api/modules/uploads')).toMatchObject({
      to: 'apps/api/src/modules/uploads/index.ts',
      certainty: 'inferred',
      reason: expect.stringContaining('export ./modules/uploads of workspace package @demo/api'),
    });
    expect(resolve(from, '@demo/api/shared/logger')).toMatchObject({ to: 'apps/api/src/shared/logger.ts' });
    expect(resolve(from, '@demo/api/modules/shared/logger')).toMatchObject({ to: 'apps/api/src/shared/logger.ts' });
    // `./modules/*` takes the rest of the path as one star: a file inside a module is not an index.
    expect(resolve(from, '@demo/api/modules/orders/orders.service.js')).toEqual({
      type: 'unsupported',
      reason:
        "the target of export ./modules/orders/orders.service.js of @demo/api (./dist/src/modules/orders/orders.service.js/index.d.ts) maps to apps/api/src/modules/orders/orders.service.js/index by apps/api/tsconfig.build.json, not among the root's files",
    });
    expect(resolve(from, '@demo/api')).toEqual({
      type: 'unsupported',
      reason: 'subpath . is not exported by workspace package @demo/api',
    });
  });

  it('reports a subpath the map does not export, a blocked key, and a key with no readable condition', async () => {
    const { resolve } = await rootOf({
      'packages/lib/package.json': pkg({
        name: '@demo/lib',
        exports: {
          '.': './src/index.ts',
          './internal': null,
          './browser-only': { browser: './src/browser.ts' },
        },
      }),
      'packages/lib/src/index.ts': '',
      'packages/lib/src/browser.ts': '',
      'packages/lib/src/secret.ts': '',
      'x.ts': '',
    });
    expect(resolve('x.ts', '@demo/lib/secret')).toEqual({
      type: 'unsupported',
      reason: 'subpath ./secret is not exported by workspace package @demo/lib',
    });
    for (const sub of ['internal', 'browser-only']) {
      expect(resolve('x.ts', `@demo/lib/${sub}`)).toEqual({
        type: 'unsupported',
        reason: `export ./${sub} of workspace package @demo/lib has no target under the conditions Friday reads (development, import, types, default, require, node)`,
      });
    }
  });

  it('reaches any file of a package without an exports map, by its path', async () => {
    const { resolve } = await rootOf({
      'packages/old/package.json': pkg({ name: 'old-pkg', main: './src/index.js' }),
      'packages/old/src/index.js': '',
      'packages/old/lib/util.ts': '',
      'x.ts': '',
    });
    expect(resolve('x.ts', 'old-pkg')).toMatchObject({ to: 'packages/old/src/index.js', certainty: 'inferred' });
    expect(resolve('x.ts', 'old-pkg/lib/util')).toEqual({
      type: 'file',
      to: 'packages/old/lib/util.ts',
      certainty: 'inferred',
      reason: 'file of workspace package old-pkg (no exports map)',
    });
    expect(resolve('x.ts', 'old-pkg/lib/none')).toEqual({
      type: 'unsupported',
      reason: 'packages/old/lib/none not found in workspace package old-pkg',
    });
  });

  it('reads exports sugar (a string, an array, a conditions object) as the root export only', async () => {
    expect(readExports('./a.js')).toEqual([{ subpath: '.', target: './a.js' }]);
    expect(readExports(['./a.js', './b.js'])).toEqual([{ subpath: '.', target: './a.js' }]);
    expect(readExports({ import: './a.mjs', require: './a.cjs' })).toEqual([{ subpath: '.', target: './a.mjs' }]);
    expect(readExports(undefined)).toBeNull();
    const { resolve } = await rootOf({
      'packages/s/package.json': pkg({ name: 's', exports: './src/a.ts' }),
      'packages/s/src/a.ts': '',
      'packages/s/src/b.ts': '',
      'packages/out/package.json': pkg({ name: 'out', exports: { '.': '../elsewhere/index.ts' } }),
      'x.ts': '',
    });
    expect(resolve('x.ts', 's')).toMatchObject({ to: 'packages/s/src/a.ts' });
    expect(resolve('x.ts', 's/src/b')).toMatchObject({
      type: 'unsupported',
      reason: expect.stringContaining('not exported'),
    });
    expect(resolve('x.ts', 'out')).toMatchObject({
      type: 'unsupported',
      reason: expect.stringContaining('points outside the package'),
    });
  });
});

describe('tsconfig paths: exact keys, patterns, baseUrl, extends, the nearest config', () => {
  it('resolves an exact key and a pattern, trying the targets in order', async () => {
    const { resolve } = await rootOf({
      'tsconfig.json':
        '{\n  "compilerOptions": { "paths": { "@/*": ["src/*", "generated/*"], "config": ["src/config/index.ts"] } },\n}\n',
      'src/config/index.ts': '',
      'src/util/a.ts': '',
      'generated/types.ts': '',
      'src/app.ts': '',
    });
    expect(resolve('src/app.ts', 'config')).toEqual({
      type: 'file',
      to: 'src/config/index.ts',
      certainty: 'inferred',
      reason: 'tsconfig path config (tsconfig.json)',
    });
    expect(resolve('src/app.ts', '@/util/a')).toMatchObject({
      to: 'src/util/a.ts',
      reason: 'tsconfig path @/* (tsconfig.json)',
    });
    expect(resolve('src/app.ts', '@/types')).toMatchObject({ to: 'generated/types.ts' });
    expect(resolve('src/app.ts', '@/nothing')).toEqual({
      type: 'unsupported',
      reason:
        "tsconfig path @/* of tsconfig.json maps @/nothing to src/nothing or generated/nothing, not among the root's files",
    });
    // Not an alias: an ordinary package.
    expect(resolve('src/app.ts', 'react')).toEqual({ type: 'external', module: 'react' });
  });

  it('joins targets to baseUrl, inherits paths through a relative extends, and lets the nearest tsconfig govern', async () => {
    const { resolve } = await rootOf({
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '~/*': ['libs/*/src/index.ts'] } },
      }),
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base', compilerOptions: { strict: true } }),
      'libs/core/src/index.ts': '',
      'apps/web/tsconfig.json': JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { baseUrl: 'src', paths: { '@/*': ['./*'] } },
      }),
      'apps/web/src/components/button.tsx': '',
      'apps/web/src/main.ts': '',
      'apps/other/src/main.ts': '',
    });
    expect(resolve('apps/other/src/main.ts', '~/core')).toMatchObject({
      to: 'libs/core/src/index.ts',
      reason: 'tsconfig path ~/* (tsconfig.json)',
    });
    expect(resolve('apps/web/src/main.ts', '@/components/button')).toMatchObject({
      to: 'apps/web/src/components/button.tsx',
      reason: 'tsconfig path @/* (apps/web/tsconfig.json)',
    });
    // apps/web's own config declares paths, so the root's `~/*` does not reach it.
    expect(resolve('apps/web/src/main.ts', '~/core')).toEqual({ type: 'external', module: '~' });
    expect(resolve('apps/other/src/main.ts', '@/components/button')).toMatchObject({ type: 'external' });
  });

  it('prefers a tsconfig path over a workspace package of the same name, as TypeScript does', async () => {
    const { resolve } = await rootOf({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@demo/*': ['packages/*/src/index.ts'] } } }),
      'packages/lib/package.json': pkg({ name: '@demo/lib', exports: { '.': './dist/index.js' } }),
      'packages/lib/src/index.ts': '',
      'x.ts': '',
    });
    expect(resolve('x.ts', '@demo/lib')).toMatchObject({
      to: 'packages/lib/src/index.ts',
      reason: 'tsconfig path @demo/* (tsconfig.json)',
    });
  });
});

describe('the rules behind it', () => {
  it('matches an exact key first, then the pattern with the longest prefix', () => {
    const keys = ['.', './a', './modules/*', './modules/shared/*', './*.json'];
    expect(matchPattern(keys, './a')).toEqual({ pattern: './a', star: '' });
    expect(matchPattern(keys, './modules/x')).toEqual({ pattern: './modules/*', star: 'x' });
    expect(matchPattern(keys, './modules/shared/x')).toEqual({ pattern: './modules/shared/*', star: 'x' });
    expect(matchPattern(keys, './data.json')).toEqual({ pattern: './*.json', star: 'data' });
    expect(matchPattern(keys, './modules/')).toBeNull();
    expect(matchPattern(['./a/*/b/*'], './a/x/b/y')).toBeNull();
  });

  it('maps an output under outDir to its source under rootDir, declaration files included', () => {
    const build = { config: 'db/tsconfig.build.json', rootDir: 'db', outDir: 'db/dist' };
    expect(sourceOfOutput(build, 'db/dist/src/schema.d.ts')).toBe('db/src/schema');
    expect(sourceOfOutput(build, 'db/dist/src/schema.js')).toBe('db/src/schema.js');
    expect(sourceOfOutput(build, 'db/dist/src/x.d.mts')).toBe('db/src/x.mts');
    expect(sourceOfOutput(build, 'db/src/schema.ts')).toBeNull();
    expect(sourceOfOutput(null, 'db/dist/src/schema.js')).toBeNull();
    expect(sourceOfOutput({ config: 't', rootDir: 'src', outDir: '.' }, 'index.js')).toBe('src/index.js');
  });
});
