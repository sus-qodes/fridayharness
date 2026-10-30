/**
 * Symbolic patching (ADR-0039): the boundary from a fresh parse, one declaration of the same name
 * and kind, the file still parsing afterwards; everything else refused with its reason.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGES, withTree } from './languages.js';
import { checkRanges, collectDeclarations, locateDeclaration, planPatch } from './patch.js';
import { extractFacts } from './symbols.js';

const ts = LANGUAGES[0] as (typeof LANGUAGES)[number];

const SRC = [
  "import { x } from './x.ts';",
  '',
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'export const twice = (n: number): number => n * 2;',
  'const a = 1, b = 2;',
  '',
  'export default class Cart {',
  '  items: string[] = [];',
  '  total(): number {',
  '    return this.items.length;',
  '  }',
  '  clear() {}',
  '}',
  '',
  'interface Shape { area(): number; sides: number }',
  'namespace Util { export function helper() { return 1; } }',
  'function total() { return 0; }',
  '',
].join('\n');

const decls = () => withTree(ts, SRC, collectDeclarations);

describe('collectDeclarations', () => {
  it('finds every patchable declaration with its exact range, members under their parent', async () => {
    const all = await decls();
    const names = all.map((d) => `${d.parent ? `${d.parent}.` : ''}${d.name}:${d.kind}:${d.exported}`);
    expect(names).toEqual([
      'add:function:export',
      'twice:variable:export',
      'a:variable:none',
      'b:variable:none',
      'Cart:class:export default',
      'Cart.items:field:none',
      'Cart.total:method:none',
      'Cart.clear:method:none',
      'Shape:interface:none',
      'Shape.area:method:none',
      'Shape.sides:field:none',
      'Util:namespace:none',
      'Util.helper:function:export',
      'total:function:none',
    ]);
    const add = all[0];
    expect(SRC.slice(add?.start, add?.end)).toBe('function add(a: number, b: number): number {\n  return a + b;\n}');
    expect(add).toMatchObject({ line: 3, end_line: 5 });
    const twice = all[1];
    expect(SRC.slice(twice?.start, twice?.end)).toBe('const twice = (n: number): number => n * 2;');
    expect(twice?.function_value).toBe(true);
    expect(all[2]?.declarators).toBe(2);
    expect(all.find((d) => d.name === 'sides')?.parent_kind).toBe('interface');
  });

  it('locates one declaration, and says why when it cannot', async () => {
    const all = await decls();
    expect(locateDeclaration(all, { symbol: 'add' })).toMatchObject({ ok: true, found: { name: 'add', line: 3 } });
    expect(locateDeclaration(all, { symbol: 'Cart.total' })).toMatchObject({ ok: true, found: { kind: 'method' } });
    // `total` alone: the function and the method share the name.
    expect(locateDeclaration(all, { symbol: 'total' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('declared 2 times'),
    });
    expect(locateDeclaration(all, { symbol: 'total', line: 20 })).toMatchObject({ ok: true, found: { parent: null } });
    expect(locateDeclaration(all, { symbol: 'twice', kind: 'function' })).toMatchObject({ ok: true });
    expect(locateDeclaration(all, { symbol: 'add', kind: 'class' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('is not a class'),
    });
    expect(locateDeclaration(all, { symbol: 'add', line: 9 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('does not start at line 9'),
    });
    expect(locateDeclaration(all, { symbol: 'nothing' })).toMatchObject({
      ok: false,
      reason: 'no declaration named nothing in the file',
    });
    expect(locateDeclaration(all, { symbol: 'a' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('statement with 2 variables'),
    });
  });
});

describe('planPatch', () => {
  it('replaces a declaration, keeps the export prefix, and previews the change', async () => {
    const r = await planPatch(
      ts,
      SRC,
      { symbol: 'add' },
      'export function add(a: number, b: number): number {\n  return b + a;\n}\n',
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.lines).toEqual({ from: 3, to: 5, new_to: 5 });
    expect(r.plan.new_source).toContain(
      'export function add(a: number, b: number): number {\n  return b + a;\n}\n\nexport const twice',
    );
    expect(r.plan.preview.split('\n')).toEqual([
      '@@ 3,5 -> 3,5 @@',
      '- function add(a: number, b: number): number {',
      '-   return a + b;',
      '- }',
      '+ function add(a: number, b: number): number {',
      '+   return b + a;',
      '+ }',
    ]);
    // A member, and a one-line arrow constant, and a function becoming an arrow constant.
    const m = await planPatch(ts, SRC, { symbol: 'Cart.total' }, 'total(): number {\n    return 42;\n  }');
    if (!m.ok) throw new Error(m.reason);
    expect(m.plan.new_source).toContain('  total(): number {\n    return 42;\n  }\n  clear() {}');
    const v = await planPatch(ts, SRC, { symbol: 'twice' }, 'const twice = (n: number): number => n + n;');
    if (!v.ok) throw new Error(v.reason);
    expect(v.plan.new_source).toContain('export const twice = (n: number): number => n + n;\nconst a = 1');
    const f = await planPatch(ts, SRC, { symbol: 'add' }, 'const add = (a: number, b: number): number => a + b;');
    expect(f.ok).toBe(true);
    const i = await planPatch(ts, SRC, { symbol: 'Shape.area' }, 'area(): number;');
    expect(i.ok).toBe(true);
  });

  it('keeps the file’s line endings', async () => {
    const crlf = SRC.replace(/\n/g, '\r\n');
    const r = await planPatch(
      ts,
      crlf,
      { symbol: 'add' },
      'function add(a: number, b: number): number {\n  return 1;\n}',
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.after).toBe('function add(a: number, b: number): number {\r\n  return 1;\r\n}');
    expect(r.plan.new_source.includes('\n') && !/[^\r]\n/.test(r.plan.new_source)).toBe(true);
  });

  it('refuses what it cannot do safely, with the reason', async () => {
    const reasons = await Promise.all([
      planPatch(ts, SRC, { symbol: 'add' }, 'function plus(a: number, b: number) { return a + b; }'),
      planPatch(ts, SRC, { symbol: 'add' }, 'function add(a: number { return a; }'),
      planPatch(ts, SRC, { symbol: 'add' }, 'function add() { return 1; }\nfunction other() {}'),
      planPatch(ts, SRC, { symbol: 'add' }, 'class add {}'),
      planPatch(ts, SRC, { symbol: 'total', line: 20 }, 'export function total() { return 1; }'),
      planPatch(ts, SRC, { symbol: 'Cart' }, 'export class Cart {}'),
      planPatch(ts, SRC, { symbol: 'add' }, '   \n'),
      planPatch(ts, SRC, { symbol: 'nothing' }, 'function nothing() {}'),
      planPatch(ts, `${SRC}\nfunction broken( {`, { symbol: 'add' }, 'function add() { return 1; }'),
      planPatch(ts, SRC, { symbol: 'Cart.total' }, 'total() { return 1; }\n}\nfunction leak() {'),
    ]);
    const words = reasons.map((r) => (r.ok ? 'ok' : r.reason));
    expect(words[0]).toContain('declares plus, not add');
    expect(words[1]).toContain('does not parse');
    expect(words[2]).toContain('exactly one declaration');
    expect(words[3]).toContain('declares a class; add is a function');
    expect(words[4]).toContain('is not exported; adding an export');
    expect(words[5]).toContain('is export default; changing that');
    expect(words[6]).toContain('is empty');
    expect(words[7]).toBe('no declaration named nothing in the file');
    expect(words[8]).toContain('does not parse as it is');
    expect(words[9]).toMatch(/exactly one declaration|does not parse|no longer parses/);
  });
});

describe('checkRanges (ADR-0039 §6)', () => {
  it('locates every recorded symbol of the sample again, exactly, except what no patch takes', async () => {
    const { symbols, all } = await withTree(ts, SRC, (root) => ({
      symbols: extractFacts(root).symbols,
      all: collectDeclarations(root),
    }));
    const statuses = checkRanges(all, symbols);
    const by = (name: string) => statuses.find((s) => s.name === name)?.status;
    expect(by('add')).toBe('exact');
    expect(by('Cart')).toBe('exact');
    expect(by('total')).toBe('exact');
    expect(by('helper')).toBe('exact');
    expect(by('a')).toBe('unsupported');
    expect(statuses.filter((s) => s.status !== 'exact' && s.status !== 'unsupported')).toEqual([]);
  });
});
