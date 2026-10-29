import { describe, expect, it } from 'vitest';
import type { GraphQuery } from '../api/client.js';
import { globToRegExp, matchesAny, matchesGlob, normalizePath } from './glob.js';
import { classify, edgePath, isTestPath, layoutNeighbourhood, NODE_H, NODE_W, ROW_GAP } from './graph-layout.js';

describe('globs', () => {
  it.each([
    ['backend/**', 'backend/src/a.ts', true],
    ['backend/**', 'backend', false],
    ['backend/**', 'frontend/a.ts', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/x/a.ts', false],
    ['**/*.test.ts', 'a.test.ts', true],
    ['**/*.test.ts', 'x/y/a.test.ts', true],
    ['src/**/index.ts', 'src/index.ts', true],
    ['src/**/index.ts', 'src/a/b/index.ts', true],
    ['{api,web}/**', 'web/x.ts', true],
    ['{api,web}/**', 'cli/x.ts', false],
    ['file?.ts', 'file1.ts', true],
    ['file?.ts', 'file/.ts', false],
    ['shared', 'shared/api.ts', true],
    ['shared', 'shared', true],
    ['shared', 'sharedx/api.ts', false],
    ['a.(b)+c', 'a.(b)+c', true],
    ['', 'anything', false],
  ])('%s matches %s: %s', (glob, path, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected);
  });

  it('normalizes Windows paths and leading dots', () => {
    expect(normalizePath('.\\src\\a.ts')).toBe('src/a.ts');
    expect(matchesAny('src\\a.ts', ['lib/**', 'src/**'])).toBe(true);
    expect(globToRegExp('x/**')).toBe(globToRegExp('x/**'));
  });
});

describe('isTestPath', () => {
  it.each([
    ['src/a.test.ts', true],
    ['src/a.spec.jsx', true],
    ['tests/a.ts', true],
    ['pkg/__tests__/x.js', true],
    ['src/testing.ts', false],
    ['src/contest/a.ts', false],
  ])('%s → %s', (p, v) => expect(isTestPath(p)).toBe(v));
});

function query(overrides: Partial<GraphQuery> = {}): GraphQuery {
  return {
    version: 'v1',
    node: { path: 'shared/src/api.ts', area: 'shared', contract: { areas: ['backend', 'frontend'] } },
    dependencies: [
      { to: 'shared/src/types.ts', kind: 'import' },
      { to: 'shared/src/util.ts', kind: 'import' },
    ],
    consumers: [
      { from: 'backend/src/checkout.ts', kind: 'import' },
      { from: 'frontend/src/client.ts', kind: 'import' },
      { from: 'shared/test/api.test.ts', kind: 'import' },
    ],
    tests: ['shared/test/api.test.ts', 'tests/e2e/flow.test.ts'],
    neighbourhood: [
      { path: 'shared/src/types.ts', distance: 1 },
      { path: 'shared/src/util.ts', distance: 1 },
      { path: 'backend/src/checkout.ts', distance: 1 },
      { path: 'frontend/src/client.ts', distance: 1 },
      { path: 'shared/test/api.test.ts', distance: 1 },
      { path: 'backend/src/server.ts', distance: 2 },
      { path: 'frontend/src/page.ts', distance: 2 },
    ],
    ...overrides,
  };
}

describe('layoutNeighbourhood', () => {
  const opts = { scopes: ['backend/**'], contracts: new Set(['shared/src/api.ts']) };

  it('puts the file in the middle, importers left, imports right, two steps outside', () => {
    const l = layoutNeighbourhood(query(), opts);
    const by = new Map(l.nodes.map((n) => [n.path, n]));
    const center = by.get('shared/src/api.ts');
    expect(center?.role).toBe('center');
    expect(center?.layer).toBe(0);
    expect(by.get('shared/src/types.ts')).toMatchObject({ role: 'dependency', layer: 1 });
    expect(by.get('backend/src/checkout.ts')).toMatchObject({ role: 'consumer', layer: -1 });
    expect(by.get('shared/test/api.test.ts')).toMatchObject({ role: 'test', layer: -1 });
    expect(by.get('tests/e2e/flow.test.ts')).toMatchObject({ role: 'test', layer: -1 });
    expect(by.get('backend/src/server.ts')).toMatchObject({ role: 'far', layer: 2 });
    const xs = (layer: number) => new Set(l.nodes.filter((n) => n.layer === layer).map((n) => n.x));
    for (const layer of [-1, 0, 1, 2]) expect(xs(layer).size).toBe(1);
    expect([...xs(-1)][0]).toBeLessThan([...xs(0)][0] as number);
    expect([...xs(1)][0]).toBeGreaterThan([...xs(0)][0] as number);
    expect([...xs(2)][0]).toBeGreaterThan([...xs(1)][0] as number);
    expect(l.columns.map((c) => c.label)).toEqual(['Used by', 'This file', 'Imports', 'Two steps away']);
  });

  it('never overlaps nodes of a layer and fits them in the drawing', () => {
    const l = layoutNeighbourhood(query(), opts);
    for (const layer of [-1, 1, 2]) {
      const ys = l.nodes
        .filter((n) => n.layer === layer)
        .map((n) => n.y)
        .sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) expect((ys[i] as number) - (ys[i - 1] as number)).toBe(NODE_H + ROW_GAP);
    }
    for (const n of l.nodes) {
      expect(n.x + NODE_W).toBeLessThanOrEqual(l.width);
      expect(n.y + NODE_H).toBeLessThanOrEqual(l.height);
      expect(n.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('colours by write scope, contract and test', () => {
    const l = layoutNeighbourhood(query(), opts);
    const by = new Map(l.nodes.map((n) => [n.path, n]));
    expect(by.get('backend/src/checkout.ts')).toMatchObject({ tone: 'scope', inScope: true });
    expect(by.get('shared/src/api.ts')).toMatchObject({ tone: 'contract', contract: true });
    expect(by.get('shared/test/api.test.ts')).toMatchObject({ tone: 'test', test: true });
    expect(by.get('frontend/src/client.ts')).toMatchObject({ tone: 'plain', inScope: false });
    expect(classify('backend/src/a.test.ts', opts)).toMatchObject({ tone: 'test', inScope: true });
  });

  it('draws the edges it knows: imports out of the file, importers and tests into it', () => {
    const l = layoutNeighbourhood(query(), opts);
    expect(l.edges).toEqual(
      expect.arrayContaining([
        { from: 'shared/src/api.ts', to: 'shared/src/types.ts', kind: 'import' },
        { from: 'backend/src/checkout.ts', to: 'shared/src/api.ts', kind: 'import' },
        { from: 'tests/e2e/flow.test.ts', to: 'shared/src/api.ts', kind: 'test' },
      ]),
    );
    expect(l.edges.some((e) => e.from === 'backend/src/server.ts' || e.to === 'backend/src/server.ts')).toBe(false);
    for (const e of l.edges) {
      const from = l.nodes.find((n) => n.path === e.from);
      const to = l.nodes.find((n) => n.path === e.to);
      expect(from && to && edgePath(from, to)).toMatch(/^M[\d.]+ [\d.]+ C/);
    }
  });

  it('caps each layer and counts what it left out', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ to: `lib/m${i}.ts`, kind: 'import' }));
    const l = layoutNeighbourhood(query({ dependencies: many, neighbourhood: [] }), { ...opts, perLayer: 10 });
    expect(l.nodes.filter((n) => n.layer === 1)).toHaveLength(10);
    expect(l.hidden[1]).toBe(20);
    expect(l.columns.map((c) => c.label)).not.toContain('Two steps away');
  });

  it('lays out a file with no links', () => {
    const l = layoutNeighbourhood(
      query({ node: { path: 'a.ts' }, dependencies: [], consumers: [], tests: [], neighbourhood: [] }),
      opts,
    );
    expect(l.nodes).toHaveLength(1);
    expect(l.edges).toEqual([]);
  });
});
