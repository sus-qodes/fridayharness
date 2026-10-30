/**
 * The questions asked of the graph (ADR-0037 §3; plan Phase 5C): symbol lookup, blast radius and
 * skeleton reads, bounded and labelled.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GitRoot } from '@friday/git';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { buildGraph, type CodeGraph } from './graph.js';
import { blastRadius, lookupSymbol, skeletonOf } from './queries.js';

const ws = useTestWorkspace();

const FILES: Record<string, string> = {
  'package.json': '{"name":"shop","private":true}\n',
  'shared/package.json': '{"name":"@shop/shared","private":true,"exports":{".":"./src/api.ts"}}\n',
  'shared/src/api.ts': [
    '/** Money in minor units. */',
    'export interface Money {',
    '  amount: number;',
    '  currency: string;',
    '}',
    '',
    '/** Adds two amounts of the same currency. */',
    'export function add(a: Money, b: Money): Money {',
    '  if (a.currency !== b.currency) throw new Error("currency");',
    '  return { amount: a.amount + b.amount, currency: a.currency };',
    '}',
    '',
    'export const ZERO: Money = { amount: 0, currency: "EUR" };',
    '',
  ].join('\n'),
  'backend/package.json': '{"name":"@shop/backend","private":true}\n',
  'backend/src/checkout.ts': [
    "import { add, type Money, ZERO } from '@shop/shared';",
    '',
    'export class Checkout {',
    '  private items: Money[] = [];',
    '  push(m: Money) { this.items.push(m); }',
    '  total(): Money {',
    '    let sum = ZERO;',
    '    for (const m of this.items) sum = add(sum, m);',
    '    return sum;',
    '  }',
    '}',
    '',
    'export function checkout(items: Money[]): Money {',
    '  const c = new Checkout();',
    '  for (const m of items) c.push(m);',
    '  return c.total();',
    '}',
    '',
  ].join('\n'),
  'backend/test/checkout.test.ts': "import { checkout } from '../src/checkout.ts';\ncheckout([]);\n",
  'web/src/cart.ts': [
    "import { add, type Money } from '../../shared/src/api.ts';",
    'export function sum(a: Money, b: Money): Money {',
    '  return add(a, b);',
    '}',
    'export function render(c: { total(): unknown }) {',
    '  return c.total();',
    '}',
    '',
  ].join('\n'),
};

async function graphOf(name: string): Promise<{ graph: CodeGraph; dir: string }> {
  const dir = path.join(ws().root, name);
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  const git = deterministicGit(dir);
  await git.init();
  await git.commitAll('init');
  return { graph: await buildGraph(await GitRoot.open(dir)), dir };
}

describe('lookupSymbol', () => {
  it('answers with the symbol, its callers, callees, tests and name-only references, bounded', async () => {
    const { graph } = await graphOf('lookup');
    const r = lookupSymbol(graph, 'add');
    expect(r.matches).toHaveLength(1);
    const [m] = r.matches;
    expect(m?.symbol).toMatchObject({
      path: 'shared/src/api.ts',
      kind: 'function',
      exported: true,
      line: 8,
      end_line: 11,
    });
    expect(m?.symbol.signature).toBe('function add(a: Money, b: Money): Money');
    expect(m?.callers.map((e) => `${e.from.path}#${e.from.symbol} (${e.certainty})`)).toEqual([
      'backend/src/checkout.ts#Checkout.total (inferred)',
      'web/src/cart.ts#sum (exact)',
    ]);
    // `Error` is neither declared nor imported: a global, nobody's edge.
    expect(m?.callees.map((e) => [e.name, e.certainty])).toEqual([['Money', 'exact']]);
    expect(m?.tests).toEqual([]);
    // `c.total()` twice, on values whose type the graph does not know: name-only, labelled.
    expect(lookupSymbol(graph, 'total').name_references.map((e) => e.from.symbol)).toEqual(['checkout', 'render']);
    expect(lookupSymbol(graph, 'nothing').matches).toEqual([]);
    const cut = lookupSymbol(graph, 'add', { edges: 1 });
    expect(cut.matches[0]).toMatchObject({ callers_cut: 1 });
  });
});

describe('blastRadius', () => {
  it('reaches importers and callers upstream with confidence, names breaking changes, and keeps guesses out unless asked', async () => {
    const { graph } = await graphOf('blast');
    const r = blastRadius(graph, { symbols: [{ path: 'shared/src/api.ts', symbol: 'add' }] });
    expect(r.seeds).toEqual([
      {
        path: 'shared/src/api.ts',
        symbols: ['add'],
        breaking: ['add is exported and called from backend, web', 'shared contract of backend, web'],
      },
    ]);
    // Depth 2 from `add`: its callers; `Checkout.total` is called only by name (`c.total()`), so nothing resolved lies beyond it.
    expect(r.affected.map((a) => [a.path, a.symbol, a.via, a.distance, a.confidence])).toEqual([
      ['web/src/cart.ts', 'sum', 'reference', 1, 'high'],
      ['backend/src/checkout.ts', 'Checkout.total', 'reference', 1, 'medium'],
    ]);
    // A whole file as the seed: its importers, by the file edges.
    const file = blastRadius(graph, { paths: ['shared/src/api.ts'] }, { depth: 1 });
    expect(file.affected.map((a) => [a.path, a.via, a.confidence])).toEqual([
      ['web/src/cart.ts', 'import', 'high'],
      ['backend/src/checkout.ts', 'import', 'medium'],
    ]);
    // Name-only matches come in only when asked, as low confidence.
    const quiet = blastRadius(graph, { symbols: [{ path: 'backend/src/checkout.ts', symbol: 'Checkout.total' }] });
    expect(quiet.affected).toEqual([]);
    const loud = blastRadius(
      graph,
      { symbols: [{ path: 'backend/src/checkout.ts', symbol: 'Checkout.total' }] },
      { includeNameMatches: true },
    );
    expect(loud.affected.filter((a) => a.via === 'name').map((a) => [a.path, a.symbol, a.confidence])).toEqual([
      ['backend/src/checkout.ts', 'checkout', 'low'],
      ['web/src/cart.ts', 'render', 'low'],
    ]);
    expect(blastRadius(graph, { paths: ['shared/src/api.ts'] }, { limit: 1 })).toMatchObject({
      cut: expect.any(Number),
    });
  });
});

describe('skeletonOf', () => {
  it('folds bodies at L1 and keeps doc comments and exported types whole at L2, with line numbers', async () => {
    const { graph, dir } = await graphOf('skeleton');
    const l1 = await skeletonOf(graph, dir, 'shared/src/api.ts', 1);
    expect(l1).toMatchObject({ path: 'shared/src/api.ts', level: 1, lines: 13, cut: false });
    expect(l1?.text).toBe(
      [
        '    1: /** Money in minor units. */',
        '    2: export interface Money {',
        '      … (3 lines)',
        '    7: /** Adds two amounts of the same currency. */',
        '    8: export function add(a: Money, b: Money): Money {',
        '      … (3 lines)',
        '   13: export const ZERO: Money = { amount: 0, currency: "EUR" };',
      ].join('\n'),
    );
    expect(l1?.folded).toBe(6);
    const l2 = await skeletonOf(graph, dir, 'shared/src/api.ts', 2);
    expect(l2?.text).toContain('    3:   amount: number;');
    expect(l2?.text).toContain('    4:   currency: string;');
    expect(l2?.text).toContain('      … (3 lines)');
    expect(l2?.folded).toBe(3);
    const cls = await skeletonOf(graph, dir, 'backend/src/checkout.ts', 1);
    expect(cls?.text).toContain('    5:   push(m: Money) { this.items.push(m); }');
    expect(cls?.text).toContain('    6:   total(): Money {');
    // The method's body and the braces that close it and its class fold together.
    expect(cls?.text).toContain('      … (5 lines)');
    expect(await skeletonOf(graph, dir, 'README.md', 1)).toBeNull();
    const tiny = await skeletonOf(graph, dir, 'backend/src/checkout.ts', 1, { maxChars: 40 });
    expect(tiny).toMatchObject({ cut: true });
  });
});
