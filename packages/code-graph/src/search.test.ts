/**
 * Keyword retrieval over the graph (ADR-0037 §2; plan Phase 5B): BM25 over symbols and files,
 * identifiers split at case changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GitRoot } from '@friday/git';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { buildGraph } from './graph.js';
import { memorySearchIndex, openSearchIndex, tokenize } from './search.js';

const ws = useTestWorkspace();

describe('tokenize', () => {
  it('splits identifiers and paths at separators and case changes, keeping the whole', () => {
    expect(tokenize('checkoutService')).toEqual(['checkoutservice', 'checkout', 'service']);
    expect(tokenize('src/api-client.ts')).toEqual(['src', 'api', 'client', 'ts']);
    expect(tokenize('HTTPServer')).toEqual(['httpserver', 'http', 'server']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('SearchIndex', () => {
  it('finds symbols and files by their words, ranks the name above the path, and falls back to any word', async () => {
    const dir = path.join(ws().root, 'shop');
    const files: Record<string, string> = {
      'package.json': '{"name":"shop","private":true}\n',
      'src/checkout.service.ts':
        'export class CheckoutService { total() { return 1; } }\nexport function applyDiscount() {}\n',
      'src/cart.ts':
        "import { CheckoutService } from './checkout.service.ts';\nexport const cart = new CheckoutService();\n",
      'src/util/money.ts': 'export const formatMoney = (n: number) => String(n);\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    }
    const git = deterministicGit(dir);
    await git.init();
    await git.commitAll('init');
    const graph = await buildGraph(await GitRoot.open(dir));
    for (const index of [memorySearchIndex(), openSearchIndex(path.join(ws().root, 'search-cache'))]) {
      ws().track(index);
      index.replace(dir, graph);
      const checkout = index.search(dir, 'checkout');
      expect(checkout[0]).toMatchObject({ kind: 'symbol', path: 'src/checkout.service.ts', name: 'CheckoutService' });
      expect(checkout.map((h) => `${h.kind}:${h.name}`)).toEqual(
        expect.arrayContaining(['symbol:CheckoutService', 'file:checkout.service.ts', 'symbol:total']),
      );
      // Every word required first: "apply discount" finds the function (and the file that exports it, after it).
      const discount = index.search(dir, 'apply discount');
      expect(discount[0]?.name).toBe('applyDiscount');
      expect(discount.map((h) => h.name)).not.toContain('CheckoutService');
      // No hit with every word: any word will do, and the caller sees lower scores.
      const any = index.search(dir, 'money nothing-here');
      expect(any.map((h) => h.name)).toEqual(expect.arrayContaining(['formatMoney', 'money.ts']));
      // A file is found by what it exports, too.
      expect(index.search(dir, 'format', { kind: 'file' }).map((h) => h.path)).toEqual(['src/util/money.ts']);
      expect(index.search(dir, 'cart', { kind: 'symbol' }).map((h) => h.name)).toEqual(['cart']);
      expect(index.search(dir, '!!!')).toEqual([]);
      // Replaced, not accumulated.
      index.replace(dir, graph);
      expect(index.search(dir, 'checkout').filter((h) => h.name === 'CheckoutService')).toHaveLength(1);
      index.clear();
      expect(index.search(dir, 'checkout')).toEqual([]);
    }
  });
});
